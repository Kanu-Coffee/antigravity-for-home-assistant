import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const DATA_DIRECTORY = "/data/antigravity";
const APP_DATA_DIRECTORY = "/data/antigravity-ha";
const HOME_DIRECTORY = "/data/home";
const OPTIONS_PATH = "/data/options.json";
const APP_VERSION_PATH = "/usr/local/share/antigravity-ha/app-version";
const DEFAULT_SETTINGS_PATH = "/etc/antigravity/settings.json";
const DEFAULT_MCP_CONFIG_PATH = "/etc/antigravity/mcp_config.json";
const ANTIGRAVITY_CLI_DIRECTORY = join(
  HOME_DIRECTORY,
  ".gemini",
  "antigravity-cli",
);
const GLOBAL_CONFIG_DIRECTORY = join(HOME_DIRECTORY, ".gemini", "config");
const SETTINGS_PATH = join(ANTIGRAVITY_CLI_DIRECTORY, "settings.json");
const MCP_CONFIG_PATH = join(GLOBAL_CONFIG_DIRECTORY, "mcp_config.json");
const LEGACY_CONFIG_PATH = join(DATA_DIRECTORY, "config.toml");
const LEGACY_AGENTS_PATH = join(DATA_DIRECTORY, "AGENTS.md");
const MIGRATION_DIRECTORY = join(APP_DATA_DIRECTORY, "migration");
const STATE_PATH = join(MIGRATION_DIRECTORY, "native-files-state.json");
const JOURNAL_PATH = join(MIGRATION_DIRECTORY, "native-files.json");
const BACKUPS_DIRECTORY = join(APP_DATA_DIRECTORY, "backups");
const USER_BACKUPS_DIRECTORY = join(BACKUPS_DIRECTORY, "native-files");
const QUARANTINE_DIRECTORY = join(APP_DATA_DIRECTORY, "quarantine");
const LEGACY_TELEGRAM_QUARANTINE_DIRECTORY = join(
  QUARANTINE_DIRECTORY,
  "v1-telegram",
);
const LEGACY_TELEGRAM_FILES = [
  "telegram_authorized_chats.json",
  "telegram_pair_info.json",
];
const LEGACY_STATE_PATH = join(DATA_DIRECTORY, ".native-files-update-state.json");
const LEGACY_JOURNAL_PATH = join(DATA_DIRECTORY, ".native-files-update-journal.json");
const LEGACY_BACKUPS_DIRECTORY = join(DATA_DIRECTORY, "backups");
const LEGACY_USER_BACKUPS_DIRECTORY = join(LEGACY_BACKUPS_DIRECTORY, "native-files");
const PUBLIC_V1_STATE_PATH = join(DATA_DIRECTORY, ".user-files-update-state.json");
const PUBLIC_V1_JOURNAL_PATH = join(DATA_DIRECTORY, ".user-files-update-journal.json");
const PUBLIC_V1_USER_BACKUPS_DIRECTORY = join(LEGACY_BACKUPS_DIRECTORY, "user-files");
const PUBLIC_V1_STATE_SCHEMA = 1;
const PUBLIC_V1_SCOPES = new Set(["config", "agents"]);
let activeStatePath = STATE_PATH;
let activeJournalPath = JOURNAL_PATH;
let activeBackupsDirectory = BACKUPS_DIRECTORY;
let activeUserBackupsDirectory = USER_BACKUPS_DIRECTORY;
const MAX_CONTROL_FILE_BYTES = 1024 * 1024;
const MAX_USER_FILE_BYTES = 16 * 1024 * 1024;
const STATE_SCHEMA = 2;
const TRANSACTION_PHASES = new Set([
  "prepared",
  "targets_installed",
  "state_committed",
]);
const VALID_MODES = new Set([
  "preserve",
  "refresh_managed",
  "reset_v2",
  "refresh_agents",
  "refresh_all",
]);
const VALID_SCOPES = new Set(["settings", "mcp"]);
const TOOL_PERMISSIONS = new Set([
  "request-review",
  "proceed-in-sandbox",
  "always-proceed",
  "strict",
]);
const BROWSER_POLICIES = new Set(["safe", "never", "always"]);
const PLAYWRIGHT_SAFE_TOOLS = [
  "browser_close",
  "browser_console_messages",
  "browser_hover",
  "browser_navigate",
  "browser_navigate_back",
  "browser_network_requests",
  "browser_resize",
  "browser_snapshot",
  "browser_tabs",
  "browser_take_screenshot",
  "browser_wait_for",
];
const PLAYWRIGHT_INTERACTIVE_TOOLS = [
  "browser_click",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_type",
];
const MANAGED_SETTINGS_KEYS = new Set([
  "allowNonWorkspaceAccess",
  "altScreenMode",
  "artifactReviewPolicy",
  "enableTerminalSandbox",
  "permissions",
  "showFeedbackSurvey",
  "showTips",
  "toolPermission",
]);
const HA_READ_TOOLS = [
  "ha_read_app_logs",
  "ha_read_config",
  "ha_read_core_logs",
  "ha_read_history",
  "ha_read_registry",
  "ha_read_services",
  "ha_read_state",
  "ha_read_states",
  "ha_read_system_info",
  "ha_read_traces",
];
const HA_VALIDATE_TOOLS = [
  "ha_validate_config",
  "ha_verify_state",
];
const HA_PERMISSION_RULES = {
  allow: [
    "mcp(ha_change/ha_change_propose)",
    "mcp(ha_memory/memory_search)",
    "mcp(ha_memory/memory_show)",
    "mcp(ha_memory/memory_status)",
    ...HA_READ_TOOLS.map((tool) => `mcp(ha_read/${tool})`),
    ...HA_VALIDATE_TOOLS.map((tool) => `mcp(ha_validate/${tool})`),
  ],
  ask: [
    "command(*)",
    "mcp(home-assistant/*)",
    "mcp(ha_memory/memory_remember_explicit)",
    "mcp(ha_memory/memory_propose)",
    "mcp(ha_memory/memory_add_evidence)",
    "mcp(ha_memory/memory_verify_candidate)",
    "mcp(ha_memory/memory_apply_candidate)",
    "mcp(ha_memory/memory_begin_change)",
    "mcp(ha_memory/memory_verify_change)",
    "mcp(ha_memory/memory_resolve_conflict)",
    "mcp(ha_memory/memory_rollback)",
  ],
  deny: [
    "command(sudo)",
    "command(rm -rf)",
    "write_file(.git/)",
    "read_file(/config/secrets.yaml)",
    "read_file(/config/.storage)",
    "read_file(/data)",
    "write_file(/config/secrets.yaml)",
    "write_file(/config/.storage)",
    "write_file(/data)",
  ],
};
const MANAGED_PERMISSION_RULES = new Set([
  ...HA_PERMISSION_RULES.allow,
  ...HA_PERMISSION_RULES.ask,
  ...HA_PERMISSION_RULES.deny,
  ...PLAYWRIGHT_SAFE_TOOLS.map((tool) => `mcp(playwright/${tool})`),
  ...PLAYWRIGHT_INTERACTIVE_TOOLS.map((tool) => `mcp(playwright/${tool})`),
]);

