import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";

import {
  isNativeRawJsonNumber,
  nativeCanonicalSettingsContent,
  nativeParseJsonContent,
  nativeSettingsToolPermission,
} from "./telegram-permission-policy.mjs";

const SETTINGS_DIRECTORY = "/data/home/.gemini/antigravity-cli";
const SETTINGS_PATH = `${SETTINGS_DIRECTORY}/settings.json`;
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_DEPTH = 16;
const MAX_NODES = 2_048;
const PROTECTED_KEYS = new Set([
  "permissions",
  "enableTerminalSandbox",
  "allowNonWorkspaceAccess",
  "toolPermission",
  "artifactReviewPolicy",
]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
function isUnicodeScalarString(value) {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
}
const SUPPORTED_SCALAR_PATCHES = new Map([
  ["altScreenMode", (value) =>
    typeof value === "string" && ["auto", "always", "never"].includes(value)],
  ["clearScrollbackOnResize", (value) => typeof value === "boolean"],
  ["colorScheme", isUnicodeScalarString],
  ["disableSlashCommands", (value) => typeof value === "boolean"],
  ["modelProvider", isUnicodeScalarString],
  ["showFeedbackSurvey", (value) => typeof value === "boolean"],
  ["showTips", (value) => typeof value === "boolean"],
]);

function fail(message, code = 65) {
  process.stderr.write(`agy-settings: ${message}\n`);
  process.exit(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSecureSettingsFile(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== 0 ||
      stats.nlink !== 1 || (stats.mode & 0o777) !== 0o600) {
    throw new Error("settings.json must be a root-owned 0600 regular file with one link");
  }
  if (stats.size < 2 || stats.size > MAX_SETTINGS_BYTES) {
    throw new Error("settings.json has an invalid size");
  }
}

function readSettings() {
  const before = lstatSync(SETTINGS_PATH);
  assertSecureSettingsFile(before);
  const descriptor = openSync(
    SETTINGS_PATH,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    assertSecureSettingsFile(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("settings.json changed during secure open");
    }
    const bytes = readFileSync(descriptor);
    if (bytes.length !== opened.size || bytes.length > MAX_SETTINGS_BYTES) {
      throw new Error("settings.json changed during read");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function parseObject(bytes, label) {
  let value;
  try {
    value = nativeParseJsonContent(bytes);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      isNativeRawJsonNumber(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function validateJson(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) {
    throw new Error("JSON patch exceeds the structural limit");
  }
  if (isNativeRawJsonNumber(value)) return;
  if (value === null || typeof value === "string" ||
      typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON numbers must be finite");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1, budget);
    return;
  }
  if (typeof value !== "object") throw new Error("unsupported JSON value");
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`forbidden JSON key: ${key}`);
    validateJson(item, depth + 1, budget);
  }
}

function mergePatch(target, patch) {
  const output = target !== null && typeof target === "object" &&
      !Array.isArray(target) && !isNativeRawJsonNumber(target)
    ? { ...target }
    : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete output[key];
    } else if (typeof value === "object" && !Array.isArray(value) &&
        !isNativeRawJsonNumber(value)) {
      output[key] = mergePatch(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function validateSupportedPatch(patch) {
  for (const [key, value] of Object.entries(patch)) {
    const validator = SUPPORTED_SCALAR_PATCHES.get(key);
    if (!validator) {
      // Deleting an existing or stale unknown setting cannot introduce a
      // native schema transform and provides a bounded recovery path for
      // values written by an older helper. Protected keys were rejected first.
      if (value === null) continue;
      throw new Error(
        "patch contains an unsupported top-level setting",
      );
    }
    // JSON merge-patch null removes a supported setting and lets the native
    // default apply. Objects, arrays and unknown native typed settings are
    // deliberately rejected: the App cannot safely reproduce every private
    // native schema transformation while settings.json remains write-protected.
    if (value !== null && !validator(value)) {
      throw new Error("patch contains an unsupported scalar setting value");
    }
  }
}

function readBoundedStdin() {
  const chunks = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(8_192);
  for (;;) {
    const count = readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_REQUEST_BYTES) {
      throw new Error("request exceeds 64 KiB");
    }
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  if (total === 0) throw new Error("request body is empty");
  return Buffer.concat(chunks, total);
}

function syncDirectory() {
  const descriptor = openSync(
    SETTINGS_DIRECTORY,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeAtomic(candidate) {
  const temporary = `${SETTINGS_DIRECTORY}/.agy-settings.${process.pid}.${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, candidate);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, SETTINGS_PATH);
    syncDirectory();
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

function patchSettings() {
  const request = parseObject(readBoundedStdin(), "request");
  validateJson(request);
  const requestKeys = Object.keys(request).sort();
  if (JSON.stringify(requestKeys) !== JSON.stringify(["expected_sha256", "patch"])) {
    throw new Error("request accepts only expected_sha256 and patch");
  }
  if (typeof request.expected_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(request.expected_sha256)) {
    throw new Error("expected_sha256 must be a lowercase SHA-256 digest");
  }
  if (request.patch === null || typeof request.patch !== "object" ||
      Array.isArray(request.patch) || Object.keys(request.patch).length === 0) {
    throw new Error("patch must be a non-empty JSON merge-patch object");
  }
  for (const protectedKey of PROTECTED_KEYS) {
    if (Object.hasOwn(request.patch, protectedKey)) {
      throw new Error(`${protectedKey} is App-managed and cannot be changed here`);
    }
  }
  validateSupportedPatch(request.patch);

  const currentBytes = readSettings();
  if (sha256(currentBytes) !== request.expected_sha256) {
    throw new Error("settings.json changed; request a fresh digest and retry");
  }
  const current = parseObject(currentBytes, "settings.json");
  const candidateValue = mergePatch(current, request.patch);
  for (const key of PROTECTED_KEYS) {
    if (JSON.stringify(candidateValue[key]) !== JSON.stringify(current[key])) {
      throw new Error(`${key} changed unexpectedly`);
    }
  }
  validateJson(candidateValue);
  const candidate = nativeCanonicalSettingsContent(
    candidateValue,
    nativeSettingsToolPermission(current),
  );
  if (candidate.length > MAX_SETTINGS_BYTES) {
    throw new Error("updated settings.json exceeds 256 KiB");
  }
  writeAtomic(candidate);
  process.stdout.write(`${JSON.stringify({
    status: "updated",
    sha256: sha256(candidate),
    changed_keys: Object.keys(request.patch).sort(),
  })}\n`);
}

try {
  const command = process.argv[2];
  if (process.argv.length !== 3 || !new Set(["sha256", "patch"]).has(command)) {
    fail("usage: agy-settings sha256 | agy-settings patch", 64);
  }
  if (command === "sha256") {
    process.stdout.write(`${sha256(readSettings())}\n`);
  } else {
    patchSettings();
  }
} catch (error) {
  fail(error instanceof Error ? error.message : "settings update failed");
}
