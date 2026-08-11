import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const DEFAULT_STATE_PATH = "/data/antigravity-ha/telegram/authorizations.json";
const DEFAULT_LOCK_PATH = "/run/antigravity-ha/telegram-pairing.lock";
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_PENDING = 16;
const MAX_AUTHORIZATIONS = 128;
const REQUIRED_UID = typeof process.getuid === "function" ? process.getuid() : 0;

function canonicalTelegramId(value, { signed = true } = {}) {
  const text = String(value ?? "").trim();
  const pattern = signed ? /^-?[1-9]\d{0,19}$/ : /^[1-9]\d{0,19}$/;
  if (!pattern.test(text)) throw new Error("invalid Telegram numeric id");
  return text;
}

function assertSafeDirectory(path, { create = false } = {}) {
  if (!existsSync(path)) {
    if (!create) throw new Error(`required directory is missing: ${path}`);
    mkdirSync(path, { mode: 0o700 });
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== REQUIRED_UID) {
    throw new Error(`unsafe managed directory: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) throw new Error(`managed directory is not private: ${path}`);
}

function ensureManagedParents(statePath, lockPath) {
  const stateParent = dirname(statePath);
  const stateRoot = dirname(stateParent);
  assertSafeDirectory(stateRoot, { create: true });
  assertSafeDirectory(stateParent, { create: true });
  assertSafeDirectory(dirname(lockPath), { create: true });
}

function assertSafeStateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== REQUIRED_UID || stat.nlink !== 1) {
    throw new Error("Telegram authorization state is not a safe regular file");
  }
  if ((stat.mode & 0o177) !== 0) {
    throw new Error("Telegram authorization state must be root-only mode 0600");
  }
  if (stat.size > MAX_STATE_BYTES) throw new Error("Telegram authorization state is oversized");
}

function emptyState() {
  return { version: 2, pending: [], authorizations: [] };
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 2) {
    throw new Error("unsupported Telegram authorization state schema");
  }
  if (!Array.isArray(value.pending) || !Array.isArray(value.authorizations)) {
    throw new Error("invalid Telegram authorization state");
  }
  if (value.pending.length > MAX_PENDING || value.authorizations.length > MAX_AUTHORIZATIONS) {
    throw new Error("Telegram authorization state exceeds its bounded capacity");
  }
  const pending = value.pending.map((entry) => {
    if (!entry || typeof entry !== "object" ||
        !/^[a-f0-9]{64}$/.test(entry.digest) ||
        !Number.isSafeInteger(entry.expires_at) ||
        !Number.isSafeInteger(entry.created_at)) {
      throw new Error("invalid pending Telegram pairing record");
    }
    return { digest: entry.digest, expires_at: entry.expires_at, created_at: entry.created_at };
  });
  const seen = new Set();
  const authorizations = value.authorizations.map((entry) => {
    if (!entry || typeof entry !== "object" ||
        !/^[A-Za-z0-9_-]{20,64}$/.test(entry.authorization_id) ||
        !Number.isSafeInteger(entry.created_at)) {
      throw new Error("invalid Telegram authorization record");
    }
    const userId = canonicalTelegramId(entry.user_id, { signed: false });
    const chatId = canonicalTelegramId(entry.chat_id);
    const pair = `${userId}:${chatId}`;
    if (seen.has(pair)) throw new Error("duplicate Telegram authorization record");
    seen.add(pair);
    return {
      authorization_id: entry.authorization_id,
      user_id: userId,
      chat_id: chatId,
      created_at: entry.created_at,
    };
  });
  return { version: 2, pending, authorizations };
}

function loadState(statePath = DEFAULT_STATE_PATH) {
  if (!existsSync(statePath)) return emptyState();
  assertSafeStateFile(statePath);
  return validateState(JSON.parse(readFileSync(statePath, "utf8")));
}

function writeStateAtomic(state, statePath = DEFAULT_STATE_PATH) {
  const validated = validateState(state);
  const parent = dirname(statePath);
  const temporary = `${statePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let fd;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, statePath);
    chmodSync(statePath, 0o600);
    const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withStateLock(callback, {
  statePath = DEFAULT_STATE_PATH,
  lockPath = DEFAULT_LOCK_PATH,
  timeoutMs = 2_000,
} = {}) {
  ensureManagedParents(statePath, lockPath);
  const deadline = Date.now() + timeoutMs;
  let lockFd;
  while (lockFd === undefined) {
    try {
      lockFd = openSync(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(lockFd, `${process.pid}\n`, "utf8");
      fsyncSync(lockFd);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = lstatSync(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== REQUIRED_UID || stat.nlink !== 1 ||
          (stat.mode & 0o177) !== 0) {
        throw new Error("unsafe Telegram pairing lock file");
      }
      let ownerAlive = true;
      const ownerPid = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
      if (Number.isSafeInteger(ownerPid) && ownerPid > 1) {
        try {
          process.kill(ownerPid, 0);
        } catch (probeError) {
          ownerAlive = probeError?.code !== "ESRCH";
        }
      }
      if (!ownerAlive) {
        unlinkSync(lockPath);
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Telegram pairing state is busy");
      sleepSync(25);
    }
  }
  try {
    return callback(loadState(statePath), (next) => writeStateAtomic(next, statePath));
  } finally {
    closeSync(lockFd);
    unlinkSync(lockPath);
  }
}

function digestToken(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function cleanExpired(state, now = Date.now()) {
  const pending = state.pending.filter((entry) => entry.expires_at > now);
  return { ...state, pending };
}

function createPairing({ ttlMs = 5 * 60 * 1000, statePath, lockPath, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 10 * 60 * 1000) {
    throw new Error("pairing TTL must be between 1 second and 10 minutes");
  }
  const token = randomBytes(24).toString("base64url");
  const digest = digestToken(token).toString("hex");
  const expiresAt = now + ttlMs;
  withStateLock((loaded, commit) => {
    const state = cleanExpired(loaded, now);
    if (state.pending.length >= MAX_PENDING) throw new Error("too many pending pairing tokens");
    state.pending.push({ digest, expires_at: expiresAt, created_at: now });
    commit(state);
  }, { statePath, lockPath });
  return { token, expiresAt };
}

function consumePairing(token, userId, chatId, {
  statePath,
  lockPath,
  now = Date.now(),
  chatType,
} = {}) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  if (chatType !== "private") return null;
  const canonicalUser = canonicalTelegramId(userId, { signed: false });
  const canonicalChat = canonicalTelegramId(chatId, { signed: false });
  if (canonicalUser !== canonicalChat) return null;
  const candidate = digestToken(token);
  return withStateLock((loaded, commit) => {
    const state = cleanExpired(loaded, now);
    const index = state.pending.findIndex((entry) => {
      const expected = Buffer.from(entry.digest, "hex");
      return expected.length === candidate.length && timingSafeEqual(expected, candidate);
    });
    if (index < 0) {
      if (state.pending.length !== loaded.pending.length) commit(state);
      return null;
    }
    state.pending.splice(index, 1);
    let authorization = state.authorizations.find(
      (entry) => entry.user_id === canonicalUser && entry.chat_id === canonicalChat,
    );
    if (!authorization) {
      if (state.authorizations.length >= MAX_AUTHORIZATIONS) {
        throw new Error("too many Telegram authorizations");
      }
      authorization = {
        authorization_id: randomBytes(18).toString("base64url"),
        user_id: canonicalUser,
        chat_id: canonicalChat,
        created_at: now,
      };
      state.authorizations.push(authorization);
    }
    commit(state);
    return { ...authorization };
  }, { statePath, lockPath });
}

function isPaired(userId, chatId, { statePath = DEFAULT_STATE_PATH, chatType } = {}) {
  if (chatType !== "private") return false;
  const canonicalUser = canonicalTelegramId(userId, { signed: false });
  const canonicalChat = canonicalTelegramId(chatId, { signed: false });
  if (canonicalUser !== canonicalChat) return false;
  const state = cleanExpired(loadState(statePath));
  return state.authorizations.some(
    (entry) => entry.user_id === canonicalUser && entry.chat_id === canonicalChat,
  );
}

function hasPairingBootstrap({ statePath = DEFAULT_STATE_PATH } = {}) {
  const state = cleanExpired(loadState(statePath));
  return state.pending.length > 0 || state.authorizations.some(
    (entry) => entry.user_id === entry.chat_id && !entry.chat_id.startsWith("-"),
  );
}

function listPairings({ statePath, lockPath, now = Date.now() } = {}) {
  return withStateLock((loaded, commit) => {
    const state = cleanExpired(loaded, now);
    if (state.pending.length !== loaded.pending.length) commit(state);
    return {
      pending: state.pending.map((entry) => ({ expires_at: new Date(entry.expires_at).toISOString() })),
      authorizations: state.authorizations.map((entry) => ({ ...entry })),
    };
  }, { statePath, lockPath });
}

function revokePairing(authorizationId, { statePath, lockPath } = {}) {
  if (typeof authorizationId !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(authorizationId)) {
    throw new Error("invalid authorization id");
  }
  return withStateLock((state, commit) => {
    const next = state.authorizations.filter((entry) => entry.authorization_id !== authorizationId);
    if (next.length === state.authorizations.length) return false;
    commit({ ...state, authorizations: next });
    return true;
  }, { statePath, lockPath });
}

export {
  DEFAULT_LOCK_PATH,
  DEFAULT_STATE_PATH,
  canonicalTelegramId,
  consumePairing,
  createPairing,
  hasPairingBootstrap,
  isPaired,
  listPairings,
  loadState,
  revokePairing,
};
