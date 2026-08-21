import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  isNativeRawJsonNumber,
  nativeParseJsonContent,
} from "./telegram-permission-policy.mjs";

const MAX_SETTINGS_BYTES = 256 * 1024;
const JSON_NUMBER = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u;

function canonicalExactNumber(value) {
  if (!isNativeRawJsonNumber(value)) {
    throw new Error("settings numbers must preserve their source lexeme");
  }
  const source = JSON.stringify(value);
  if (!JSON_NUMBER.test(source)) throw new Error("invalid JSON number");
  // The native parser preserves the source lexeme specifically so policy
  // comparisons can distinguish rewrites such as 1.0 -> 10e-1, -0 -> 0,
  // and adjacent integers outside JavaScript's safe-number range. Do not
  // normalize mathematically equivalent numbers in this fail-closed digest.
  return source;
}

function canonicalJsonValue(value) {
  if (isNativeRawJsonNumber(value)) return canonicalExactNumber(value);
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonValue(item)).join(",")}]`;
  }
  if (typeof value !== "object") throw new Error("unsupported JSON value");
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJsonValue(value[key])}`).join(",")}}`;
}

function isPlainSettingsObject(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && !isNativeRawJsonNumber(value);
}

export function settingsInvariantFingerprint(value) {
  if (!isPlainSettingsObject(value)) {
    throw new Error("settings must be an object");
  }
  if (Object.hasOwn(value, "enableTelemetry") &&
      typeof value.enableTelemetry !== "boolean") {
    throw new Error("enableTelemetry must be a boolean");
  }
  const invariant = { ...value };
  delete invariant.enableTelemetry;
  return createHash("sha256")
    .update(canonicalJsonValue(invariant), "utf8")
    .digest("hex");
}

function assertSecureSettings(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== 0 ||
      stats.gid !== 0 || stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600 || stats.size < 2 ||
      stats.size > MAX_SETTINGS_BYTES) {
    throw new Error("unsafe settings metadata");
  }
}

function fingerprintFile(path) {
  const before = lstatSync(path);
  assertSecureSettings(before);
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    assertSecureSettings(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("settings changed during secure open");
    }
    const bytes = readFileSync(descriptor);
    if (bytes.length !== opened.size) {
      throw new Error("settings changed during read");
    }
    return settingsInvariantFingerprint(nativeParseJsonContent(bytes));
  } finally {
    closeSync(descriptor);
  }
}

function main() {
  if (process.argv.length !== 3) throw new Error("invalid invocation");
  process.stdout.write(`${fingerprintFile(process.argv[2])}\n`);
}

if (process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    process.stderr.write("onboarding settings fingerprint: invalid settings file\n");
    process.exitCode = 65;
  }
}