class FatalUpdateError extends Error {}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    await handle.sync();
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function inspectPath(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function assertRootOwnedRegular(path, stats) {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${path} must be a regular file and not a symbolic link`);
  }
  if (stats.uid !== 0 || stats.nlink !== 1) {
    throw new Error(`${path} must be root-owned with exactly one hard link`);
  }
}

async function readBounded(handle, maxBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) {
    throw new Error("File is larger than the supported size limit");
  }
  return Buffer.concat(chunks, total);
}

async function readSafeSnapshot(path, maxBytes = MAX_USER_FILE_BYTES) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const opened = await handle.stat();
    assertRootOwnedRegular(path, opened);
    if (opened.size > maxBytes) {
      throw new Error(`${path} is larger than the supported size limit`);
    }
    const content = await readBounded(handle, maxBytes);
    const after = await handle.stat();
    assertRootOwnedRegular(path, after);
    if (
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`${path} changed while it was read`);
    }
    return { content, mode: opened.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function readSafeFile(path, maxBytes = MAX_USER_FILE_BYTES) {
  return (await readSafeSnapshot(path, maxBytes))?.content;
}

async function chmodSafeRegular(path, mode) {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    assertRootOwnedRegular(path, opened);
    await handle.chmod(mode);
    const current = await inspectPath(path);
    if (
      !current ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      throw new Error(`${path} changed while its mode was secured`);
    }
  } finally {
    await handle.close();
  }
}

async function writeExclusive(path, value, mode) {
  const parent = dirname(path);
  let handle;
  let opened;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      mode,
    );
    opened = await handle.stat();
    assertRootOwnedRegular(path, opened);
    await handle.writeFile(value);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (opened) {
      const current = await inspectPath(path).catch(() => undefined);
      if (
        current &&
        current.dev === opened.dev &&
        current.ino === opened.ino
      ) {
        await unlink(path).catch(() => {});
      }
    }
    throw error;
  }
}

async function writeAtomic(path, value, mode) {
  const parent = dirname(path);
  const temporary = join(
    parent,
    `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      mode,
    );
    await handle.writeFile(value);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function writePrivateJson(path, value) {
  await writeAtomic(path, `${JSON.stringify(value)}\n`, 0o600);
}

async function removeSafeRegular(path) {
  const stats = await inspectPath(path);
  if (!stats) return;
  assertRootOwnedRegular(path, stats);
  await unlink(path);
  await syncDirectory(dirname(path));
}

async function securePrivateDirectory(path) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isDirectory() || before.uid !== 0) {
    throw new Error(`${path} must be a root-owned directory and not a symbolic link`);
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY |
      fsConstants.O_DIRECTORY |
      fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory() ||
      opened.uid !== 0 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error(`${path} changed during directory validation`);
    }
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await securePrivateDirectory(path);
}

async function readJson(path, optional = false) {
  const content = await readSafeFile(path, MAX_CONTROL_FILE_BYTES);
  if (content === undefined && optional) return undefined;
  if (content === undefined) throw new Error(`${path} is missing`);
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

function emptyState() {
  return {
    schema: STATE_SCHEMA,
    applied: {
      settings: [],
      mcp: [],
    },
    managed: {
      settings: {
        keys: [],
        permission_rules: [],
      },
    },
  };
}

function validateVersion(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u.test(
      value,
    )
  ) {
    throw new Error("The image App version is invalid");
  }
  return value;
}

function validateScopes(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 2 ||
    new Set(value).size !== value.length ||
    value.some((scope) => !VALID_SCOPES.has(scope))
  ) {
    throw new Error("The user-file update scope is invalid");
  }
  return value;
}

function validateState(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== STATE_SCHEMA ||
    value.applied === null ||
    typeof value.applied !== "object" ||
    Array.isArray(value.applied)
  ) {
    throw new Error("The user-file update state is invalid");
  }
  for (const scope of VALID_SCOPES) {
    const versions = value.applied[scope];
    if (
      !Array.isArray(versions) ||
      new Set(versions).size !== versions.length
    ) {
      throw new Error("The user-file update version history is invalid");
    }
    versions.forEach(validateVersion);
  }
  if (value.managed === undefined) {
    value.managed = emptyState().managed;
  }
  const managedSettings = value.managed?.settings;
  if (
    value.managed === null ||
    typeof value.managed !== "object" ||
    Array.isArray(value.managed) ||
    managedSettings === null ||
    typeof managedSettings !== "object" ||
    Array.isArray(managedSettings) ||
    !Array.isArray(managedSettings.keys) ||
    !Array.isArray(managedSettings.permission_rules) ||
    new Set(managedSettings.keys).size !== managedSettings.keys.length ||
    new Set(managedSettings.permission_rules).size !==
      managedSettings.permission_rules.length ||
    managedSettings.keys.some(
      (key) => typeof key !== "string" || !MANAGED_SETTINGS_KEYS.has(key),
    ) ||
    managedSettings.permission_rules.some(
      (rule) =>
        typeof rule !== "string" || !MANAGED_PERMISSION_RULES.has(rule),
    )
  ) {
    throw new Error("The managed settings ownership state is invalid");
  }
  return value;
}

