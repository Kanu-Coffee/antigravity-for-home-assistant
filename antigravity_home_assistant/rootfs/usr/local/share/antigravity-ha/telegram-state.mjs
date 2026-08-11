import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
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
import { basename, dirname, join } from "node:path";

const DEFAULT_STATE_PATH = "/data/antigravity-ha/telegram/bridge-state.json";
const MAX_STATE_BYTES = 3 * 1024 * 1024;
const MAX_CONVERSATIONS = 128;
const MAX_UPDATE_LEDGER_ENTRIES = 128;
const MAX_SEALED_UPDATE_ENTRIES = 128;
const MAX_SEALED_SPOOL_BYTES = 2 * 1024 * 1024;
const MAX_NORMALIZED_UPDATE_BYTES = 20 * 1024;
const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
const REQUIRED_UID = typeof process.getuid === "function" ? process.getuid() : 0;
const SEALED_UPDATE_SCHEMA = "antigravity-ha-telegram-update/v1";
const SEALED_UPDATE_ALGORITHM = "aes-256-gcm";
const KEY_DERIVATION_SALT = Buffer.from("antigravity-ha/telegram-spool/salt/v1", "utf8");
const KEY_DERIVATION_INFO = Buffer.from("antigravity-ha/telegram-spool/aes-256-gcm/v1", "utf8");

function telegramId(value, signed) {
  const text = String(value ?? "");
  const pattern = signed ? /^-?[1-9]\d{0,19}$/ : /^[1-9]\d{0,19}$/;
  if (!pattern.test(text)) throw new Error("invalid Telegram state identity");
  return text;
}

function ensurePrivateDirectory(path, create) {
  if (!existsSync(path)) {
    if (!create) throw new Error("Telegram state directory is missing");
    mkdirSync(path, { mode: 0o700 });
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== REQUIRED_UID ||
      (info.mode & 0o777) !== 0o700) {
    throw new Error("Telegram state directory is unsafe");
  }
}

function ensureStorage(path) {
  const parent = dirname(path);
  const managedRoot = dirname(parent);
  ensurePrivateDirectory(managedRoot, true);
  ensurePrivateDirectory(parent, true);
}

function emptyState() {
  return {
    version: 4,
    update_offset: 0,
    transport_offset: 0,
    update_ledger: [],
    sealed_updates: [],
    conversations: [],
  };
}

function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function canonicalBase64(value, expectedBytes = null) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("invalid Telegram sealed update encoding");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value ||
      (expectedBytes !== null && decoded.length !== expectedBytes)) {
    throw new Error("invalid Telegram sealed update encoding");
  }
  return decoded;
}

function validateChat(value) {
  if (!hasExactKeys(value, ["id", "type"])) throw new Error("invalid normalized Telegram chat");
  const id = telegramId(value.id, true);
  if (typeof value.type !== "string" || !/^[a-z_]{1,32}$/u.test(value.type)) {
    throw new Error("invalid normalized Telegram chat type");
  }
  return { id, type: value.type };
}

function validateFrom(value) {
  if (!hasExactKeys(value, ["id"])) throw new Error("invalid normalized Telegram sender");
  return { id: telegramId(value.id, false) };
}

function validateNormalizedUpdate(value) {
  if (!hasExactKeys(value, ["updateId", "kind", "value"]) ||
      !Number.isSafeInteger(value.updateId) || value.updateId < 0) {
    throw new Error("invalid normalized Telegram update");
  }
  if (value.kind === "message") {
    const message = value.value;
    if (!hasExactKeys(message, ["updateId", "message_id", "from", "chat", "text"]) ||
        message.updateId !== value.updateId ||
        !Number.isSafeInteger(message.message_id) || message.message_id <= 0 ||
        typeof message.text !== "string" ||
        Buffer.byteLength(message.text, "utf8") > 16 * 1024 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message.text)) {
      throw new Error("invalid normalized Telegram message");
    }
    return {
      updateId: value.updateId,
      kind: "message",
      value: {
        updateId: value.updateId,
        message_id: message.message_id,
        from: validateFrom(message.from),
        chat: validateChat(message.chat),
        text: message.text,
      },
    };
  }
  if (value.kind === "callback_query") {
    const callback = value.value;
    if (!hasExactKeys(callback, ["updateId", "id", "from", "message", "data"]) ||
        callback.updateId !== value.updateId ||
        typeof callback.id !== "string" || callback.id.length < 1 || callback.id.length > 128 ||
        typeof callback.data !== "string" || Buffer.byteLength(callback.data, "utf8") > 128 ||
        !hasExactKeys(callback.message, ["chat"])) {
      throw new Error("invalid normalized Telegram callback");
    }
    return {
      updateId: value.updateId,
      kind: "callback_query",
      value: {
        updateId: value.updateId,
        id: callback.id,
        from: validateFrom(callback.from),
        message: { chat: validateChat(callback.message.chat) },
        data: callback.data,
      },
    };
  }
  throw new Error("invalid normalized Telegram update kind");
}

