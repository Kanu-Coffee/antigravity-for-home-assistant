import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";

import {
  isNativeRawJsonNumber,
  nativeCanonicalSettingsContent,
  nativeParseJsonContent,
  nativeSettingsToolPermission,
} from "./telegram-permission-policy.mjs";
import { settingsInvariantFingerprint } from "./onboarding-settings-fingerprint.mjs";

const REAL_ROOT = "/data/home/.gemini/antigravity-cli";
const REAL_SETTINGS = `${REAL_ROOT}/settings.json`;
const REAL_OAUTH = `${REAL_ROOT}/antigravity-oauth-token`;
const REAL_ONBOARDING = `${REAL_ROOT}/cache/onboarding.json`;
const SETTINGS_TMP = `${REAL_ROOT}/settings.json.onboarding.tmp`;
const OAUTH_TMP = `${REAL_ROOT}/antigravity-oauth-token.onboarding.tmp`;
const ONBOARDING_TMP = `${REAL_ROOT}/cache/onboarding.json.onboarding.tmp`;

const STAGED_ROOT = "/run/antigravity-ha/onboarding-home/.gemini/antigravity-cli";
const STAGED_SETTINGS = `${STAGED_ROOT}/settings.json`;
const STAGED_SETTINGS_CANDIDATE = `${STAGED_ROOT}/settings.candidate.json`;
const STAGED_OAUTH = `${STAGED_ROOT}/antigravity-oauth-token`;
const STAGED_ONBOARDING = `${STAGED_ROOT}/cache/onboarding.json`;
const STAGED_ONBOARDING_TMP = `${STAGED_ROOT}/cache/onboarding.candidate.tmp`;

const TRANSACTION_ROOT = "/data/antigravity-ha/onboarding";
const JOURNAL = `${TRANSACTION_ROOT}/retry-required.json`;
const JOURNAL_TMP = `${TRANSACTION_ROOT}/retry-required.json.tmp`;
const RESTART_REQUIRED = `${TRANSACTION_ROOT}/restart-required`;
const RESTART_REQUIRED_TMP = `${TRANSACTION_ROOT}/restart-required.tmp`;
const RUNTIME_ROOT = "/run/antigravity-ha";
const ACTIVE_MARKER = `${RUNTIME_ROOT}/onboarding-active`;
const ACTIVE_MARKER_TMP = `${RUNTIME_ROOT}/onboarding-active.tmp`;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_OAUTH_BYTES = 1024 * 1024;
const MAX_ONBOARDING_BYTES = 4096;
const MAX_JOURNAL_BYTES = 8192;

function isMissing(error) {
  return error?.code === "ENOENT";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function secureSnapshot(path, maximumBytes, required = false) {
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (isMissing(error) && !required) return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 ||
      before.gid !== 0 || before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 || before.size < 2 ||
      before.size > maximumBytes) {
    throw new Error("unsafe onboarding transaction file");
  }
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.uid !== 0 || opened.gid !== 0 ||
        opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600 ||
        opened.size !== before.size || opened.dev !== before.dev ||
        opened.ino !== before.ino) {
      throw new Error("onboarding transaction file changed during secure open");
    }
    const bytes = readFileSync(descriptor);
    if (bytes.length !== opened.size) {
      throw new Error("onboarding transaction file changed during read");
    }
    return { bytes, sha256: sha256(bytes), size: bytes.length };
  } finally {
    closeSync(descriptor);
  }
}