function validateJournal(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== STATE_SCHEMA ||
    typeof value.transaction !== "string" ||
    !/^refresh-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/u.test(value.transaction) ||
    !TRANSACTION_PHASES.has(value.phase) ||
    typeof value.state_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.state_sha256)
  ) {
    throw new Error("The user-file update journal is invalid");
  }
  validateVersion(value.app_version);
  validateScopes(value.scopes);
  return value;
}

function validateMetadata(value, journal) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== STATE_SCHEMA ||
    value.app_version !== journal.app_version ||
    JSON.stringify(value.scopes) !== JSON.stringify(journal.scopes) ||
    value.files === null ||
    typeof value.files !== "object" ||
    Array.isArray(value.files) ||
    value.state === null ||
    typeof value.state !== "object" ||
    Array.isArray(value.state) ||
    typeof value.state.existed !== "boolean" ||
    !Number.isInteger(value.state.original_mode) ||
    value.state.original_mode < 0 ||
    value.state.original_mode > 0o777 ||
    typeof value.state.candidate_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.state.candidate_sha256) ||
    value.state.candidate_sha256 !== journal.state_sha256 ||
    (value.state.existed &&
      (typeof value.state.before_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(value.state.before_sha256))) ||
    (!value.state.existed && value.state.before_sha256 !== null)
  ) {
    throw new Error("The user-file update transaction metadata is invalid");
  }
  for (const scope of journal.scopes) {
    const file = value.files[scope];
    if (
      file === null ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      typeof file.existed !== "boolean" ||
      !Number.isInteger(file.original_mode) ||
      file.original_mode < 0 ||
      file.original_mode > 0o777 ||
      typeof file.candidate_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(file.candidate_sha256) ||
      (file.existed &&
        (typeof file.before_sha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(file.before_sha256)))
    ) {
      throw new Error("The user-file update file metadata is invalid");
    }
  }
  return value;
}

async function loadState() {
  const value = await readJson(activeStatePath, true);
  return value === undefined ? emptyState() : validateState(value);
}

async function loadJournal() {
  const value = await readJson(activeJournalPath, true);
  return value === undefined ? undefined : validateJournal(value);
}

function targetForScope(scope) {
  return scope === "settings" ? SETTINGS_PATH : MCP_CONFIG_PATH;
}

function candidateName(scope) {
  return `${scope}.image-default`;
}

function backupName(scope) {
  return `${scope}.before`;
}

async function loadTransaction(journal) {
  await ensurePrivateDirectory(activeBackupsDirectory);
  await ensurePrivateDirectory(activeUserBackupsDirectory);
  const transactionDirectory = join(
    activeUserBackupsDirectory,
    journal.transaction,
  );
  await securePrivateDirectory(transactionDirectory);
  const metadata = validateMetadata(
    await readJson(join(transactionDirectory, "metadata.json")),
    journal,
  );
  return { metadata, transactionDirectory };
}

async function readVerifiedTransactionFile(path, expectedHash) {
  const content = await readSafeFile(path);
  if (content === undefined || sha256(content) !== expectedHash) {
    throw new Error("A user-file update transaction file failed verification");
  }
  return content;
}

function versionApplied(state, scope, version) {
  return state.applied[scope].includes(version);
}

async function verifyInstalledTargets(transactionDirectory, metadata) {
  for (const scope of metadata.scopes) {
    const target = targetForScope(scope);
    const targetContent = await readSafeFile(target);
    if (
      targetContent === undefined ||
      sha256(targetContent) !== metadata.files[scope].candidate_sha256
    ) {
      throw new Error("A committed user-file update target failed verification");
    }
    await readVerifiedTransactionFile(
      join(transactionDirectory, candidateName(scope)),
      metadata.files[scope].candidate_sha256,
    );
  }
}

async function verifyCommittedState(transactionDirectory, metadata) {
  const stateContent = await readSafeFile(activeStatePath);
  if (
    stateContent === undefined ||
    sha256(stateContent) !== metadata.state.candidate_sha256
  ) {
    throw new Error("A committed user-file update state failed verification");
  }
  await readVerifiedTransactionFile(
    join(transactionDirectory, "state.candidate"),
    metadata.state.candidate_sha256,
  );
}

async function rollbackTransaction(transactionDirectory, metadata) {
  const prepared = {};
  const stateStats = await inspectPath(activeStatePath);
  if (stateStats) assertRootOwnedRegular(activeStatePath, stateStats);
  const currentState = await readSafeFile(activeStatePath);
  if (metadata.state.existed) {
    if (currentState === undefined) {
      throw new Error("The existing user-file update state disappeared before recovery");
    }
    const currentStateHash = sha256(currentState);
    if (
      currentStateHash !== metadata.state.before_sha256 &&
      currentStateHash !== metadata.state.candidate_sha256
    ) {
      throw new Error("The user-file update state changed before recovery");
    }
    prepared.state = await readVerifiedTransactionFile(
      join(transactionDirectory, "state.before"),
      metadata.state.before_sha256,
    );
  } else if (stateStats) {
    if (sha256(currentState) !== metadata.state.candidate_sha256) {
      throw new Error("A newly created user-file update state changed before recovery");
    }
  }

  for (const scope of metadata.scopes) {
    const file = metadata.files[scope];
    const target = targetForScope(scope);
    const targetStats = await inspectPath(target);
    if (targetStats) assertRootOwnedRegular(target, targetStats);
    if (file.existed) {
      const current = await readSafeFile(target);
      if (current === undefined) {
        throw new Error("An existing update target disappeared before recovery");
      }
      const currentHash = sha256(current);
      if (
        currentHash !== file.before_sha256 &&
        currentHash !== file.candidate_sha256
      ) {
        throw new Error("An update target changed before recovery");
      }
      prepared[scope] = await readVerifiedTransactionFile(
        join(transactionDirectory, backupName(scope)),
        file.before_sha256,
      );
    } else if (targetStats) {
      const current = await readSafeFile(target);
      if (sha256(current) !== file.candidate_sha256) {
        throw new Error("A newly created update target changed before recovery");
      }
    }
  }

  for (const scope of metadata.scopes) {
    const file = metadata.files[scope];
    const target = targetForScope(scope);
    if (file.existed) {
      await writeAtomic(target, prepared[scope], file.original_mode);
    } else {
      await removeSafeRegular(target);
    }
  }
  if (metadata.state.existed) {
    await writeAtomic(
      activeStatePath,
      prepared.state,
      metadata.state.original_mode,
    );
  } else {
    await removeSafeRegular(activeStatePath);
  }
}