function deriveSealedUpdateKey(botToken) {
  if (typeof botToken !== "string" || !/^[1-9]\d{5,15}:[A-Za-z0-9_-]{30,128}$/u.test(botToken)) {
    throw new Error("Telegram sealed spool key material is invalid");
  }
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(botToken, "utf8"),
    KEY_DERIVATION_SALT,
    KEY_DERIVATION_INFO,
    32,
  ));
}

function sealedUpdateAad(updateId) {
  return Buffer.from(`${SEALED_UPDATE_SCHEMA}\u0000${updateId}`, "utf8");
}

function sealedSpoolFailure(message) {
  const error = new Error(message);
  error.code = "ETELEGRAMSPOOL";
  return error;
}

function sealNormalizedUpdate(normalized, key) {
  const canonical = validateNormalizedUpdate(normalized);
  const plaintext = Buffer.from(JSON.stringify({
    schema: SEALED_UPDATE_SCHEMA,
    update: canonical,
  }), "utf8");
  if (plaintext.length > MAX_NORMALIZED_UPDATE_BYTES) {
    throw new Error("normalized Telegram update exceeded the sealed record limit");
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv(SEALED_UPDATE_ALGORITHM, key, nonce);
  cipher.setAAD(sealedUpdateAad(canonical.updateId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    update_id: canonical.updateId,
    algorithm: SEALED_UPDATE_ALGORITHM,
    nonce: nonce.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    plaintext_bytes: plaintext.length,
  };
}

function decryptSealedUpdate(record, key) {
  const nonce = canonicalBase64(record.nonce, 12);
  const authTag = canonicalBase64(record.auth_tag, 16);
  const ciphertext = canonicalBase64(record.ciphertext);
  let plaintext;
  try {
    const decipher = createDecipheriv(SEALED_UPDATE_ALGORITHM, key, nonce);
    decipher.setAAD(sealedUpdateAad(record.update_id));
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw sealedSpoolFailure("Telegram sealed spool authentication failed");
  }
  if (plaintext.length !== record.plaintext_bytes || plaintext.length > MAX_NORMALIZED_UPDATE_BYTES) {
    throw sealedSpoolFailure("Telegram sealed spool plaintext length is invalid");
  }
  let document;
  try {
    document = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw sealedSpoolFailure("Telegram sealed spool plaintext is invalid");
  }
  if (!hasExactKeys(document, ["schema", "update"]) || document.schema !== SEALED_UPDATE_SCHEMA) {
    throw sealedSpoolFailure("Telegram sealed spool schema is invalid");
  }
  let normalized;
  try {
    normalized = validateNormalizedUpdate(document.update);
  } catch {
    throw sealedSpoolFailure("Telegram sealed spool update is invalid");
  }
  if (normalized.updateId !== record.update_id) {
    throw sealedSpoolFailure("Telegram sealed spool identity is invalid");
  }
  return normalized;
}

function sealedSpoolBytes(records) {
  return records.reduce(
    (total, record) => total + canonicalBase64(record.ciphertext).length + 28,
    0,
  );
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![2, 3, 4].includes(value.version) ||
      !Number.isSafeInteger(value.update_offset) || value.update_offset < 0 ||
      !Array.isArray(value.conversations) || value.conversations.length > MAX_CONVERSATIONS) {
    throw new Error("unsupported Telegram bridge state");
  }
  const rawLedger = value.version === 2 ? [] : value.update_ledger;
  if (!Array.isArray(rawLedger) || rawLedger.length > MAX_UPDATE_LEDGER_ENTRIES) {
    throw new Error("unsupported Telegram update acknowledgement ledger");
  }
  let previousUpdateId = -1;
  const updateLedger = rawLedger.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        !Number.isSafeInteger(entry.update_id) || entry.update_id < value.update_offset ||
        entry.update_id <= previousUpdateId || typeof entry.acknowledged !== "boolean") {
      throw new Error("invalid Telegram update acknowledgement ledger");
    }
    previousUpdateId = entry.update_id;
    return { update_id: entry.update_id, acknowledged: entry.acknowledged };
  });
  const transportOffset = value.version === 4 ? value.transport_offset : value.update_offset;
  if (!Number.isSafeInteger(transportOffset) || transportOffset < value.update_offset) {
    throw new Error("invalid Telegram transport offset");
  }
  const rawSealedUpdates = value.version === 4 ? value.sealed_updates : [];
  if (!Array.isArray(rawSealedUpdates) ||
      rawSealedUpdates.length > MAX_SEALED_UPDATE_ENTRIES) {
    throw new Error("unsupported Telegram sealed update spool");
  }
  const ledgerById = new Map(updateLedger.map((entry) => [entry.update_id, entry]));
  let previousSealedId = -1;
  const sealedUpdates = rawSealedUpdates.map((entry) => {
    if (!hasExactKeys(entry, [
      "update_id",
      "algorithm",
      "nonce",
      "auth_tag",
      "ciphertext",
      "plaintext_bytes",
    ]) || !Number.isSafeInteger(entry.update_id) || entry.update_id < value.update_offset ||
        entry.update_id >= transportOffset || entry.update_id <= previousSealedId ||
        entry.algorithm !== SEALED_UPDATE_ALGORITHM ||
        !Number.isSafeInteger(entry.plaintext_bytes) || entry.plaintext_bytes < 1 ||
        entry.plaintext_bytes > MAX_NORMALIZED_UPDATE_BYTES) {
      throw new Error("invalid Telegram sealed update spool");
    }
    canonicalBase64(entry.nonce, 12);
    canonicalBase64(entry.auth_tag, 16);
    const ciphertext = canonicalBase64(entry.ciphertext);
    if (ciphertext.length !== entry.plaintext_bytes) {
      throw new Error("invalid Telegram sealed update ciphertext length");
    }
    const ledgerEntry = ledgerById.get(entry.update_id);
    if (!ledgerEntry || ledgerEntry.acknowledged) {
      throw new Error("Telegram sealed update is not pending acknowledgement");
    }
    previousSealedId = entry.update_id;
    return {
      update_id: entry.update_id,
      algorithm: entry.algorithm,
      nonce: entry.nonce,
      auth_tag: entry.auth_tag,
      ciphertext: entry.ciphertext,
      plaintext_bytes: entry.plaintext_bytes,
    };
  });
  if (sealedSpoolBytes(sealedUpdates) > MAX_SEALED_SPOOL_BYTES) {
    throw new Error("Telegram sealed update spool exceeded its byte limit");
  }
  const sealedIds = new Set(sealedUpdates.map((entry) => entry.update_id));
  for (const entry of updateLedger) {
    if (!entry.acknowledged && entry.update_id < transportOffset && !sealedIds.has(entry.update_id)) {
      throw new Error("confirmed Telegram update is missing from the sealed spool");
    }
  }
  const seen = new Set();
  const conversations = value.conversations.map((entry) => {
    if (!entry || typeof entry !== "object" || !Number.isSafeInteger(entry.last_used_at) ||
        typeof entry.conversation_id !== "string" ||
        !/^[A-Za-z0-9._:-]{1,256}$/.test(entry.conversation_id)) {
      throw new Error("invalid Telegram conversation binding");
    }
    const userId = telegramId(entry.user_id, false);
    const chatId = telegramId(entry.chat_id, true);
    const key = `${userId}:${chatId}`;
    if (seen.has(key)) throw new Error("duplicate Telegram conversation binding");
    seen.add(key);
    return {
      user_id: userId,
      chat_id: chatId,
      conversation_id: entry.conversation_id,
      last_used_at: entry.last_used_at,
    };
  });
  return {
    version: 4,
    update_offset: value.update_offset,
    transport_offset: transportOffset,
    update_ledger: updateLedger,
    sealed_updates: sealedUpdates,
    conversations,
  };
}

