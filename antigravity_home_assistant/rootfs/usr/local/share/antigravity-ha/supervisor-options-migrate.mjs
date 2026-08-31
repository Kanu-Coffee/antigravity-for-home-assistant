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
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const SUPERVISOR_OPTIONS_URL = "http://supervisor/addons/self/options";
export const COMPLETION_PATH = "/data/.antigravity-ha-v3-options-complete.json";
export const COMPLETION_SCHEMA = "antigravity-ha-v3-options-reset/v1";
export const DEFAULT_OPTIONS = Object.freeze({
  remote_control_name: "home-assistant",
  antigravity_sensitive_data_access: false,
  home_assistant_browser_auto_auth: true,
  log_level: "info",
});

const CREDENTIAL_PATH = "/run/antigravity-ha/supervisor.token";
const RUNTIME_ROOT = "/run/antigravity-ha";
const MAX_CREDENTIAL_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MARKER_BYTES = 4_096;

export class OptionsResetError extends Error {}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSafeFile(path, { maxBytes, modes, requiredUid = 0 }) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const before = fstatSync(descriptor);
    const mode = before.mode & 0o777;
    if (
      !before.isFile() ||
      before.uid !== requiredUid ||
      before.nlink !== 1 ||
      before.size < 0 ||
      before.size > maxBytes ||
      (modes && !modes.has(mode))
    ) {
      throw new OptionsResetError(`${path} is unavailable or unsafe`);
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new OptionsResetError(`${path} changed while being read`);
    }
    return content;
  } catch (error) {
    if (error instanceof OptionsResetError) throw error;
    throw new OptionsResetError(`${path} is unavailable or unsafe`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function markerComplete(path, requiredUid) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new OptionsResetError("the 3.0 option-reset marker is unavailable");
  }
  let value;
  try {
    value = JSON.parse(
      readSafeFile(path, {
        maxBytes: MAX_MARKER_BYTES,
        modes: new Set([0o600]),
        requiredUid,
      }).toString("utf8"),
    );
  } catch (error) {
    if (error instanceof OptionsResetError) throw error;
    throw new OptionsResetError("the 3.0 option-reset marker is invalid");
  }
  if (
    !isPlainObject(value) ||
    Object.keys(value).sort().join(",") !== "completed,schema" ||
    value.schema !== COMPLETION_SCHEMA ||
    value.completed !== true
  ) {
    throw new OptionsResetError("the 3.0 option-reset marker is invalid");
  }
  return true;
}

function assertRuntimeRoot(path, requiredUid) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw new OptionsResetError("the private runtime directory is unavailable");
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== requiredUid ||
    (info.mode & 0o777) !== 0o700
  ) {
    throw new OptionsResetError("the private runtime directory is unsafe");
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

function writeCompletion(path, requiredUid) {
  const temporary = `${path}.tmp`;
  rmSync(temporary, { force: true });
  try {
    writePrivateFile(
      temporary,
      `${JSON.stringify({ schema: COMPLETION_SCHEMA, completed: true })}\n`,
    );
    renameSync(temporary, path);
    let descriptor;
    try {
      descriptor = openSync(
        dirname(path),
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      if (fstatSync(descriptor).uid !== requiredUid) {
        throw new OptionsResetError("the App data root changed during reset");
      }
      fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  if (!markerComplete(path, requiredUid)) {
    throw new OptionsResetError("the option reset could not be recorded");
  }
}

function readCredential(path, requiredUid) {
  const token = readSafeFile(path, {
    maxBytes: MAX_CREDENTIAL_BYTES,
    modes: new Set([0o400, 0o600]),
    requiredUid,
  }).toString("utf8");
  if (
    token.length === 0 ||
    token.length > MAX_CREDENTIAL_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(token)
  ) {
    throw new OptionsResetError("the Supervisor credential is unsafe");
  }
  return token;
}

export function performFixedSupervisorRequest({
  payload,
  requiredUid = 0,
  runtimeRoot = RUNTIME_ROOT,
  spawnSyncImpl = spawnSync,
  token,
} = {}) {
  if (!isPlainObject(payload) || !isPlainObject(payload.options)) {
    throw new OptionsResetError("the option-reset payload is invalid");
  }
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_CREDENTIAL_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(token)
  ) {
    throw new OptionsResetError("the Supervisor credential is unsafe");
  }
  assertRuntimeRoot(runtimeRoot, requiredUid);
  const prefix = join(runtimeRoot, ".v3-options-reset.");
  const temporaryDirectory = mkdtempSync(prefix);
  chmodSync(temporaryDirectory, 0o700);
  try {
    const headerPath = join(temporaryDirectory, "headers");
    const requestPath = join(temporaryDirectory, "request.json");
    const responsePath = join(temporaryDirectory, "response.json");
    writePrivateFile(headerPath, `Authorization: Bearer ${token}\n`);
    writePrivateFile(requestPath, `${JSON.stringify(payload)}\n`);
    writePrivateFile(responsePath, "");
    const result = spawnSyncImpl(
      "/usr/bin/curl",
      [
        "--disable", "--silent", "--show-error", "--noproxy", "*",
        "--proxy", "", "--proto", "=http", "--proto-redir", "=http",
        "--max-redirs", "0", "--request", "POST", "--header", `@${headerPath}`,
        "--header", "Accept: application/json", "--header", "Content-Type: application/json",
        "--data-binary", `@${requestPath}`, "--output", responsePath,
        "--write-out", "%{http_code}", "--connect-timeout", "5", "--max-time", "15",
        SUPERVISOR_OPTIONS_URL,
      ],
      {
        encoding: "utf8",
        env: { HOME: "/nonexistent", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
        killSignal: "SIGKILL",
        maxBuffer: 4_096,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      },
    );
    if (
      result.error ||
      result.signal ||
      result.status !== 0 ||
      !/^2[0-9]{2}$/u.test((result.stdout ?? "").trim())
    ) {
      throw new OptionsResetError("the Supervisor option-reset request failed");
    }
    let response;
    try {
      response = JSON.parse(
        readSafeFile(responsePath, {
          maxBytes: MAX_RESPONSE_BYTES,
          modes: new Set([0o600]),
          requiredUid,
        }).toString("utf8"),
      );
    } catch (error) {
      if (error instanceof OptionsResetError) throw error;
      throw new OptionsResetError("the Supervisor option-reset response is invalid");
    }
    if (!isPlainObject(response) || response.result !== "ok") {
      throw new OptionsResetError("the Supervisor rejected the option reset");
    }
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function resetSupervisorOptions({
  completionPath = COMPLETION_PATH,
  credentialPath = CREDENTIAL_PATH,
  requestImpl = performFixedSupervisorRequest,
  requiredUid = 0,
  runtimeRoot = RUNTIME_ROOT,
} = {}) {
  if (markerComplete(completionPath, requiredUid)) {
    return { status: "already_complete" };
  }
  const token = readCredential(credentialPath, requiredUid);
  const payload = { options: { ...DEFAULT_OPTIONS } };
  requestImpl({ payload, requiredUid, runtimeRoot, token });
  writeCompletion(completionPath, requiredUid);
  return { status: "reset" };
}

function main() {
  if (process.argv.length !== 2) {
    console.error("supervisor-options-migrate.mjs does not accept arguments");
    process.exitCode = 64;
    return;
  }
  delete process.env.SUPERVISOR_TOKEN;
  process.umask(0o077);
  try {
    console.log(JSON.stringify(resetSupervisorOptions()));
  } catch {
    console.error("The 3.0 Supervisor option reset is unavailable and will retry");
    process.exitCode = 75;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