async function recoverPendingTransaction() {
  let journal;
  try {
    journal = await loadJournal();
  } catch (error) {
    throw new FatalUpdateError(
      `Pending user-file update journal is unsafe: ${error.message}`,
    );
  }
  if (!journal) return "none";
  try {
    if (journal.phase === "state_committed") {
      const transaction = await loadTransaction(journal);
      try {
        await verifyInstalledTargets(
          transaction.transactionDirectory,
          transaction.metadata,
        );
        await verifyCommittedState(
          transaction.transactionDirectory,
          transaction.metadata,
        );
        await removeSafeRegular(activeJournalPath);
        return "committed";
      } catch (verificationError) {
        try {
          await rollbackTransaction(
            transaction.transactionDirectory,
            transaction.metadata,
          );
          await removeSafeRegular(activeJournalPath);
          return "rolled_back";
        } catch (rollbackError) {
          throw new Error(
            `Committed transaction verification failed (${verificationError.message}); rollback failed (${rollbackError.message})`,
          );
        }
      }
    }
    const transaction = await loadTransaction(journal);
    await rollbackTransaction(
      transaction.transactionDirectory,
      transaction.metadata,
    );
    await removeSafeRegular(activeJournalPath);
    return "rolled_back";
  } catch (error) {
    throw new FatalUpdateError(`Pending user-file update recovery failed: ${error.message}`);
  }
}

function validatePublicV1Scopes(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 2 ||
    new Set(value).size !== value.length ||
    value.some((scope) => !PUBLIC_V1_SCOPES.has(scope))
  ) {
    throw new Error("The public v1 user-file update scope is invalid");
  }
  return value;
}

function validatePublicV1State(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== PUBLIC_V1_STATE_SCHEMA ||
    value.applied === null ||
    typeof value.applied !== "object" ||
    Array.isArray(value.applied)
  ) {
    throw new Error("The public v1 user-file update state is invalid");
  }
  for (const scope of PUBLIC_V1_SCOPES) {
    const versions = value.applied[scope];
    if (
      !Array.isArray(versions) ||
      new Set(versions).size !== versions.length
    ) {
      throw new Error("The public v1 user-file version history is invalid");
    }
    versions.forEach(validateVersion);
  }
  return value;
}

function validatePublicV1Journal(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== PUBLIC_V1_STATE_SCHEMA ||
    typeof value.transaction !== "string" ||
    !/^refresh-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/u.test(value.transaction)
  ) {
    throw new Error("The public v1 user-file update journal is invalid");
  }
  validateVersion(value.app_version);
  validatePublicV1Scopes(value.scopes);
  return value;
}

function validatePublicV1Metadata(value, journal) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== PUBLIC_V1_STATE_SCHEMA ||
    value.app_version !== journal.app_version ||
    JSON.stringify(value.scopes) !== JSON.stringify(journal.scopes) ||
    value.files === null ||
    typeof value.files !== "object" ||
    Array.isArray(value.files)
  ) {
    throw new Error("The public v1 user-file transaction metadata is invalid");
  }
  for (const scope of journal.scopes) {
    const file = value.files[scope];
    if (
      file === null ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      typeof file.existed !== "boolean" ||
      !Number.isInteger(file.original_mode) ||
      file.original_mode < 0 ||
      file.original_mode > 0o777 ||
      typeof file.candidate_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(file.candidate_sha256) ||
      (file.existed &&
        (typeof file.before_sha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(file.before_sha256))) ||
      (!file.existed && file.before_sha256 !== null)
    ) {
      throw new Error("The public v1 user-file metadata entry is invalid");
    }
  }
  return value;
}

function publicV1TargetForScope(scope) {
  return scope === "config" ? LEGACY_CONFIG_PATH : LEGACY_AGENTS_PATH;
}

async function recoverPublicV1Transaction() {
  if (!(await inspectPath(PUBLIC_V1_JOURNAL_PATH))) return "none";
  try {
    const journal = validatePublicV1Journal(
      await readJson(PUBLIC_V1_JOURNAL_PATH),
    );
    const stateValue = await readJson(PUBLIC_V1_STATE_PATH, true);
    const state = validatePublicV1State(
      stateValue ?? {
        schema: PUBLIC_V1_STATE_SCHEMA,
        applied: { agents: [], config: [] },
      },
    );
    const committed = journal.scopes.every((scope) =>
      state.applied[scope].includes(journal.app_version),
    );
    if (committed) {
      await removeSafeRegular(PUBLIC_V1_JOURNAL_PATH);
      return "committed";
    }

    await ensurePrivateDirectory(LEGACY_BACKUPS_DIRECTORY);
    await ensurePrivateDirectory(PUBLIC_V1_USER_BACKUPS_DIRECTORY);
    const transactionDirectory = join(
      PUBLIC_V1_USER_BACKUPS_DIRECTORY,
      journal.transaction,
    );
    await securePrivateDirectory(transactionDirectory);
    const metadata = validatePublicV1Metadata(
      await readJson(join(transactionDirectory, "metadata.json")),
      journal,
    );
    const prepared = {};
    for (const scope of journal.scopes) {
      const file = metadata.files[scope];
      const target = publicV1TargetForScope(scope);
      const current = await readSafeFile(target);
      if (file.existed) {
        if (current === undefined) {
          throw new Error("An existing public v1 target disappeared before recovery");
        }
        const currentHash = sha256(current);
        if (
          currentHash !== file.before_sha256 &&
          currentHash !== file.candidate_sha256
        ) {
          throw new Error("A public v1 target changed before recovery");
        }
        prepared[scope] = await readVerifiedTransactionFile(
          join(transactionDirectory, backupName(scope)),
          file.before_sha256,
        );
      } else if (
        current !== undefined &&
        sha256(current) !== file.candidate_sha256
      ) {
        throw new Error("A newly created public v1 target changed before recovery");
      }
      await readVerifiedTransactionFile(
        join(transactionDirectory, candidateName(scope)),
        file.candidate_sha256,
      );
    }

    for (const scope of journal.scopes) {
      const file = metadata.files[scope];
      const target = publicV1TargetForScope(scope);
      if (file.existed) {
        await writeAtomic(target, prepared[scope], file.original_mode);
      } else {
        await removeSafeRegular(target);
      }
    }
    await removeSafeRegular(PUBLIC_V1_JOURNAL_PATH);
    return "rolled_back";
  } catch (error) {
    throw new FatalUpdateError(
      `Pending public v1 user-file recovery failed: ${error.message}`,
    );
  }
}

