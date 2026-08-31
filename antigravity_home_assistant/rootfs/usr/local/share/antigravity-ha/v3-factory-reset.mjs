import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RESET_SCHEMA = "antigravity-ha-v3-factory-reset/v1";
export const RESET_MARKER_NAME = ".antigravity-ha-v3-reset-complete.json";
export const RESET_TARGET_NAMES = Object.freeze([
  "home",
  "antigravity",
  "antigravity-ha",
  "antigravity-ha-memory",
  "browser-auth",
  "github-cli",
  "ssh",
  "tmux",
]);

const MAX_MARKER_BYTES = 4_096;

export class FactoryResetError extends Error {}

function safeLstat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new FactoryResetError(`cannot inspect reset path: ${path}`);
  }
}

function validateDataRoot(dataRoot, requiredUid) {
  const info = safeLstat(dataRoot);
  if (
    !info ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== requiredUid
  ) {
    throw new FactoryResetError("the App data root is unavailable or unsafe");
  }
}

function readCompletedMarker(markerPath, requiredUid) {
  const info = safeLstat(markerPath);
  if (!info) return false;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== requiredUid ||
    info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600 ||
    info.size < 2 ||
    info.size > MAX_MARKER_BYTES
  ) {
    throw new FactoryResetError("the 3.0 reset marker is unsafe");
  }

  let value;
  try {
    value = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw new FactoryResetError("the 3.0 reset marker is invalid");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "completed,schema" ||
    value.schema !== RESET_SCHEMA ||
    value.completed !== true
  ) {
    throw new FactoryResetError("the 3.0 reset marker is invalid");
  }
  return true;
}

function validateTarget(target, requiredUid) {
  const info = safeLstat(target);
  if (!info) return false;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== requiredUid
  ) {
    throw new FactoryResetError(`refusing unsafe reset target: ${target}`);
  }
  return true;
}

function fsyncDirectory(path, requiredUid) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const info = fstatSync(descriptor);
    if (!info.isDirectory() || info.uid !== requiredUid) {
      throw new FactoryResetError("the App data root changed during reset");
    }
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeCompletedMarker(markerPath, requiredUid) {
  const parent = dirname(markerPath);
  const temporary = `${markerPath}.tmp`;
  const stale = safeLstat(temporary);
  if (stale) {
    if (
      !stale.isFile() ||
      stale.isSymbolicLink() ||
      stale.uid !== requiredUid ||
      stale.nlink !== 1
    ) {
      throw new FactoryResetError("the temporary 3.0 reset marker is unsafe");
    }
    rmSync(temporary);
  }

  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(
      descriptor,
      `${JSON.stringify({ schema: RESET_SCHEMA, completed: true })}\n`,
    );
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  renameSync(temporary, markerPath);
  fsyncDirectory(parent, requiredUid);
}

export function runFactoryReset({ dataRoot = "/data", requiredUid = 0 } = {}) {
  validateDataRoot(dataRoot, requiredUid);
  const markerPath = join(dataRoot, RESET_MARKER_NAME);
  if (readCompletedMarker(markerPath, requiredUid)) {
    return { status: "already_complete", removed: [] };
  }

  const targets = RESET_TARGET_NAMES.map((name) => join(dataRoot, name));
  for (const target of targets) validateTarget(target, requiredUid);

  const removed = [];
  for (const target of targets) {
    if (!safeLstat(target)) continue;
    rmSync(target, { recursive: true, force: false, maxRetries: 2 });
    removed.push(target);
  }
  writeCompletedMarker(markerPath, requiredUid);
  return { status: "reset", removed };
}

function isMain() {
  if (!process.argv[1]) return false;
  return pathToFileURL(fileURLToPath(import.meta.url)).href ===
    pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  if (process.argv.length !== 2) {
    console.error("v3-factory-reset: command-line arguments are not supported");
    process.exitCode = 64;
  } else {
    try {
      console.log(JSON.stringify(runFactoryReset()));
    } catch (error) {
      console.error(
        error instanceof FactoryResetError
          ? `v3-factory-reset: ${error.message}`
          : "v3-factory-reset: reset failed",
      );
      process.exitCode = 1;
    }
  }
}