function loadBridgeState(path = DEFAULT_STATE_PATH) {
  ensureStorage(path);
  if (!existsSync(path)) return emptyState();
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== REQUIRED_UID || info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 || info.size > MAX_STATE_BYTES) {
    throw new Error("Telegram bridge state file is unsafe");
  }
  return validateState(JSON.parse(readFileSync(path, "utf8")));
}

function writeBridgeState(state, path = DEFAULT_STATE_PATH) {
  ensureStorage(path);
  const validated = validateState(state);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new Error("Telegram bridge state exceeded its byte limit");
  }
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}`,
  );
  let fd;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    const parentFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
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

function cleanConversations(state, now = Date.now()) {
  return {
    ...state,
    conversations: state.conversations.filter(
      (entry) => entry.last_used_at + CONVERSATION_TTL_MS > now,
    ),
  };
}

function getConversation(userId, chatId, { path = DEFAULT_STATE_PATH, now = Date.now() } = {}) {
  const canonicalUser = telegramId(userId, false);
  const canonicalChat = telegramId(chatId, true);
  const loaded = loadBridgeState(path);
  const state = cleanConversations(loaded, now);
  if (state.conversations.length !== loaded.conversations.length) writeBridgeState(state, path);
  return state.conversations.find(
    (entry) => entry.user_id === canonicalUser && entry.chat_id === canonicalChat,
  )?.conversation_id ?? null;
}

function setConversation(userId, chatId, conversationId, {
  path = DEFAULT_STATE_PATH,
  now = Date.now(),
} = {}) {
  const canonicalUser = telegramId(userId, false);
  const canonicalChat = telegramId(chatId, true);
  if (typeof conversationId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(conversationId)) {
    throw new Error("invalid Antigravity conversation id");
  }
  const state = cleanConversations(loadBridgeState(path), now);
  state.conversations = state.conversations.filter(
    (entry) => entry.user_id !== canonicalUser || entry.chat_id !== canonicalChat,
  );
  state.conversations.push({
    user_id: canonicalUser,
    chat_id: canonicalChat,
    conversation_id: conversationId,
    last_used_at: now,
  });
  if (state.conversations.length > MAX_CONVERSATIONS) {
    state.conversations.sort((left, right) => left.last_used_at - right.last_used_at);
    state.conversations = state.conversations.slice(-MAX_CONVERSATIONS);
  }
  writeBridgeState(state, path);
}

function clearConversation(userId, chatId, { path = DEFAULT_STATE_PATH } = {}) {
  const canonicalUser = telegramId(userId, false);
  const canonicalChat = telegramId(chatId, true);
  const state = loadBridgeState(path);
  const next = state.conversations.filter(
    (entry) => entry.user_id !== canonicalUser || entry.chat_id !== canonicalChat,
  );
  if (next.length === state.conversations.length) return false;
  writeBridgeState({ ...state, conversations: next }, path);
  return true;
}

function commitUpdateOffset(offset, { path = DEFAULT_STATE_PATH } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid Telegram update offset");
  const state = loadBridgeState(path);
  if (offset < state.update_offset) throw new Error("Telegram update offset cannot move backwards");
  if (offset === state.update_offset) return;
  if (state.update_ledger.some((entry) => entry.update_id < offset && !entry.acknowledged)) {
    throw new Error("Telegram update offset cannot pass an unacknowledged update");
  }
  writeBridgeState({
    ...state,
    update_offset: offset,
    transport_offset: Math.max(state.transport_offset, offset),
    update_ledger: state.update_ledger.filter((entry) => entry.update_id >= offset),
    sealed_updates: state.sealed_updates.filter((entry) => entry.update_id >= offset),
  }, path);
}

function collapseAcknowledgedPrefix(updateOffset, ledger) {
  let nextOffset = updateOffset;
  while (ledger[0]?.acknowledged === true) {
    nextOffset = ledger.shift().update_id + 1;
  }
  return nextOffset;
}

function loadSealedUpdates(botToken, { path = DEFAULT_STATE_PATH } = {}) {
  const state = loadBridgeState(path);
  if (state.sealed_updates.length === 0) return [];
  const key = deriveSealedUpdateKey(botToken);
  return state.sealed_updates.map((entry) => decryptSealedUpdate(entry, key));
}

function registerSealedUpdateBatch(records, botToken, { path = DEFAULT_STATE_PATH } = {}) {
  if (!Array.isArray(records) || records.length > 100) {
    throw new Error("invalid Telegram sealed update batch");
  }
  let previousUpdateId = -1;
  const canonicalRecords = records.map((record) => {
    if (!hasExactKeys(record, ["update_id", "normalized"]) ||
        !Number.isSafeInteger(record.update_id) || record.update_id < 0 ||
        record.update_id <= previousUpdateId) {
      throw new Error("invalid Telegram sealed update batch");
    }
    previousUpdateId = record.update_id;
    const normalized = record.normalized === null
      ? null
      : validateNormalizedUpdate(record.normalized);
    if (normalized !== null && normalized.updateId !== record.update_id) {
      throw new Error("Telegram update envelope and normalized identity differ");
    }
    return { update_id: record.update_id, normalized };
  });

  const state = loadBridgeState(path);
  const key = deriveSealedUpdateKey(botToken);
  const ledger = new Map(state.update_ledger.map((entry) => [entry.update_id, entry.acknowledged]));
  const sealed = new Map(state.sealed_updates.map((entry) => [entry.update_id, entry]));
  const decrypted = new Map();
  for (const entry of state.sealed_updates) {
    decrypted.set(entry.update_id, decryptSealedUpdate(entry, key));
  }

  let transportOffset = state.transport_offset;
  for (const record of canonicalRecords) {
    const { update_id: updateId, normalized } = record;
    if (updateId < state.update_offset) continue;
    const acknowledged = ledger.get(updateId) === true;
    if (normalized === null) {
      if (sealed.has(updateId)) {
        throw new Error("Telegram update normalization changed after durable registration");
      }
      if (!ledger.has(updateId)) ledger.set(updateId, true);
      else if (!acknowledged) ledger.set(updateId, true);
    } else if (!acknowledged) {
      if (!ledger.has(updateId)) ledger.set(updateId, false);
      if (sealed.has(updateId)) {
        if (JSON.stringify(decrypted.get(updateId)) !== JSON.stringify(normalized)) {
          throw new Error("Telegram update changed after durable registration");
        }
      } else {
        const encrypted = sealNormalizedUpdate(normalized, key);
        sealed.set(updateId, encrypted);
        decrypted.set(updateId, normalized);
      }
    }
    transportOffset = Math.max(transportOffset, updateId + 1);
  }

  const updateLedger = [...ledger]
    .sort(([left], [right]) => left - right)
    .map(([updateId, acknowledged]) => ({ update_id: updateId, acknowledged }));
  if (updateLedger.length > MAX_UPDATE_LEDGER_ENTRIES) {
    throw new Error("Telegram update acknowledgement ledger is full");
  }
  const sealedUpdates = [...sealed.values()].sort(
    (left, right) => left.update_id - right.update_id,
  );
  if (sealedUpdates.length > MAX_SEALED_UPDATE_ENTRIES) {
    throw new Error("Telegram sealed update spool is full");
  }
  if (sealedSpoolBytes(sealedUpdates) > MAX_SEALED_SPOOL_BYTES) {
    throw new Error("Telegram sealed update spool exceeded its byte limit");
  }
  const updateOffset = collapseAcknowledgedPrefix(state.update_offset, updateLedger);
  transportOffset = Math.max(transportOffset, updateOffset);
  const pendingIds = new Set(updateLedger.filter((entry) => !entry.acknowledged)
    .map((entry) => entry.update_id));
  const retainedSealed = sealedUpdates.filter((entry) => pendingIds.has(entry.update_id));
  writeBridgeState({
    ...state,
    update_offset: updateOffset,
    transport_offset: transportOffset,
    update_ledger: updateLedger,
    sealed_updates: retainedSealed,
  }, path);
  return {
    update_offset: updateOffset,
    transport_offset: transportOffset,
    entries: canonicalRecords.map((record) => ({
      update_id: record.update_id,
      acknowledged: record.update_id < updateOffset ||
        updateLedger.find((entry) => entry.update_id === record.update_id)?.acknowledged === true,
    })),
    updates: canonicalRecords
      .filter((record) => record.normalized !== null && pendingIds.has(record.update_id))
      .map((record) => decrypted.get(record.update_id)),
  };
}

function acknowledgeUpdate(updateId, { path = DEFAULT_STATE_PATH } = {}) {
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    throw new Error("invalid Telegram update acknowledgement");
  }
  const state = loadBridgeState(path);
  if (updateId < state.update_offset) return state.update_offset;
  const ledger = state.update_ledger.map((entry) => ({ ...entry }));
  const target = ledger.find((entry) => entry.update_id === updateId);
  if (!target) throw new Error("Telegram update was not durably registered");
  target.acknowledged = true;
  const updateOffset = collapseAcknowledgedPrefix(state.update_offset, ledger);
  writeBridgeState({
    ...state,
    update_offset: updateOffset,
    transport_offset: Math.max(state.transport_offset, updateOffset),
    update_ledger: ledger,
    sealed_updates: state.sealed_updates.filter((entry) => entry.update_id !== updateId),
  }, path);
  return updateOffset;
}

export {
  CONVERSATION_TTL_MS,
  DEFAULT_STATE_PATH,
  MAX_SEALED_SPOOL_BYTES,
  MAX_SEALED_UPDATE_ENTRIES,
  MAX_UPDATE_LEDGER_ENTRIES,
  acknowledgeUpdate,
  clearConversation,
  commitUpdateOffset,
  getConversation,
  loadBridgeState,
  loadSealedUpdates,
  registerSealedUpdateBatch,
  setConversation,
  validateNormalizedUpdate,
};