function usePrimaryControlPaths() {
  activeStatePath = STATE_PATH;
  activeJournalPath = JOURNAL_PATH;
  activeBackupsDirectory = BACKUPS_DIRECTORY;
  activeUserBackupsDirectory = USER_BACKUPS_DIRECTORY;
}

function useLegacyControlPaths() {
  activeStatePath = LEGACY_STATE_PATH;
  activeJournalPath = LEGACY_JOURNAL_PATH;
  activeBackupsDirectory = LEGACY_BACKUPS_DIRECTORY;
  activeUserBackupsDirectory = LEGACY_USER_BACKUPS_DIRECTORY;
}

async function migrateLegacyControlState() {
  try {
    usePrimaryControlPaths();
    const legacyJournal = await inspectPath(LEGACY_JOURNAL_PATH);
    const primaryJournal = await inspectPath(JOURNAL_PATH);
    const legacyState = await inspectPath(LEGACY_STATE_PATH);
    const primaryState = await inspectPath(STATE_PATH);
    let recovery = "none";
    let migrated = false;

    if (
      (legacyJournal && (primaryJournal || primaryState)) ||
      (primaryJournal && legacyState)
    ) {
      throw new Error(
        "Legacy and v2 user-file migration control state conflict",
      );
    }

    if (legacyJournal) {
      useLegacyControlPaths();
      recovery = await recoverPendingTransaction();
      usePrimaryControlPaths();
    }

    const legacySnapshot = await readSafeSnapshot(
      LEGACY_STATE_PATH,
      MAX_CONTROL_FILE_BYTES,
    );
    const primarySnapshot = await readSafeSnapshot(
      STATE_PATH,
      MAX_CONTROL_FILE_BYTES,
    );
    if (!legacySnapshot) return { migrated, recovery };

    validateState(JSON.parse(legacySnapshot.content.toString("utf8")));
    if (primarySnapshot) {
      validateState(JSON.parse(primarySnapshot.content.toString("utf8")));
      if (!legacySnapshot.content.equals(primarySnapshot.content)) {
        throw new Error(
          "Legacy and v2 user-file migration state files differ",
        );
      }
    } else {
      await writeExclusive(STATE_PATH, legacySnapshot.content, 0o600);
      const installed = await readSafeFile(STATE_PATH, MAX_CONTROL_FILE_BYTES);
      if (
        installed === undefined ||
        !installed.equals(legacySnapshot.content)
      ) {
        throw new Error("Migrated user-file state failed verification");
      }
    }
    await chmodSafeRegular(STATE_PATH, 0o600);
    await removeSafeRegular(LEGACY_STATE_PATH);
    migrated = true;
    return { migrated, recovery };
  } catch (error) {
    if (error instanceof FatalUpdateError) throw error;
    throw new FatalUpdateError(
      `Legacy user-file migration control state is unsafe: ${error.message}`,
    );
  } finally {
    usePrimaryControlPaths();
  }
}

async function quarantineLegacyTelegramState() {
  try {
    await ensurePrivateDirectory(QUARANTINE_DIRECTORY);
    await ensurePrivateDirectory(LEGACY_TELEGRAM_QUARANTINE_DIRECTORY);
    const quarantined = [];
    for (const filename of LEGACY_TELEGRAM_FILES) {
      const source = join(DATA_DIRECTORY, filename);
      const destination = join(
        LEGACY_TELEGRAM_QUARANTINE_DIRECTORY,
        filename,
      );
      const sourceStats = await inspectPath(source);
      const destinationStats = await inspectPath(destination);
      if (!sourceStats) {
        if (destinationStats) {
          assertRootOwnedRegular(destination, destinationStats);
          await chmodSafeRegular(destination, 0o600);
        }
        continue;
      }
      assertRootOwnedRegular(source, sourceStats);
      const sourceContent = await readSafeFile(source, MAX_CONTROL_FILE_BYTES);
      if (sourceContent === undefined) {
        throw new Error(`Legacy Telegram state disappeared for ${filename}`);
      }
      if (destinationStats) {
        assertRootOwnedRegular(destination, destinationStats);
        const destinationContent = await readSafeFile(
          destination,
          MAX_CONTROL_FILE_BYTES,
        );
        if (!sourceContent.equals(destinationContent)) {
          throw new Error(`Legacy Telegram quarantine conflict for ${filename}`);
        }
        await removeSafeRegular(source);
      } else {
        await rename(source, destination);
        await syncDirectory(DATA_DIRECTORY);
        await syncDirectory(LEGACY_TELEGRAM_QUARANTINE_DIRECTORY);
        const installed = await inspectPath(destination);
        if (
          !installed ||
          installed.dev !== sourceStats.dev ||
          installed.ino !== sourceStats.ino
        ) {
          throw new Error(`Legacy Telegram quarantine verification failed for ${filename}`);
        }
        assertRootOwnedRegular(destination, installed);
      }
      await chmodSafeRegular(destination, 0o600);
      quarantined.push(filename);
    }
    return quarantined;
  } catch (error) {
    throw new FatalUpdateError(
      `Legacy Telegram authorization state is unsafe: ${error.message}`,
    );
  }
}