function state(snapshot) {
  return snapshot === undefined
    ? { present: false, sha256: null, size: 0 }
    : { present: true, sha256: snapshot.sha256, size: snapshot.size };
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && !isNativeRawJsonNumber(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function parseSettings(snapshot) {
  const value = nativeParseJsonContent(snapshot.bytes);
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      isNativeRawJsonNumber(value)) {
    throw new Error("settings must be a JSON object");
  }
  return value;
}

function parseOnboarding(snapshot, requireComplete = false) {
  const value = JSON.parse(snapshot.bytes.toString("utf8"));
  if (!exactKeys(value, [
    "consumerOnboardingComplete",
    "enterpriseOnboardingComplete",
  ]) || typeof value.consumerOnboardingComplete !== "boolean" ||
      typeof value.enterpriseOnboardingComplete !== "boolean" ||
      (requireComplete &&
        (value.consumerOnboardingComplete !== true ||
         value.enterpriseOnboardingComplete !== false))) {
    throw new Error("invalid consumer onboarding status");
  }
  return value;
}

function assertRecord(value, allowAbsent) {
  if (!exactKeys(value, ["present", "sha256", "size"]) ||
      typeof value.present !== "boolean" ||
      !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error("invalid onboarding transaction record");
  }
  if (value.present) {
    if (!HEX_SHA256.test(value.sha256) || value.size < 2) {
      throw new Error("invalid present onboarding transaction record");
    }
  } else if (!allowAbsent || value.sha256 !== null || value.size !== 0) {
    throw new Error("invalid absent onboarding transaction record");
  }
}

function parseJournal() {
  const snapshot = secureSnapshot(JOURNAL, MAX_JOURNAL_BYTES, true);
  const value = JSON.parse(snapshot.bytes.toString("utf8"));
  if (!exactKeys(value, [
    "files",
    "phase",
    "restartRequired",
    "schema",
    "settingsInvariant",
  ]) ||
      value.schema !== 1 ||
      !new Set(["installing", "committed"]).has(value.phase) ||
      typeof value.restartRequired !== "boolean" ||
      !HEX_SHA256.test(value.settingsInvariant) ||
      !exactKeys(value.files, ["onboarding", "oauth", "settings"])) {
    throw new Error("invalid onboarding transaction journal");
  }
  for (const name of ["settings", "oauth", "onboarding"]) {
    const entry = value.files[name];
    if (!exactKeys(entry, ["baseline", "candidate"])) {
      throw new Error("invalid onboarding transaction file entry");
    }
    assertRecord(entry.baseline, name !== "settings");
    assertRecord(entry.candidate, name !== "settings");
  }
  if (!value.files.settings.baseline.present ||
      !value.files.settings.candidate.present ||
      !value.files.oauth.candidate.present ||
      !value.files.onboarding.candidate.present) {
    throw new Error("incomplete onboarding transaction journal");
  }
  return value;
}

function recordMatches(snapshot, record) {
  if (!record.present) return snapshot === undefined;
  return snapshot !== undefined && snapshot.sha256 === record.sha256 &&
    snapshot.size === record.size;
}

function currentSnapshots() {
  return {
    settings: secureSnapshot(REAL_SETTINGS, MAX_SETTINGS_BYTES, true),
    oauth: secureSnapshot(REAL_OAUTH, MAX_OAUTH_BYTES),
    onboarding: secureSnapshot(REAL_ONBOARDING, MAX_ONBOARDING_BYTES),
  };
}

function transactionStatus(journal = parseJournal()) {
  const current = currentSnapshots();
  const matches = {};
  for (const name of ["settings", "oauth", "onboarding"]) {
    const entry = journal.files[name];
    matches[name] = {
      baseline: recordMatches(current[name], entry.baseline),
      candidate: recordMatches(current[name], entry.candidate),
    };
    if (!matches[name].baseline && !matches[name].candidate) {
      throw new Error("persistent onboarding state does not match its journal");
    }
  }
  if (settingsInvariantFingerprint(parseSettings(current.settings)) !==
      journal.settingsInvariant) {
    throw new Error("persistent settings invariant changed during onboarding recovery");
  }
  if (current.onboarding !== undefined) parseOnboarding(current.onboarding);

  // Legal durable prefixes follow the fixed settings -> OAuth -> consumer
  // marker order. Identical old/new bytes satisfy both sides and do not count
  // as a reordered step.
  if (matches.onboarding.candidate && !matches.onboarding.baseline &&
      (!matches.settings.candidate || !matches.oauth.candidate)) {
    throw new Error("invalid onboarding transaction install order");
  }
  if (matches.oauth.candidate && !matches.oauth.baseline &&
      !matches.settings.candidate) {
    throw new Error("invalid onboarding transaction install order");
  }
  const complete = matches.settings.candidate && matches.oauth.candidate &&
    matches.onboarding.candidate;
  if (journal.phase === "committed" && !complete) {
    throw new Error("committed onboarding journal is incomplete");
  }
  if (complete) {
    parseOnboarding(current.onboarding, true);
    return journal.restartRequired ? "complete-restart" : "complete";
  }
  return "partial";
}

function syncDirectory(path) {
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeSafeTemporary(path, maximumBytes) {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== 0 ||
        stats.gid !== 0 || stats.nlink !== 1 ||
        (stats.mode & 0o777) !== 0o600 || stats.size > maximumBytes) {
      throw new Error("unsafe onboarding transaction temporary");
    }
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function writeAtomic(path, temporary, bytes, directory, maximumBytes) {
  removeSafeTemporary(temporary, maximumBytes);
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const written = secureSnapshot(temporary, maximumBytes, true);
    if (written.sha256 !== sha256(bytes) || written.size !== bytes.length) {
      throw new Error("onboarding transaction temporary verification failed");
    }
    renameSync(temporary, path);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
}

function writeRuntimeMarker(value) {
  const contents = new Map([
    ["active", "active\n"],
    ["clear", ""],
    ["init", "init\n"],
    ["partial", "partial\n"],
    ["privacy", "privacy\n"],
    ["restart", "restart\n"],
  ]);
  if (!contents.has(value)) throw new Error("invalid runtime marker state");
  const runtime = lstatSync(RUNTIME_ROOT);
  if (!runtime.isDirectory() || runtime.isSymbolicLink() || runtime.uid !== 0 ||
      runtime.gid !== 0 || (runtime.mode & 0o777) !== 0o700) {
    throw new Error("unsafe runtime control directory");
  }
  const current = lstatSync(ACTIVE_MARKER);
  if (!current.isFile() || current.isSymbolicLink() || current.uid !== 0 ||
      current.gid !== 0 || current.nlink !== 1 ||
      (current.mode & 0o777) !== 0o600 || current.size > 8) {
    throw new Error("unsafe runtime onboarding marker");
  }
  removeSafeTemporary(ACTIVE_MARKER_TMP, 8);
  const bytes = Buffer.from(contents.get(value), "utf8");
  let descriptor;
  try {
    descriptor = openSync(
      ACTIVE_MARKER_TMP,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    const written = fstatSync(descriptor);
    if (!written.isFile() || written.uid !== 0 || written.gid !== 0 ||
        written.nlink !== 1 || (written.mode & 0o777) !== 0o600 ||
        written.size !== bytes.length) {
      throw new Error("runtime onboarding marker write was unsafe");
    }
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(ACTIVE_MARKER_TMP, ACTIVE_MARKER);
    syncDirectory(RUNTIME_ROOT);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
}

function writeJournal(value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.length > MAX_JOURNAL_BYTES) throw new Error("journal is too large");
  writeAtomic(JOURNAL, JOURNAL_TMP, bytes, TRANSACTION_ROOT, MAX_JOURNAL_BYTES);
}

function buildSettingsCandidate() {
  const baselineSnapshot = secureSnapshot(REAL_SETTINGS, MAX_SETTINGS_BYTES, true);
  const stagedSnapshot = secureSnapshot(STAGED_SETTINGS, MAX_SETTINGS_BYTES, true);
  const baseline = parseSettings(baselineSnapshot);
  const staged = parseSettings(stagedSnapshot);
  if (settingsInvariantFingerprint(baseline) !== settingsInvariantFingerprint(staged)) {
    throw new Error("staged settings changed outside enableTelemetry");
  }
  const candidate = { ...baseline };
  if (Object.hasOwn(staged, "enableTelemetry")) {
    if (typeof staged.enableTelemetry !== "boolean") {
      throw new Error("staged enableTelemetry is invalid");
    }
    if (staged.enableTelemetry === false) candidate.enableTelemetry = false;
    else delete candidate.enableTelemetry;
  } else {
    delete candidate.enableTelemetry;
  }
  const bytes = nativeCanonicalSettingsContent(
    candidate,
    nativeSettingsToolPermission(baseline),
  );
  if (bytes.length > MAX_SETTINGS_BYTES ||
      settingsInvariantFingerprint(nativeParseJsonContent(bytes)) !==
        settingsInvariantFingerprint(baseline)) {
    throw new Error("trusted settings candidate changed the baseline invariant");
  }
  removeSafeTemporary(STAGED_SETTINGS_CANDIDATE, MAX_SETTINGS_BYTES);
  let descriptor;
  try {
    descriptor = openSync(
      STAGED_SETTINGS_CANDIDATE,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  // Native JSON accepts duplicate object keys. Persist only a trusted exact
  // two-key representation so ambiguous source bytes can never cross from
  // ephemeral staging into the shared identity.
  const onboardingSnapshot = secureSnapshot(
    STAGED_ONBOARDING,
    MAX_ONBOARDING_BYTES,
    true,
  );
  const onboarding = parseOnboarding(onboardingSnapshot, true);
  const onboardingBytes = Buffer.from(
    `${JSON.stringify({
      consumerOnboardingComplete: onboarding.consumerOnboardingComplete,
      enterpriseOnboardingComplete: onboarding.enterpriseOnboardingComplete,
    })}\n`,
    "utf8",
  );
  writeAtomic(
    STAGED_ONBOARDING,
    STAGED_ONBOARDING_TMP,
    onboardingBytes,
    `${STAGED_ROOT}/cache`,
    MAX_ONBOARDING_BYTES,
  );
}

function commitTransaction() {
  let existing;
  try {
    existing = parseJournal();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (existing !== undefined && transactionStatus(existing) !== "partial") {
    throw new Error("completed onboarding transaction must be finalized first");
  }

  const baseline = currentSnapshots();
  const candidate = {
    settings: secureSnapshot(
      STAGED_SETTINGS_CANDIDATE,
      MAX_SETTINGS_BYTES,
      true,
    ),
    oauth: secureSnapshot(STAGED_OAUTH, MAX_OAUTH_BYTES, true),
    onboarding: secureSnapshot(
      STAGED_ONBOARDING,
      MAX_ONBOARDING_BYTES,
      true,
    ),
  };
  const invariant = settingsInvariantFingerprint(parseSettings(baseline.settings));
  if (settingsInvariantFingerprint(parseSettings(candidate.settings)) !== invariant) {
    throw new Error("settings candidate changed the baseline invariant");
  }
  parseOnboarding(candidate.onboarding, true);

  // Publishing this no-secret journal is the durable commit decision. From
  // this point every legal crash prefix stays quarantined until a fresh,
  // validated consumer login rebases it or all three candidates are complete.
  const journal = {
    schema: 1,
    phase: "installing",
    restartRequired: existing !== undefined,
    settingsInvariant: invariant,
    files: {
      settings: { baseline: state(baseline.settings), candidate: state(candidate.settings) },
      oauth: { baseline: state(baseline.oauth), candidate: state(candidate.oauth) },
      onboarding: {
        baseline: state(baseline.onboarding),
        candidate: state(candidate.onboarding),
      },
    },
  };
  writeJournal(journal);
  if (!recordMatches(baseline.settings, journal.files.settings.candidate)) {
    writeAtomic(
      REAL_SETTINGS,
      SETTINGS_TMP,
      candidate.settings.bytes,
      REAL_ROOT,
      MAX_SETTINGS_BYTES,
    );
  }
  if (!recordMatches(baseline.oauth, journal.files.oauth.candidate)) {
    writeAtomic(
      REAL_OAUTH,
      OAUTH_TMP,
      candidate.oauth.bytes,
      REAL_ROOT,
      MAX_OAUTH_BYTES,
    );
  }
  if (!recordMatches(baseline.onboarding, journal.files.onboarding.candidate)) {
    writeAtomic(
      REAL_ONBOARDING,
      ONBOARDING_TMP,
      candidate.onboarding.bytes,
      `${REAL_ROOT}/cache`,
      MAX_ONBOARDING_BYTES,
    );
  }
  const completedStatus = journal.restartRequired
    ? "complete-restart"
    : "complete";
  if (transactionStatus(journal) !== completedStatus) {
    throw new Error("onboarding transaction did not reach a complete prefix");
  }
  journal.phase = "committed";
  writeJournal(journal);
}

function finalizeTransaction() {
  const journal = parseJournal();
  const completedStatus = journal.restartRequired
    ? "complete-restart"
    : "complete";
  if (transactionStatus(journal) !== completedStatus) {
    throw new Error("cannot finalize a partial onboarding transaction");
  }
  if (journal.phase !== "committed") {
    journal.phase = "committed";
    writeJournal(journal);
  }
  if (journal.restartRequired) requireRestart();
  unlinkSync(JOURNAL);
  syncDirectory(TRANSACTION_ROOT);
  removeSafeTemporary(JOURNAL_TMP, MAX_JOURNAL_BYTES);
  syncDirectory(TRANSACTION_ROOT);
  return journal.restartRequired ? "restart-required" : "finalized";
}

function statusTransaction() {
  let journal;
  try {
    journal = parseJournal();
  } catch (error) {
    if (!isMissing(error)) throw error;
    removeSafeTemporary(JOURNAL_TMP, MAX_JOURNAL_BYTES);
    syncDirectory(TRANSACTION_ROOT);
    return "absent";
  }
  removeSafeTemporary(JOURNAL_TMP, MAX_JOURNAL_BYTES);
  syncDirectory(TRANSACTION_ROOT);
  return transactionStatus(journal);
}

function cleanFixedTemporaries() {
  removeSafeTemporary(SETTINGS_TMP, MAX_SETTINGS_BYTES);
  removeSafeTemporary(OAUTH_TMP, MAX_OAUTH_BYTES);
  removeSafeTemporary(ONBOARDING_TMP, MAX_ONBOARDING_BYTES);
  syncDirectory(REAL_ROOT);
  syncDirectory(`${REAL_ROOT}/cache`);
}

function restartStatus() {
  const snapshot = secureSnapshot(RESTART_REQUIRED, 64);
  if (snapshot === undefined) return "absent";
  if (snapshot.bytes.toString("utf8") !== "restart\n") {
    throw new Error("invalid onboarding restart marker");
  }
  return "required";
}

function requireRestart() {
  writeAtomic(
    RESTART_REQUIRED,
    RESTART_REQUIRED_TMP,
    Buffer.from("restart\n", "utf8"),
    TRANSACTION_ROOT,
    64,
  );
}

function clearRestart() {
  if (restartStatus() === "required") {
    unlinkSync(RESTART_REQUIRED);
    syncDirectory(TRANSACTION_ROOT);
  }
  removeSafeTemporary(RESTART_REQUIRED_TMP, 64);
  syncDirectory(TRANSACTION_ROOT);
}

function main() {
  if (process.argv[2] === "marker") {
    if (process.argv.length !== 4) throw new Error("invalid invocation");
    writeRuntimeMarker(process.argv[3]);
    return;
  }
  if (process.argv.length !== 3) throw new Error("invalid invocation");
  switch (process.argv[2]) {
    case "candidate": buildSettingsCandidate(); break;
    case "commit": commitTransaction(); break;
    case "status": process.stdout.write(`${statusTransaction()}\n`); break;
    case "finalize": process.stdout.write(`${finalizeTransaction()}\n`); break;
    case "clean": cleanFixedTemporaries(); break;
    case "restart-status": process.stdout.write(`${restartStatus()}\n`); break;
    case "clear-restart": clearRestart(); break;
    default: throw new Error("invalid invocation");
  }
}

try {
  main();
} catch {
  process.stderr.write("onboarding transaction: validation failed\n");
  process.exitCode = 70;
}
