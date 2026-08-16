import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const SUPERVISOR_OPTIONS_URL = "http://supervisor/addons/self/options";
export const NORMALIZED_UPDATE_MODE = "refresh_managed";
export const LEGACY_UPDATE_MODES = new Set(["refresh_agents", "refresh_all"]);
export const RETIRED_TELEGRAM_OPTION = "telegram_access_mode";
export const RETIRED_TELEGRAM_MIGRATION = "remove-telegram-access-mode@2.0.7";

const OPTIONS_PATH = "/data/options.json";
const CREDENTIAL_PATH = "/run/antigravity-ha/supervisor.token";
const RUNTIME_ROOT = "/run/antigravity-ha";
const COMPLETION_PATH =
  "/data/antigravity-ha/migration/supervisor-options-2.0.7.json";
const COMPLETION_SCHEMA = "antigravity-ha-supervisor-options-migration/v1";
const MAX_OPTIONS_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_COMPLETION_BYTES = 4_096;

export class RetryableMigrationError extends Error {}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertSafeRegularFile(path, info, { maxBytes, requiredUid, modes }) {
  const mode = info.mode & 0o777;
  if (
    !info.isFile() ||
    info.uid !== requiredUid ||
    info.nlink !== 1 ||
    info.size < 0 ||
    info.size > maxBytes ||
    (modes ? !modes.has(mode) : (mode & 0o077) !== 0)
  ) {
    throw new RetryableMigrationError(`${path} is unavailable or unsafe`);
  }
}

function readSafeRegularFile(path, { maxBytes, requiredUid = 0, modes } = {}) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor);
    assertSafeRegularFile(path, before, { maxBytes, requiredUid, modes });
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    assertSafeRegularFile(path, after, { maxBytes, requiredUid, modes });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new RetryableMigrationError(`${path} changed while being read`);
    }
    return content;
  } catch (error) {
    if (error instanceof RetryableMigrationError) throw error;
    throw new RetryableMigrationError(`${path} is unavailable or unsafe`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readCurrentOptions(path, requiredUid) {
  const content = readSafeRegularFile(path, {
    maxBytes: MAX_OPTIONS_BYTES,
    requiredUid,
  });
  let value;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    throw new RetryableMigrationError("Current App options are invalid");
  }
  if (!isPlainObject(value)) {
    throw new RetryableMigrationError("Current App options are invalid");
  }
  return value;
}

function readSupervisorCredential(path, requiredUid) {
  const token = readSafeRegularFile(path, {
    maxBytes: MAX_CREDENTIAL_BYTES,
    modes: new Set([0o400, 0o600]),
    requiredUid,
  }).toString("utf8");
  if (
    token.length === 0 ||
    token.length > MAX_CREDENTIAL_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(token)
  ) {
    throw new RetryableMigrationError(
      "Supervisor credential is unavailable or unsafe",
    );
  }
  return token;
}

export function normalizedOptionsPayload(
  options,
  { forceSanitizedPost = false } = {},
) {
  if (!isPlainObject(options)) {
    throw new RetryableMigrationError("Current App options are invalid");
  }
  const requestedMode = options.antigravity_user_files_update_mode;
  const normalizeUpdateMode = LEGACY_UPDATE_MODES.has(requestedMode);
  const removeRetiredTelegramMode = Object.hasOwn(
    options,
    RETIRED_TELEGRAM_OPTION,
  );
  if (
    !normalizeUpdateMode &&
    !removeRetiredTelegramMode &&
    !forceSanitizedPost
  ) {
    return undefined;
  }
  const normalized = { ...options };
  if (normalizeUpdateMode) {
    normalized.antigravity_user_files_update_mode = NORMALIZED_UPDATE_MODE;
  }
  delete normalized[RETIRED_TELEGRAM_OPTION];
  return {
    options: normalized,
  };
}

function completionRecorded(path, requiredUid) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new RetryableMigrationError(
      "Supervisor option migration completion state is unavailable",
    );
  }

  const content = readSafeRegularFile(path, {
    maxBytes: MAX_COMPLETION_BYTES,
    modes: new Set([0o600]),
    requiredUid,
  });
  let state;
  try {
    state = JSON.parse(content.toString("utf8"));
  } catch {
    throw new RetryableMigrationError(
      "Supervisor option migration completion state is invalid",
    );
  }
  if (
    !isPlainObject(state) ||
    Object.keys(state).sort().join(",") !== "completed,migration,schema" ||
    state.schema !== COMPLETION_SCHEMA ||
    state.migration !== RETIRED_TELEGRAM_MIGRATION ||
    state.completed !== true
  ) {
    throw new RetryableMigrationError(
      "Supervisor option migration completion state is invalid",
    );
  }
  return true;
}

function assertPrivateRuntimeRoot(path, requiredUid) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw new RetryableMigrationError(
      "Supervisor option migration runtime directory is unavailable",
    );
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== requiredUid ||
    (info.mode & 0o777) !== 0o700
  ) {
    throw new RetryableMigrationError(
      "Supervisor option migration runtime directory is unsafe",
    );
  }
}

function ensurePrivateDirectory(path, requiredUid) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw new RetryableMigrationError(
        "Supervisor option migration state directory is unavailable",
      );
    }
  }
  assertPrivateRuntimeRoot(path, requiredUid);
}