async function createTransactionDirectory() {
  await ensurePrivateDirectory(activeBackupsDirectory);
  await ensurePrivateDirectory(activeUserBackupsDirectory);
  const timestamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const name = `refresh-${timestamp}-${randomBytes(6).toString("hex")}`;
    const path = join(activeUserBackupsDirectory, name);
    try {
      await mkdir(path, { mode: 0o700 });
      await syncDirectory(activeUserBackupsDirectory);
      return { name, path };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("A unique user-file backup directory could not be allocated");
}

async function preflightRefreshTargets(scopes) {
  const result = {};
  for (const scope of scopes) {
    const target = targetForScope(scope);
    const snapshot = await readSafeSnapshot(target);
    result[scope] = snapshot
      ? { existed: true, ...snapshot }
      : { existed: false, mode: 0o600 };
  }
  return result;
}

async function prepareTransaction(scopes, appVersion, defaults, stateContent) {
  const targetInfo = await preflightRefreshTargets(scopes);
  const stateInfo = await readSafeSnapshot(activeStatePath);
  const transaction = await createTransactionDirectory();
  const metadata = {
    schema: STATE_SCHEMA,
    app_version: appVersion,
    scopes,
    state: {
      existed: stateInfo !== undefined,
      original_mode: stateInfo?.mode ?? 0o600,
      before_sha256: stateInfo ? sha256(stateInfo.content) : null,
      candidate_sha256: sha256(stateContent),
    },
    files: {},
  };

  if (stateInfo) {
    await writeAtomic(
      join(transaction.path, "state.before"),
      stateInfo.content,
      0o600,
    );
    await readVerifiedTransactionFile(
      join(transaction.path, "state.before"),
      metadata.state.before_sha256,
    );
  }
  await writeAtomic(
    join(transaction.path, "state.candidate"),
    stateContent,
    0o600,
  );
  await readVerifiedTransactionFile(
    join(transaction.path, "state.candidate"),
    metadata.state.candidate_sha256,
  );

  for (const scope of scopes) {
    const file = {
      existed: targetInfo[scope].existed,
      original_mode: targetInfo[scope].mode,
      before_sha256: null,
      candidate_sha256: sha256(defaults[scope]),
    };
    if (file.existed) {
      const current = targetInfo[scope].content;
      file.before_sha256 = sha256(current);
      await writeAtomic(
        join(transaction.path, backupName(scope)),
        current,
        0o600,
      );
      const backup = await readSafeFile(join(transaction.path, backupName(scope)));
      if (sha256(backup) !== file.before_sha256) {
        throw new Error("A user-file backup failed verification");
      }
    }
    await writeAtomic(
      join(transaction.path, candidateName(scope)),
      defaults[scope],
      0o600,
    );
    metadata.files[scope] = file;
  }
  await writePrivateJson(join(transaction.path, "metadata.json"), metadata);
  return { metadata, transaction };
}

async function installTransaction(transactionDirectory, metadata) {
  for (const scope of metadata.scopes) {
    const file = metadata.files[scope];
    const target = targetForScope(scope);
    const current = await readSafeFile(target);
    if (
      (file.existed &&
        (current === undefined || sha256(current) !== file.before_sha256)) ||
      (!file.existed && current !== undefined)
    ) {
      throw new Error("A user-file update target changed after backup");
    }
  }

  for (const scope of metadata.scopes) {
    const candidate = await readVerifiedTransactionFile(
      join(transactionDirectory, candidateName(scope)),
      metadata.files[scope].candidate_sha256,
    );
    await writeAtomic(
      targetForScope(scope),
      candidate,
      0o600,
    );
  }
  await verifyInstalledTargets(transactionDirectory, metadata);
}

async function performRefresh(
  scopes,
  appVersion,
  defaults,
  state,
  appliedScopes = scopes,
) {
  let journalWritten = false;
  let prepared;
  try {
    for (const scope of appliedScopes) {
      if (!scopes.includes(scope)) {
        throw new Error("An applied user-file scope was not part of the transaction");
      }
      if (!versionApplied(state, scope, appVersion)) {
        state.applied[scope].push(appVersion);
      }
    }
    const stateContent = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
    prepared = await prepareTransaction(
      scopes,
      appVersion,
      defaults,
      stateContent,
    );
    const journal = {
      schema: STATE_SCHEMA,
      app_version: appVersion,
      phase: "prepared",
      scopes,
      state_sha256: sha256(stateContent),
      transaction: prepared.transaction.name,
    };
    await writePrivateJson(activeJournalPath, journal);
    journalWritten = true;
    await installTransaction(prepared.transaction.path, prepared.metadata);
    journal.phase = "targets_installed";
    await writePrivateJson(activeJournalPath, journal);
    await writePrivateJson(activeStatePath, state);
    journal.phase = "state_committed";
    await writePrivateJson(activeJournalPath, journal);
    await verifyInstalledTargets(prepared.transaction.path, prepared.metadata);
    await verifyCommittedState(prepared.transaction.path, prepared.metadata);
    await removeSafeRegular(activeJournalPath);
    return prepared.transaction.path;
  } catch (error) {
    if (journalWritten) {
      try {
        const recovery = await recoverPendingTransaction();
        if (recovery === "committed") return prepared.transaction.path;
      } catch (recoveryError) {
        throw new FatalUpdateError(recoveryError.message);
      }
    }
    throw new Error(`User-file update was not applied: ${error.message}`);
  }
}

function parseOptions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("App options must be a JSON object");
  }
  const requestedMode = value.antigravity_user_files_update_mode ?? "preserve";
  if (typeof requestedMode !== "string" || !VALID_MODES.has(requestedMode)) {
    throw new Error("antigravity_user_files_update_mode is invalid");
  }

  const mode =
    requestedMode === "refresh_agents"
      ? "refresh_managed"
      : requestedMode === "refresh_all"
        ? "refresh_managed"
        : requestedMode;

  const migrationWarnings = [];
  if (requestedMode === "refresh_agents" || requestedMode === "refresh_all") {
    migrationWarnings.push(
      `Legacy ${requestedMode} mode was mapped to refresh_managed`,
    );
  }

  let toolPermission = value.antigravity_tool_permission;
  if (toolPermission === undefined) {
    if (value.antigravity_approval_policy === undefined) {
      toolPermission = "request-review";
    } else {
      const legacyMapping = {
        untrusted: "strict",
        "on-request": "request-review",
        never: "request-review",
      };
      toolPermission = legacyMapping[value.antigravity_approval_policy];
      migrationWarnings.push(
        "Legacy antigravity_approval_policy was conservatively mapped to a native tool permission",
      );
    }
  }
  if (typeof toolPermission !== "string" || !TOOL_PERMISSIONS.has(toolPermission)) {
    throw new Error("antigravity_tool_permission is invalid");
  }

  let terminalSandbox = value.antigravity_terminal_sandbox;
  if (terminalSandbox === undefined) {
    if (value.antigravity_sandbox_mode === undefined) {
      terminalSandbox = true;
    } else {
      const legacySandbox = value.antigravity_sandbox_mode;
      if (!new Set(["workspace-write", "danger-full-access"]).has(legacySandbox)) {
        throw new Error("antigravity_sandbox_mode is invalid");
      }
      terminalSandbox = true;
      migrationWarnings.push(
        "Legacy antigravity_sandbox_mode was conservatively mapped to terminal sandboxing enabled",
      );
    }
  }
  if (typeof terminalSandbox !== "boolean") {
    throw new Error("antigravity_terminal_sandbox is invalid");
  }

  const browserPolicy = value.browser_approval_policy ?? "safe";
  if (typeof browserPolicy !== "string" || !BROWSER_POLICIES.has(browserPolicy)) {
    throw new Error("browser_approval_policy is invalid");
  }
  if (value.browser_approval_policy !== undefined) {
    migrationWarnings.push(
      "Legacy browser_approval_policy was retired; the v2 safe browser policy was applied",
    );
  }
  if (value.antigravity_token !== undefined) {
    migrationWarnings.push(
      "Legacy antigravity_token was not imported; native Google OAuth is required",
    );
  }
  if (value.home_assistant_browser_token !== undefined) {
    migrationWarnings.push(
      "Legacy home_assistant_browser_token was not migrated; managed browser identity must be revalidated",
    );
  }
  if (value.telegram_allowed_chat_ids !== undefined) {
    migrationWarnings.push(
      "Legacy Telegram chat IDs were preserved in App options but require a v2 user allowlist or new private pairing",
    );
  }

  return {
    migrationWarnings,
    mode,
    requestedMode,
    terminalSandbox,
    toolPermission,
  };
}

function parseTemplate(content, name) {
  if (content === undefined) {
    throw new FatalUpdateError(`The image default ${name} is missing`);
  }
  let value;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    throw new FatalUpdateError(`The image default ${name} is not valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FatalUpdateError(`The image default ${name} must be a JSON object`);
  }
  return value;
}

function browserPermissionRules() {
  const safe = PLAYWRIGHT_SAFE_TOOLS.map((tool) => `mcp(playwright/${tool})`);
  const interactive = PLAYWRIGHT_INTERACTIVE_TOOLS.map(
    (tool) => `mcp(playwright/${tool})`,
  );
  return { allow: safe, ask: interactive };
}

function defaultSettings(template, options) {
  const value = parseTemplate(template, "settings.json");
  const browserPermissions = browserPermissionRules();
  value.toolPermission = options.toolPermission;
  value.enableTerminalSandbox = options.terminalSandbox;
  value.permissions = {
    allow: [
      ...HA_PERMISSION_RULES.allow,
      ...browserPermissions.allow,
    ],
    deny: [...HA_PERMISSION_RULES.deny],
    ask: [
      ...HA_PERMISSION_RULES.ask,
      ...browserPermissions.ask,
    ],
  };
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseSettings(content, name) {
  let value;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value;
}

function permissionRules(value, name) {
  const rules = [];
  if (
    value.permissions === null ||
    typeof value.permissions !== "object" ||
    Array.isArray(value.permissions)
  ) {
    throw new Error(`${name} permissions must be a JSON object`);
  }
  for (const bucket of ["allow", "ask", "deny"]) {
    const entries = value.permissions[bucket];
    if (
      !Array.isArray(entries) ||
      entries.some((entry) => typeof entry !== "string")
    ) {
      throw new Error(`${name} permissions.${bucket} must be a string array`);
    }
    rules.push(...entries);
  }
  return rules;
}

function settingsOwnership(defaultContent) {
  const value = parseSettings(defaultContent, "The image default settings.json");
  const keys = Object.keys(value).filter((key) => MANAGED_SETTINGS_KEYS.has(key));
  if (!keys.includes("permissions")) {
    throw new FatalUpdateError(
      "The image default settings.json is missing managed permissions",
    );
  }
  const rules = permissionRules(value, "The image default settings.json");
  if (rules.some((rule) => !MANAGED_PERMISSION_RULES.has(rule))) {
    throw new FatalUpdateError(
      "The image default settings.json contains an unregistered managed permission",
    );
  }
  return {
    keys,
    permission_rules: [...new Set(rules)],
  };
}

function mergeManagedSettings(currentContent, defaultContent, ownership) {
  const current = parseSettings(currentContent, "Existing settings.json");
  const desired = parseSettings(defaultContent, "The image default settings.json");
  const merged = { ...current };

  for (const key of ownership.keys) {
    if (key === "permissions") continue;
    if (!Object.hasOwn(desired, key)) {
      throw new Error(`The managed settings key ${key} has no image default`);
    }
    merged[key] = desired[key];
  }

  if (ownership.keys.includes("permissions")) {
    permissionRules(current, "Existing settings.json");
    permissionRules(desired, "The image default settings.json");
    const previouslyManaged = new Set(ownership.permission_rules);
    const permissions = { ...current.permissions };
    for (const bucket of ["allow", "ask", "deny"]) {
      const userRules = current.permissions[bucket].filter(
        (rule) => !previouslyManaged.has(rule),
      );
      permissions[bucket] = [
        ...new Set([...userRules, ...desired.permissions[bucket]]),
      ];
    }
    merged.permissions = permissions;
  }

  return Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

function defaultMcpConfig(template) {
  const value = parseTemplate(template, "mcp_config.json");
  if (
    value.mcpServers === null ||
    typeof value.mcpServers !== "object" ||
    Array.isArray(value.mcpServers)
  ) {
    throw new FatalUpdateError(
      "The image default mcp_config.json must contain an mcpServers object",
    );
  }
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function preflightDefaultTargets() {
  const targets = {};
  const warnings = [];
  for (const scope of VALID_SCOPES) {
    const target = targetForScope(scope);
    const stats = await inspectPath(target);
    if (!stats) {
      targets[scope] = { existed: false };
      continue;
    }
    assertRootOwnedRegular(target, stats);
    targets[scope] = { existed: true };
  }

  if ((await inspectPath(LEGACY_CONFIG_PATH)) || (await inspectPath(LEGACY_AGENTS_PATH))) {
    warnings.push(
      "Legacy config.toml or AGENTS.md was preserved but is not loaded by Antigravity 1.1.11",
    );
  }
  return { targets, warnings };
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("user-files-update.mjs does not accept command-line arguments");
  }
  await ensurePrivateDirectory(DATA_DIRECTORY);
  await ensurePrivateDirectory(APP_DATA_DIRECTORY);
  await ensurePrivateDirectory(MIGRATION_DIRECTORY);
  await ensurePrivateDirectory(BACKUPS_DIRECTORY);
  await ensurePrivateDirectory(QUARANTINE_DIRECTORY);
  await ensurePrivateDirectory(HOME_DIRECTORY);
  await ensurePrivateDirectory(join(HOME_DIRECTORY, ".gemini"));
  await ensurePrivateDirectory(ANTIGRAVITY_CLI_DIRECTORY);
  await ensurePrivateDirectory(GLOBAL_CONFIG_DIRECTORY);
  const appVersionFile = await readSafeFile(APP_VERSION_PATH, 128);
  if (appVersionFile === undefined) {
    throw new FatalUpdateError("The image App version file is missing");
  }
  const appVersion = validateVersion(
    appVersionFile.toString("utf8").trim(),
  );
  const options = parseOptions(await readJson(OPTIONS_PATH));
  const publicV1Recovery = await recoverPublicV1Transaction();
  const legacyControl = await migrateLegacyControlState();
  const quarantinedTelegramFiles = await quarantineLegacyTelegramState();
  const recovery = await recoverPendingTransaction();
  const recovered =
    publicV1Recovery !== "none" ||
    legacyControl.recovery !== "none" ||
    recovery !== "none";
  let state;
  try {
    state = await loadState();
  } catch (error) {
    if (await inspectPath(activeJournalPath)) {
      throw new FatalUpdateError(
        `Pending user-file update state is unsafe: ${error.message}`,
      );
    }
    throw error;
  }

  const settingsTemplate = await readSafeFile(DEFAULT_SETTINGS_PATH);
  const mcpTemplate = await readSafeFile(DEFAULT_MCP_CONFIG_PATH);
  const defaults = {
    settings: defaultSettings(settingsTemplate, options),
    mcp: defaultMcpConfig(mcpTemplate),
  };
  const preflight = await preflightDefaultTargets();
  const warnings = [...options.migrationWarnings, ...preflight.warnings];
  if (legacyControl.migrated) {
    warnings.push(
      "Migrated legacy user-file control state to the v2 migration directory",
    );
  }
  if (publicV1Recovery !== "none") {
    warnings.push(
      "Recovered a pending public v1 user-file transaction before native v2 setup",
    );
  }
  if (quarantinedTelegramFiles.length > 0) {
    warnings.push(
      "Quarantined legacy Telegram pairing and authorization state; v2 authorization is required",
    );
  }
  const desiredOwnership = settingsOwnership(defaults.settings);
  const managedRefreshRequested = new Set(["refresh_managed", "reset_v2"]).has(
    options.mode,
  );
  const created = [];
  const candidates = {};
  let backupDirectory = null;
  let scopes = [];
  const refreshed = [];

  if (
    preflight.targets.settings.existed &&
    managedRefreshRequested &&
    !versionApplied(state, "settings", appVersion) &&
    state.managed.settings.keys.length === 0
  ) {
    const conflict =
      "Existing settings.json has no App ownership state and was preserved";
    if (options.mode === "reset_v2") throw new Error(conflict);
    warnings.push(conflict);
  }

  if (!preflight.targets.settings.existed) {
    created.push("settings");
    candidates.settings = defaults.settings;
    state.managed.settings = desiredOwnership;
  } else if (
    managedRefreshRequested &&
    !versionApplied(state, "settings", appVersion) &&
    state.managed.settings.keys.length > 0
  ) {
    const currentSettings = await readSafeFile(SETTINGS_PATH);
    if (currentSettings === undefined) {
      throw new Error("Existing settings.json disappeared before managed merge");
    }
    candidates.settings = mergeManagedSettings(
      currentSettings,
      defaults.settings,
      state.managed.settings,
    );
    state.managed.settings = desiredOwnership;
    refreshed.push("settings");
  }

  if (!preflight.targets.mcp.existed) {
    created.push("mcp");
    candidates.mcp = defaults.mcp;
  }

  scopes = [...new Set([...created, ...refreshed])].filter((scope) =>
    VALID_SCOPES.has(scope),
  );
  if (scopes.length > 0) {
    const appliedScopes =
      refreshed.includes("settings") ||
        (managedRefreshRequested && created.includes("settings"))
        ? ["settings"]
        : [];
    const transactionDirectory = await performRefresh(
      scopes,
      appVersion,
      candidates,
      state,
      appliedScopes,
    );
    if (scopes.some((scope) => preflight.targets[scope].existed)) {
      backupDirectory = transactionDirectory;
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      app_version: appVersion,
      backup_directory: backupDirectory,
      created,
      mode: options.mode,
      requested_mode: options.requestedMode,
      recovered,
      refreshed,
      warnings,
    })}\n`,
  );
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : "Unknown user-file update failure";
  process.stderr.write(`antigravity user-file update error: ${message}\n`);
  process.exitCode = error instanceof FatalUpdateError ? 30 : 20;
});