function fsyncPrivateDirectory(path, requiredUid) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const info = fstatSync(descriptor);
    if (
      !info.isDirectory() ||
      info.uid !== requiredUid ||
      (info.mode & 0o777) !== 0o700
    ) {
      throw new RetryableMigrationError(
        "Supervisor option migration state directory is unsafe",
      );
    }
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof RetryableMigrationError) throw error;
    throw new RetryableMigrationError(
      "Supervisor option migration state directory is unavailable",
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writePrivateFile(path, content) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, content);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function recordCompletion(path, requiredUid) {
  const stateDirectory = dirname(path);
  ensurePrivateDirectory(stateDirectory, requiredUid);
  const prefix = join(stateDirectory, ".supervisor-options-complete.");
  let temporaryDirectory;
  try {
    temporaryDirectory = mkdtempSync(prefix);
    chmodSync(temporaryDirectory, 0o700);
    const stagedPath = join(temporaryDirectory, "completion.json");
    writePrivateFile(
      stagedPath,
      `${JSON.stringify({
        schema: COMPLETION_SCHEMA,
        migration: RETIRED_TELEGRAM_MIGRATION,
        completed: true,
      })}\n`,
    );
    renameSync(stagedPath, path);
    fsyncPrivateDirectory(stateDirectory, requiredUid);
  } catch (error) {
    if (error instanceof RetryableMigrationError) throw error;
    throw new RetryableMigrationError(
      "Supervisor option migration completion state could not be recorded",
    );
  } finally {
    if (
      temporaryDirectory !== undefined &&
      temporaryDirectory.startsWith(prefix)
    ) {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }
  if (!completionRecorded(path, requiredUid)) {
    throw new RetryableMigrationError(
      "Supervisor option migration completion state could not be verified",
    );
  }
}

export function performFixedSupervisorRequest({
  payload,
  requiredUid = 0,
  runtimeRoot = RUNTIME_ROOT,
  spawnSyncImpl = spawnSync,
  token,
} = {}) {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_CREDENTIAL_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(token) ||
    !isPlainObject(payload) ||
    !isPlainObject(payload.options)
  ) {
    throw new RetryableMigrationError(
      "Supervisor option migration input is unavailable or unsafe",
    );
  }

  assertPrivateRuntimeRoot(runtimeRoot, requiredUid);
  const prefix = join(runtimeRoot, ".supervisor-options-migrate.");
  let temporaryDirectory;
  try {
    temporaryDirectory = mkdtempSync(prefix);
    chmodSync(temporaryDirectory, 0o700);
    const headerPath = join(temporaryDirectory, "headers");
    const requestPath = join(temporaryDirectory, "request.json");
    const responsePath = join(temporaryDirectory, "response.json");
    writePrivateFile(headerPath, `Authorization: Bearer ${token}\n`);
    writePrivateFile(requestPath, `${JSON.stringify(payload)}\n`);
    writePrivateFile(responsePath, "");

    const curlArguments = [
      "--disable",
      "--silent",
      "--show-error",
      "--noproxy",
      "*",
      "--proxy",
      "",
      "--proto",
      "=http",
      "--proto-redir",
      "=http",
      "--max-redirs",
      "0",
      "--request",
      "POST",
      "--header",
      `@${headerPath}`,
      "--header",
      "Accept: application/json",
      "--header",
      "Content-Type: application/json",
      "--data-binary",
      `@${requestPath}`,
      "--output",
      responsePath,
      "--write-out",
      "%{http_code}",
      "--connect-timeout",
      "5",
      "--max-time",
      "15",
      SUPERVISOR_OPTIONS_URL,
    ];
    const result = spawnSyncImpl("/usr/bin/curl", curlArguments, {
      encoding: "utf8",
      env: {
        HOME: "/nonexistent",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/bin:/bin",
      },
      killSignal: "SIGKILL",
      maxBuffer: 4_096,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    if (
      result.error ||
      result.signal ||
      result.status !== 0 ||
      !/^2[0-9]{2}$/u.test((result.stdout ?? "").trim())
    ) {
      throw new RetryableMigrationError(
        "Supervisor self-options request was unavailable",
      );
    }

    const responseContent = readSafeRegularFile(responsePath, {
      maxBytes: MAX_RESPONSE_BYTES,
      modes: new Set([0o600]),
      requiredUid,
    });
    let response;
    try {
      response = JSON.parse(responseContent.toString("utf8"));
    } catch {
      throw new RetryableMigrationError(
        "Supervisor self-options response was invalid",
      );
    }
    if (!isPlainObject(response) || response.result !== "ok") {
      throw new RetryableMigrationError(
        "Supervisor self-options response was rejected",
      );
    }
  } finally {
    if (
      temporaryDirectory !== undefined &&
      temporaryDirectory.startsWith(prefix)
    ) {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

export function migrateSupervisorOptions({
  completionPath = COMPLETION_PATH,
  credentialPath = CREDENTIAL_PATH,
  optionsPath = OPTIONS_PATH,
  requestImpl = performFixedSupervisorRequest,
  requiredUid = 0,
  runtimeRoot = RUNTIME_ROOT,
} = {}) {
  const options = readCurrentOptions(optionsPath, requiredUid);
  const scrubCompleted = completionRecorded(completionPath, requiredUid);
  const payload = normalizedOptionsPayload(options, {
    forceSanitizedPost: !scrubCompleted,
  });
  if (payload === undefined) return { status: "not_required" };
  const token = readSupervisorCredential(credentialPath, requiredUid);
  requestImpl({ payload, requiredUid, runtimeRoot, token });
  if (!scrubCompleted) recordCompletion(completionPath, requiredUid);
  return { status: "migrated" };
}

function main() {
  if (process.argv.length !== 2) {
    process.stderr.write(
      "supervisor-options-migrate.mjs does not accept command-line arguments\n",
    );
    process.exitCode = 64;
    return;
  }
  delete process.env.SUPERVISOR_TOKEN;
  process.umask(0o077);
  try {
    process.stdout.write(`${JSON.stringify(migrateSupervisorOptions())}\n`);
  } catch {
    process.stderr.write(
      "Supervisor option normalization is unavailable; it will retry on the next App start\n",
    );
    process.exitCode = 75;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
