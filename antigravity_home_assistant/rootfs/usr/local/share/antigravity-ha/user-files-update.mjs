import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  TELEGRAM_MANAGED_SECURITY_KEYS,
  TELEGRAM_SETTINGS_MAX_BYTES,
  assertTelegramPermissionBoundary,
} from "./telegram-permission-policy.mjs";

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
const BACKUP_MANIFEST_SCHEMA = 1;
const BACKUP_OWNER = "antigravity-for-home-assistant";
const BACKUP_KIND = "native-files-refresh";
const BACKUP_RETENTION = 2;
const TRANSACTION_PATTERN =
  /^refresh-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/u;
const PRUNE_QUARANTINE_PATTERN =
  /^\.(refresh-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12})\.prune-[0-9a-f]{12}$/u;
const BACKUP_CHILDREN = new Set([
  "completed.json",
  "manifest.json",
  "metadata.json",
  "mcp.before",
  "mcp.image-default",
  "settings.before",
  "settings.image-default",
  "state.before",
  "state.candidate",
]);
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
const PLAYWRIGHT_READ_ONLY_TOOLS = [
  "browser_console_messages",
  "browser_network_requests",
  "browser_snapshot",
  "browser_take_screenshot",
];
// Public 2.0.6 through 2.0.10 classified these navigation and UI-state tools
// as "safe" even though the pinned Playwright MCP declares them readOnly:false.
// Keep the exact legacy set only for ownership recognition so upgrades can
// retire it without mistaking App-owned rules for user policy.
const PLAYWRIGHT_LEGACY_SAFE_TOOLS = [
  "browser_close",
  ...PLAYWRIGHT_READ_ONLY_TOOLS,
  "browser_hover",
  "browser_navigate",
  "browser_navigate_back",
  "browser_resize",
  "browser_tabs",
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
  "ha_read_storage_usage",
  "ha_read_system_info",
  "ha_read_traces",
];
// Keep published ownership fingerprints immutable. New read tools belong in
// HA_READ_TOOLS, but must not be retroactively added to the exact 2.0.6/2.0.8
// layouts used to prove that a preserve-mode migration owns the old rules.
const LEGACY_2_0_6_2_0_8_HA_READ_TOOLS = [
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
// Telegram and the interactive CLI intentionally share this native HOME and
// one native permission policy. Only bounded reads and the two proposal-only
// MCPs may run unattended. Direct writes, commands, URL tools, and mutation
// MCPs are absent from both allow and ask so the model cannot mistake a native
// headless prompt failure for the Telegram approval path. The request-review
// default remains defense in depth if guidance is violated, but the model must
// register each side effect through the trusted Telegram proposal path.
// User-owned rules are preserved by the managed merge, and deny remains
// stronger than ask and allow.
const SAFE_NATIVE_READ_PERMISSION_RULES = [
  "read_file(/config)",
  "read_file(/data/home/.gemini/config)",
  "read_file(/data/home/.gemini/antigravity-cli/agents)",
  "read_file(/data/home/.gemini/antigravity-cli/plugins)",
  "read_file(/data/home/.gemini/antigravity-cli/skills)",
  "read_file(/data/home/.gemini/GEMINI.md)",
  "read_file(/data/home/.gemini/antigravity-cli/settings.json)",
];
const LEGACY_V3_SHARED_NATIVE_FILE_RULES = [
  "read_file(/config)",
  "write_file(/config)",
  "read_file(/data/home/.gemini/config)",
  "write_file(/data/home/.gemini/config)",
  "read_file(/data/home/.gemini/antigravity-cli/agents)",
  "write_file(/data/home/.gemini/antigravity-cli/agents)",
  "read_file(/data/home/.gemini/antigravity-cli/plugins)",
  "write_file(/data/home/.gemini/antigravity-cli/plugins)",
  "read_file(/data/home/.gemini/antigravity-cli/skills)",
  "write_file(/data/home/.gemini/antigravity-cli/skills)",
  "read_file(/data/home/.gemini/GEMINI.md)",
  "write_file(/data/home/.gemini/GEMINI.md)",
  "read_file(/data/home/.gemini/antigravity-cli/settings.json)",
];
const LEGACY_SHARED_NATIVE_FILE_RULES = [
  ...LEGACY_V3_SHARED_NATIVE_FILE_RULES,
  // Public 2.0.8 managed this write grant. It is migration source state only:
  // allowing the model to rewrite its own deny policy would make the OAuth and
  // sensitive-path boundary self-removable.
  "write_file(/data/home/.gemini/antigravity-cli/settings.json)",
];
const PRE_V3_HA_PERMISSION_RULES = {
  allow: [
    ...LEGACY_SHARED_NATIVE_FILE_RULES,
    "mcp(ha_change/ha_change_propose)",
    "mcp(ha_memory/memory_search)",
    "mcp(ha_memory/memory_show)",
    "mcp(ha_memory/memory_status)",
    ...LEGACY_2_0_6_2_0_8_HA_READ_TOOLS.map(
      (tool) => `mcp(ha_read/${tool})`,
    ),
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
    "write_file(/config/secrets.yaml)",
    "write_file(/config/.storage)",
  ],
};
const SAFE_MCP_PERMISSION_RULES = [
  "mcp(ha_change/ha_change_propose)",
  "mcp(telegram_action/telegram_action_propose)",
  "mcp(ha_memory/memory_search)",
  "mcp(ha_memory/memory_show)",
  "mcp(ha_memory/memory_status)",
  ...HA_READ_TOOLS.map((tool) => `mcp(ha_read/${tool})`),
  ...HA_VALIDATE_TOOLS.map((tool) => `mcp(ha_validate/${tool})`),
];
const LEGACY_V3_SENSITIVE_DENY_PERMISSION_RULES = [
  // The shared runtime must read its own settings/OAuth state, but a model
  // must not rewrite the permission policy that confines its built-in tools.
  "write_file(/data/home/.gemini/antigravity-cli/settings.json)",
  "read_file(/data/options.json)",
  "write_file(/data/options.json)",
  "read_file(/run/antigravity-ha/supervisor.token)",
  "write_file(/run/antigravity-ha/supervisor.token)",
  "read_file(/run/antigravity-ha/home-assistant-browser.token)",
  "write_file(/run/antigravity-ha/home-assistant-browser.token)",
  "read_file(/config/secrets.yaml)",
  "write_file(/config/secrets.yaml)",
  "read_file(/config/.storage)",
  "write_file(/config/.storage)",
  "read_file(/config/.ssh)",
  "write_file(/config/.ssh)",
  "read_file(/data/home/.ssh)",
  "write_file(/data/home/.ssh)",
  "read_file(/data/home/.aws)",
  "write_file(/data/home/.aws)",
  "read_file(/data/home/.azure)",
  "write_file(/data/home/.azure)",
  "read_file(/data/home/.config/gcloud)",
  "write_file(/data/home/.config/gcloud)",
  "read_file(/data/home/.kube)",
  "write_file(/data/home/.kube)",
  "read_file(/data/home/.docker/config.json)",
  "write_file(/data/home/.docker/config.json)",
  "read_file(/data/home/.netrc)",
  "write_file(/data/home/.netrc)",
  "read_file(/data/home/.npmrc)",
  "write_file(/data/home/.npmrc)",
  "read_file(/root/.ssh)",
  "write_file(/root/.ssh)",
];
const SENSITIVE_DENY_PERMISSION_RULES = [
  ...LEGACY_V3_SENSITIVE_DENY_PERMISSION_RULES,
  "read_file(/data/home/.gemini/config/mcp_config.json)",
  "write_file(/data/home/.gemini/config/mcp_config.json)",
];
const HA_PERMISSION_RULES = {
  allow: [
    ...SAFE_NATIVE_READ_PERMISSION_RULES,
    ...SAFE_MCP_PERMISSION_RULES,
  ],
  ask: [],
  deny: [...SENSITIVE_DENY_PERMISSION_RULES],
};
const LEGACY_V3_PERMISSION_RULES = {
  allow: [
    ...LEGACY_V3_SHARED_NATIVE_FILE_RULES,
    "read_url(*)",
    "execute_url(*)",
    "command(*)",
    "mcp(*)",
    ...PLAYWRIGHT_LEGACY_SAFE_TOOLS.map((tool) => `mcp(playwright/${tool})`),
    ...PLAYWRIGHT_INTERACTIVE_TOOLS.map(
      (tool) => `mcp(playwright/${tool})`,
    ),
  ],
  ask: [],
  deny: [...LEGACY_V3_SENSITIVE_DENY_PERMISSION_RULES],
};
const LEGACY_SHARED_NATIVE_FILE_RULE_SET = new Set(
  LEGACY_SHARED_NATIVE_FILE_RULES,
);
const LEGACY_2_0_6_PERMISSION_RULES = {
  allow: [
    ...PRE_V3_HA_PERMISSION_RULES.allow.filter(
      (rule) => !LEGACY_SHARED_NATIVE_FILE_RULE_SET.has(rule),
    ),
    ...PLAYWRIGHT_LEGACY_SAFE_TOOLS.map((tool) => `mcp(playwright/${tool})`),
  ],
  ask: [
    ...PRE_V3_HA_PERMISSION_RULES.ask,
    ...PLAYWRIGHT_INTERACTIVE_TOOLS.map((tool) => `mcp(playwright/${tool})`),
  ],
  deny: [
    ...PRE_V3_HA_PERMISSION_RULES.deny,
    "read_file(/data)",
    "write_file(/data)",
  ],
};
const LEGACY_2_0_8_PERMISSION_RULES = {
  allow: [
    ...PRE_V3_HA_PERMISSION_RULES.allow,
    ...PLAYWRIGHT_LEGACY_SAFE_TOOLS.map((tool) => `mcp(playwright/${tool})`),
  ],
  ask: [
    ...PRE_V3_HA_PERMISSION_RULES.ask,
    ...PLAYWRIGHT_INTERACTIVE_TOOLS.map((tool) => `mcp(playwright/${tool})`),
  ],
  deny: [...PRE_V3_HA_PERMISSION_RULES.deny],
};
const LEGACY_2_0_6_MANAGED_SETTINGS_KEYS = [
  "altScreenMode",
  "toolPermission",
  "artifactReviewPolicy",
  "allowNonWorkspaceAccess",
  "enableTerminalSandbox",
  "showTips",
  "showFeedbackSurvey",
  "permissions",
];
const LEGACY_2_0_6_PERMISSION_RULE_SET = new Set([
  ...LEGACY_2_0_6_PERMISSION_RULES.allow,
  ...LEGACY_2_0_6_PERMISSION_RULES.ask,
  ...LEGACY_2_0_6_PERMISSION_RULES.deny,
]);
const MANAGED_PERMISSION_RULES = new Set([
  ...HA_PERMISSION_RULES.allow,
  ...HA_PERMISSION_RULES.ask,
  ...HA_PERMISSION_RULES.deny,
  ...PLAYWRIGHT_READ_ONLY_TOOLS.map((tool) => `mcp(playwright/${tool})`),
]);
const RETIRED_MANAGED_PERMISSION_RULES = new Set([
  // 2.0.6 used these recursive parent denies.  Keep recognizing them only in
  // ownership state so an upgrade can remove them during the managed merge.
  "read_file(/data)",
  "write_file(/data)",
  // 2.0.7/2.0.8 enumerated image tools and placed mutation-capable tools in
  // ask.  v3 replaces that layout with supported-action wildcards so a
  // headless Telegram request cannot be auto-denied merely because a user
  // installed a new global plugin or agent.
  ...LEGACY_2_0_8_PERMISSION_RULES.allow,
  ...LEGACY_2_0_8_PERMISSION_RULES.ask,
  ...LEGACY_2_0_8_PERMISSION_RULES.deny,
  // 2.0.9/2.0.10 broadly allowed every command, URL, MCP, native write, and
  // interactive browser action. Recognize that exact App-owned layout so a
  // preserve-mode upgrade can atomically retire it without claiming user rules.
  ...LEGACY_V3_PERMISSION_RULES.allow,
  ...LEGACY_V3_PERMISSION_RULES.ask,
  ...LEGACY_V3_PERMISSION_RULES.deny,
  // Pre-release 2.0.7 candidates briefly managed individual App skill reads.
  // Recognizing them makes interrupted candidate upgrades converge safely.
  ...[
    "ha-change-proposal",
    "ha-dashboard",
    "ha-feedback",
    "ha-memory",
    "home-assistant-operations",
  ].map(
    (skill) =>
      `read_file(/data/home/.gemini/config/plugins/home-assistant/skills/${skill}/SKILL.md)`,
  ),
]);
const REGISTERED_MANAGED_PERMISSION_RULES = new Set([
  ...MANAGED_PERMISSION_RULES,
  ...RETIRED_MANAGED_PERMISSION_RULES,
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
        typeof rule !== "string" ||
        !REGISTERED_MANAGED_PERMISSION_RULES.has(rule),
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
    !TRANSACTION_PATTERN.test(value.transaction) ||
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

function validateIsoTimestamp(value, label) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`${label} timestamp is invalid`);
  }
  return milliseconds;
}

function validateBackupManifest(value, transaction) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== BACKUP_MANIFEST_SCHEMA ||
    value.owner !== BACKUP_OWNER ||
    value.kind !== BACKUP_KIND ||
    value.transaction !== transaction ||
    value.state_path !== STATE_PATH ||
    value.target_root !== HOME_DIRECTORY ||
    typeof value.metadata_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.metadata_sha256) ||
    typeof value.state_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.state_sha256)
  ) {
    throw new Error("A user-file backup manifest is not App-owned");
  }
  validateVersion(value.app_version);
  validateScopes(value.scopes);
  validateIsoTimestamp(value.created_at, "Backup creation");
  return value;
}

function validateBackupCompletion(value, manifest) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== BACKUP_MANIFEST_SCHEMA ||
    value.owner !== BACKUP_OWNER ||
    value.kind !== BACKUP_KIND ||
    value.transaction !== manifest.transaction ||
    value.metadata_sha256 !== manifest.metadata_sha256 ||
    !new Set(["committed", "rolled_back"]).has(value.outcome)
  ) {
    throw new Error("A user-file backup completion marker is not App-owned");
  }
  return validateIsoTimestamp(value.completed_at, "Backup completion");
}

async function readOwnedBackupFile(path) {
  const snapshot = await readSafeSnapshot(path, MAX_CONTROL_FILE_BYTES);
  if (snapshot === undefined || snapshot.mode !== 0o600) {
    throw new Error("A user-file backup control file is unsafe");
  }
  return snapshot.content;
}

async function readOwnedBackupPayload(path, expectedHash) {
  const snapshot = await readSafeSnapshot(path);
  if (
    snapshot === undefined ||
    snapshot.mode !== 0o600 ||
    sha256(snapshot.content) !== expectedHash
  ) {
    throw new Error("A user-file backup payload is unsafe or failed verification");
  }
  return snapshot.content;
}

async function inspectCompletedBackup(path, transaction) {
  const rootStats = await lstat(path);
  if (
    rootStats.isSymbolicLink() ||
    !rootStats.isDirectory() ||
    rootStats.uid !== 0 ||
    (rootStats.mode & 0o777) !== 0o700
  ) {
    throw new Error("A user-file backup root is unsafe");
  }
  const names = (await readdir(path)).sort();
  if (
    names.length < 4 ||
    new Set(names).size !== names.length ||
    names.some((name) => !BACKUP_CHILDREN.has(name))
  ) {
    throw new Error("A user-file backup contains an unexpected path");
  }
  const manifestContent = await readOwnedBackupFile(join(path, "manifest.json"));
  let manifest;
  try {
    manifest = validateBackupManifest(
      JSON.parse(manifestContent.toString("utf8")),
      transaction,
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("A user-file backup manifest is invalid JSON");
    }
    throw error;
  }
  const metadataContent = await readOwnedBackupFile(join(path, "metadata.json"));
  if (sha256(metadataContent) !== manifest.metadata_sha256) {
    throw new Error("A user-file backup metadata digest is invalid");
  }
  let metadata;
  try {
    metadata = validateMetadata(JSON.parse(metadataContent.toString("utf8")), {
      app_version: manifest.app_version,
      scopes: manifest.scopes,
      state_sha256: manifest.state_sha256,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("A user-file backup metadata file is invalid JSON");
    }
    throw error;
  }
  if (
    Object.keys(metadata.files).sort().join("\0") !==
      [...manifest.scopes].sort().join("\0")
  ) {
    throw new Error("A user-file backup has unexpected file metadata");
  }
  const expectedNames = new Set([
    "completed.json",
    "manifest.json",
    "metadata.json",
    "state.candidate",
  ]);
  if (metadata.state.existed) expectedNames.add("state.before");
  await readOwnedBackupPayload(
    join(path, "state.candidate"),
    metadata.state.candidate_sha256,
  );
  if (metadata.state.existed) {
    await readOwnedBackupPayload(
      join(path, "state.before"),
      metadata.state.before_sha256,
    );
  }
  for (const scope of manifest.scopes) {
    expectedNames.add(candidateName(scope));
    await readOwnedBackupPayload(
      join(path, candidateName(scope)),
      metadata.files[scope].candidate_sha256,
    );
    if (metadata.files[scope].existed) {
      expectedNames.add(backupName(scope));
      await readOwnedBackupPayload(
        join(path, backupName(scope)),
        metadata.files[scope].before_sha256,
      );
    }
  }
  if (
    names.length !== expectedNames.size ||
    names.some((name) => !expectedNames.has(name))
  ) {
    throw new Error("A user-file backup is incomplete or contains extra files");
  }
  const completionContent = await readOwnedBackupFile(join(path, "completed.json"));
  let completion;
  try {
    completion = JSON.parse(completionContent.toString("utf8"));
  } catch {
    throw new Error("A user-file backup completion marker is invalid JSON");
  }
  const completedAtMs = validateBackupCompletion(completion, manifest);
  return { completedAtMs, rootStats };
}

async function markTransactionCompleted(journal, transactionDirectory, outcome) {
  const manifestPath = join(transactionDirectory, "manifest.json");
  const manifestContent = await readSafeFile(manifestPath, MAX_CONTROL_FILE_BYTES);
  // Transactions created by older App versions have no explicit ownership
  // manifest. Recover them, but never retroactively claim or prune them.
  if (manifestContent === undefined) return false;
  let manifest;
  try {
    manifest = validateBackupManifest(
      JSON.parse(manifestContent.toString("utf8")),
      journal.transaction,
    );
  } catch (error) {
    throw new Error(`The user-file backup ownership manifest is unsafe: ${error.message}`);
  }
  if (
    manifest.app_version !== journal.app_version ||
    JSON.stringify(manifest.scopes) !== JSON.stringify(journal.scopes) ||
    manifest.state_sha256 !== journal.state_sha256
  ) {
    throw new Error("The user-file backup ownership manifest changed before completion");
  }
  await writePrivateJson(join(transactionDirectory, "completed.json"), {
    schema: BACKUP_MANIFEST_SCHEMA,
    owner: BACKUP_OWNER,
    kind: BACKUP_KIND,
    transaction: journal.transaction,
    metadata_sha256: manifest.metadata_sha256,
    outcome,
    completed_at: new Date().toISOString(),
  });
  await syncDirectory(transactionDirectory);
  return true;
}

async function removeCompletedBackup(path, transaction) {
  const before = await lstat(path);
  await inspectCompletedBackup(path, transaction);
  const quarantine = join(
    USER_BACKUPS_DIRECTORY,
    `.${transaction}.prune-${randomBytes(6).toString("hex")}`,
  );
  await rename(path, quarantine);
  await syncDirectory(USER_BACKUPS_DIRECTORY);
  try {
    const moved = await lstat(quarantine);
    if (
      moved.isSymbolicLink() ||
      !moved.isDirectory() ||
      moved.uid !== 0 ||
      moved.dev !== before.dev ||
      moved.ino !== before.ino
    ) {
      throw new Error("A user-file backup changed during quarantine");
    }
    await inspectCompletedBackup(quarantine, transaction);
    await rm(quarantine, {
      force: false,
      maxRetries: 2,
      recursive: true,
      retryDelay: 20,
    });
    await syncDirectory(USER_BACKUPS_DIRECTORY);
  } catch (error) {
    if (!(await inspectPath(path)) && await inspectPath(quarantine)) {
      await rename(quarantine, path).catch(() => {});
      await syncDirectory(USER_BACKUPS_DIRECTORY).catch(() => {});
    }
    throw error;
  }
}

async function pruneCompletedBackups(preserve = new Set()) {
  const journal = await loadJournal();
  if (journal) preserve.add(journal.transaction);
  const candidates = [];
  for (const name of (await readdir(USER_BACKUPS_DIRECTORY)).sort()) {
    const quarantined = PRUNE_QUARANTINE_PATTERN.exec(name);
    if (quarantined) {
      const transaction = quarantined[1];
      if (preserve.has(transaction)) continue;
      const path = join(USER_BACKUPS_DIRECTORY, name);
      try {
        await inspectCompletedBackup(path, transaction);
        await rm(path, {
          force: false,
          maxRetries: 2,
          recursive: true,
          retryDelay: 20,
        });
        await syncDirectory(USER_BACKUPS_DIRECTORY);
      } catch {
        // Unsafe, incomplete, or concurrently changed entries stay untouched.
      }
      continue;
    }
    if (!TRANSACTION_PATTERN.test(name)) continue;
    const path = join(USER_BACKUPS_DIRECTORY, name);
    try {
      const inspected = await inspectCompletedBackup(path, name);
      candidates.push({ name, path, ...inspected });
    } catch {
      // Exact App ownership and completion could not be established.
    }
  }
  candidates.sort((left, right) =>
    right.completedAtMs - left.completedAtMs ||
      right.name.localeCompare(left.name));
  const retained = new Set(
    candidates.filter(({ name }) => preserve.has(name)).map(({ name }) => name),
  );
  for (const candidate of candidates) {
    if (retained.has(candidate.name)) continue;
    if (retained.size < BACKUP_RETENTION) {
      retained.add(candidate.name);
      continue;
    }
    try {
      await removeCompletedBackup(candidate.path, candidate.name);
    } catch {
      // Cleanup is best-effort and must never make update recovery unavailable.
    }
  }
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
        await markTransactionCompleted(
          journal,
          transaction.transactionDirectory,
          "committed",
        );
        await removeSafeRegular(activeJournalPath);
        return "committed";
      } catch (verificationError) {
        try {
          await rollbackTransaction(
            transaction.transactionDirectory,
            transaction.metadata,
          );
          await markTransactionCompleted(
            journal,
            transaction.transactionDirectory,
            "rolled_back",
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
    await markTransactionCompleted(
      journal,
      transaction.transactionDirectory,
      "rolled_back",
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
  const metadataContent = await readSafeFile(
    join(transaction.path, "metadata.json"),
    MAX_CONTROL_FILE_BYTES,
  );
  if (metadataContent === undefined) {
    throw new Error("The user-file backup metadata disappeared before ownership binding");
  }
  await writePrivateJson(join(transaction.path, "manifest.json"), {
    schema: BACKUP_MANIFEST_SCHEMA,
    owner: BACKUP_OWNER,
    kind: BACKUP_KIND,
    transaction: transaction.name,
    app_version: appVersion,
    scopes,
    state_sha256: metadata.state.candidate_sha256,
    metadata_sha256: sha256(metadataContent),
    state_path: STATE_PATH,
    target_root: HOME_DIRECTORY,
    created_at: new Date().toISOString(),
  });
  await syncDirectory(transaction.path);
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
    await markTransactionCompleted(
      journal,
      prepared.transaction.path,
      "committed",
    );
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
  const telegramEnabled = value.telegram_enabled ?? false;
  if (typeof telegramEnabled !== "boolean") {
    throw new Error("telegram_enabled is invalid");
  }
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
        untrusted: "request-review",
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
  if (
    toolPermission !== "request-review"
  ) {
    const previousToolPermission = toolPermission;
    toolPermission = "request-review";
    migrationWarnings.push(
      `antigravity_tool_permission=${previousToolPermission} was normalized to request-review so Telegram side effects require a requester-bound proposal and confirmation card`,
    );
  }

  let terminalSandbox = value.antigravity_terminal_sandbox;
  if (terminalSandbox === undefined) {
    if (value.antigravity_sandbox_mode === undefined) {
      terminalSandbox = false;
    } else {
      const legacySandbox = value.antigravity_sandbox_mode;
      if (!new Set(["workspace-write", "danger-full-access"]).has(legacySandbox)) {
        throw new Error("antigravity_sandbox_mode is invalid");
      }
      terminalSandbox = false;
      migrationWarnings.push(
        "Legacy antigravity_sandbox_mode was retired; run_command uses the AppArmor command boundary",
      );
    }
  }
  if (typeof terminalSandbox !== "boolean") {
    throw new Error("antigravity_terminal_sandbox is invalid");
  }
  if (terminalSandbox === true) {
    terminalSandbox = false;
    migrationWarnings.push(
      "antigravity_terminal_sandbox=true is deprecated and was normalized to false because the privileged native sandbox is unsupported; run_command uses the AppArmor command boundary",
    );
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
    telegramEnabled,
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
  const safe = PLAYWRIGHT_READ_ONLY_TOOLS.map((tool) => `mcp(playwright/${tool})`);
  return { allow: [...safe], ask: [] };
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
  assertTelegramPermissionBoundary(value);
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

function sameStringSet(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((entry) => right.includes(entry))
  );
}

function ownsTelegramSettingsBoundary(ownership, desiredOwnership) {
  return (
    [...TELEGRAM_MANAGED_SECURITY_KEYS].every((key) =>
      ownership.keys.includes(key)) &&
    sameStringSet(
      ownership.permission_rules,
      desiredOwnership.permission_rules,
    )
  );
}

function hasLegacy206PermissionOwnership(ownership) {
  return (
    sameStringSet(ownership.keys, LEGACY_2_0_6_MANAGED_SETTINGS_KEYS) &&
    sameStringSet(
      ownership.permission_rules,
      [...LEGACY_2_0_6_PERMISSION_RULE_SET],
    )
  );
}

function permissionRuleSet(rules) {
  return [
    ...rules.allow,
    ...rules.ask,
    ...rules.deny,
  ];
}

function permissionMigrationSource(ownership, desiredOwnership) {
  if (hasLegacy206PermissionOwnership(ownership)) {
    return { label: "2.0.6", rules: LEGACY_2_0_6_PERMISSION_RULES };
  }
  if (
    sameStringSet(ownership.keys, desiredOwnership.keys) &&
    sameStringSet(
      ownership.permission_rules,
      permissionRuleSet(LEGACY_2_0_8_PERMISSION_RULES),
    )
  ) {
    return { label: "2.0.8", rules: LEGACY_2_0_8_PERMISSION_RULES };
  }
  if (
    sameStringSet(ownership.keys, desiredOwnership.keys) &&
    sameStringSet(
      ownership.permission_rules,
      permissionRuleSet(LEGACY_V3_PERMISSION_RULES),
    )
  ) {
    return {
      label: "2.0.9/2.0.10",
      rules: LEGACY_V3_PERMISSION_RULES,
    };
  }
  return null;
}

function skipJsonWhitespace(text, start) {
  let index = start;
  while (index < text.length && /[\t\n\r ]/u.test(text[index])) index += 1;
  return index;
}

function scanJsonStringEnd(text, start) {
  if (text[start] !== '"') throw new Error("Expected a JSON string");
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === '"') return index + 1;
  }
  throw new Error("Unterminated JSON string");
}

function scanJsonValueEnd(text, start) {
  if (text[start] === '"') return scanJsonStringEnd(text, start);
  if (text[start] === "{" || text[start] === "[") {
    const stack = [text[start] === "{" ? "}" : "]"];
    for (let index = start + 1; index < text.length; index += 1) {
      if (text[index] === '"') {
        index = scanJsonStringEnd(text, index) - 1;
        continue;
      }
      if (text[index] === "{" || text[index] === "[") {
        stack.push(text[index] === "{" ? "}" : "]");
        continue;
      }
      if (text[index] === "}" || text[index] === "]") {
        if (stack.pop() !== text[index]) {
          throw new Error("Mismatched JSON container");
        }
        if (stack.length === 0) return index + 1;
      }
    }
    throw new Error("Unterminated JSON container");
  }
  let index = start;
  while (index < text.length && text[index] !== "," && text[index] !== "}") {
    index += 1;
  }
  while (index > start && /[\t\n\r ]/u.test(text[index - 1])) index -= 1;
  return index;
}

function locateTopLevelJsonProperty(text, propertyName) {
  let index = skipJsonWhitespace(text, 0);
  if (text[index] !== "{") throw new Error("Settings JSON must be an object");
  index += 1;
  const seen = new Set();
  let location;
  while (true) {
    index = skipJsonWhitespace(text, index);
    if (text[index] === "}") {
      index = skipJsonWhitespace(text, index + 1);
      if (index !== text.length) throw new Error("Unexpected JSON suffix");
      break;
    }
    const keyStart = index;
    const keyEnd = scanJsonStringEnd(text, keyStart);
    const key = JSON.parse(text.slice(keyStart, keyEnd));
    if (seen.has(key)) throw new Error("Duplicate top-level settings key");
    seen.add(key);
    index = skipJsonWhitespace(text, keyEnd);
    if (text[index] !== ":") throw new Error("Expected a JSON property colon");
    const valueStart = skipJsonWhitespace(text, index + 1);
    const valueEnd = scanJsonValueEnd(text, valueStart);
    if (key === propertyName) {
      location = { keyStart, valueEnd, valueStart };
    }
    index = skipJsonWhitespace(text, valueEnd);
    if (text[index] === ",") {
      index += 1;
      continue;
    }
    if (text[index] !== "}") throw new Error("Expected a JSON property separator");
  }
  if (!location) throw new Error(`Missing top-level ${propertyName} property`);
  return location;
}

function replaceTopLevelJsonPropertyValue(content, propertyName, value) {
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) {
    throw new Error("Settings JSON is not valid UTF-8");
  }
  const location = locateTopLevelJsonProperty(text, propertyName);
  const lineStart = text.lastIndexOf("\n", location.keyStart - 1) + 1;
  const beforeKey = text.slice(lineStart, location.keyStart);
  const indent = /^[\t ]*$/u.test(beforeKey) ? beforeKey : "";
  const serialized = JSON.stringify(value, null, 2).replaceAll(
    "\n",
    `\n${indent}`,
  );
  const candidate = `${text.slice(0, location.valueStart)}${serialized}${text.slice(location.valueEnd)}`;
  return Buffer.from(candidate, "utf8");
}

function preparePreservePermissionMigration(
  currentContent,
  desiredContent,
  ownership,
  desiredOwnership,
) {
  const currentOwnership =
    (sameStringSet(ownership.keys, desiredOwnership.keys) &&
      sameStringSet(
        ownership.permission_rules,
        desiredOwnership.permission_rules,
      )) || ownsTelegramSettingsBoundary(ownership, desiredOwnership);
  if (currentOwnership) {
    try {
      const current = parseSettings(currentContent, "Existing settings.json");
      let candidate = currentContent;
      let changed = false;
      if (current.enableTerminalSandbox === true) {
        candidate = replaceTopLevelJsonPropertyValue(
          candidate,
          "enableTerminalSandbox",
          false,
        );
        changed = true;
      } else if (current.enableTerminalSandbox !== false) {
        throw new Error("The managed native sandbox setting is invalid");
      }
      if (typeof current.toolPermission !== "string" ||
          !TOOL_PERMISSIONS.has(current.toolPermission)) {
        throw new Error("The managed native tool permission is invalid");
      }
      if (current.toolPermission !== "request-review") {
        candidate = replaceTopLevelJsonPropertyValue(
          candidate,
          "toolPermission",
          "request-review",
        );
        changed = true;
      }
      if (!changed) {
        return { candidate: null, status: "not_needed", warning: null };
      }
      return {
        candidate,
        status: "applied",
        warning:
          "Preserve mode enforced request-review for Telegram side effects and retired unsupported native-sandbox settings",
      };
    } catch {
      return {
        candidate: null,
        status: "skipped_ambiguous",
        warning:
          "Preserve mode left settings.json unchanged because its managed approval or native-sandbox setting was ambiguous",
      };
    }
  }
  const migrationSource = permissionMigrationSource(
    ownership,
    desiredOwnership,
  );
  if (migrationSource === null) {
    const emptyOwnership =
      ownership.keys.length === 0 && ownership.permission_rules.length === 0;
    return {
      candidate: null,
      status: emptyOwnership ? "skipped_unowned" : "skipped_ambiguous",
      warning: emptyOwnership
        ? "Preserve mode left settings.json unchanged because App-managed permission ownership could not be proven"
        : "Preserve mode left settings.json unchanged because its permission ownership state was ambiguous",
    };
  }

  try {
    const current = parseSettings(currentContent, "Existing settings.json");
    const desired = parseSettings(desiredContent, "The image default settings.json");
    permissionRules(current, "Existing settings.json");
    permissionRules(desired, "The image default settings.json");

    const bucketRank = { allow: 0, ask: 1, deny: 2 };
    const preservedOverrides = new Map();
    for (const bucket of ["allow", "ask", "deny"]) {
      for (const rule of migrationSource.rules[bucket]) {
        const locations = [];
        for (const candidateBucket of ["allow", "ask", "deny"]) {
          for (const candidateRule of current.permissions[candidateBucket]) {
            if (candidateRule === rule) locations.push(candidateBucket);
          }
        }
        const expectedCount = locations.filter(
          (candidateBucket) => candidateBucket === bucket,
        ).length;
        const stronger = locations.filter(
          (candidateBucket) => bucketRank[candidateBucket] > bucketRank[bucket],
        );
        const weaker = locations.filter(
          (candidateBucket) => bucketRank[candidateBucket] < bucketRank[bucket],
        );
        if (weaker.length > 0 || expectedCount > 1 || stronger.length > 1) {
          throw new Error("The App-owned permission layout changed");
        }
        if (stronger.length === 1 && locations.length === expectedCount + 1) {
          preservedOverrides.set(rule, stronger[0]);
          continue;
        }
        if (expectedCount !== 1 || locations.length !== 1) {
          throw new Error("The App-owned permission layout changed");
        }
      }
    }

    const permissions = { ...current.permissions };
    const sourceRuleSet = new Set(permissionRuleSet(migrationSource.rules));
    for (const bucket of ["allow", "ask", "deny"]) {
      const userRules = current.permissions[bucket].filter(
        (rule) =>
          !sourceRuleSet.has(rule) || preservedOverrides.get(rule) === bucket,
      );
      permissions[bucket] = [...userRules];
      for (const rule of desired.permissions[bucket]) {
        if (!permissions[bucket].includes(rule)) permissions[bucket].push(rule);
      }
    }

    let candidate = replaceTopLevelJsonPropertyValue(
      currentContent,
      "permissions",
      permissions,
    );
    if (current.enableTerminalSandbox === true) {
      candidate = replaceTopLevelJsonPropertyValue(
        candidate,
        "enableTerminalSandbox",
        false,
      );
    } else if (current.enableTerminalSandbox !== false) {
      throw new Error("The App-owned native sandbox setting changed");
    }
    if (typeof current.toolPermission !== "string" ||
        !TOOL_PERMISSIONS.has(current.toolPermission)) {
      throw new Error("The App-owned native tool permission changed");
    }
    if (current.toolPermission !== "request-review") {
      candidate = replaceTopLevelJsonPropertyValue(
        candidate,
        "toolPermission",
        "request-review",
      );
    }
    const installed = parseSettings(candidate, "Migrated settings.json");
    const currentNonPermissions = { ...current };
    const installedNonPermissions = { ...installed };
    delete currentNonPermissions.permissions;
    delete installedNonPermissions.permissions;
    delete currentNonPermissions.enableTerminalSandbox;
    delete installedNonPermissions.enableTerminalSandbox;
    delete currentNonPermissions.toolPermission;
    delete installedNonPermissions.toolPermission;
    const expectedToolPermission = "request-review";
    if (
      JSON.stringify(currentNonPermissions) !==
        JSON.stringify(installedNonPermissions) ||
      installed.enableTerminalSandbox !== false ||
      installed.toolPermission !== expectedToolPermission
    ) {
      throw new Error("A non-permission setting changed during migration");
    }
    return { candidate, status: "applied", warning: null };
  } catch {
    return {
      candidate: null,
      status: "skipped_ambiguous",
      warning:
        `Preserve mode left settings.json unchanged because its App-owned ${migrationSource.label} permission layout was ambiguous`,
    };
  }
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

function telegramSettingsOwnership(currentOwnership, desiredOwnership) {
  for (const key of TELEGRAM_MANAGED_SECURITY_KEYS) {
    if (!desiredOwnership.keys.includes(key)) {
      throw new FatalUpdateError(
        `The image default settings.json is missing Telegram-managed ${key}`,
      );
    }
  }
  return {
    keys: [...new Set([
      ...currentOwnership.keys,
      ...TELEGRAM_MANAGED_SECURITY_KEYS,
    ])],
    permission_rules: [...desiredOwnership.permission_rules],
  };
}

function refreshedSettingsOwnership(currentOwnership, desiredOwnership) {
  return {
    keys: [...currentOwnership.keys],
    permission_rules: currentOwnership.keys.includes("permissions")
      ? [...desiredOwnership.permission_rules]
      : [...currentOwnership.permission_rules],
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

function resetManagedSettings(currentContent, defaultContent, desiredOwnership) {
  const current = parseSettings(currentContent, "Existing settings.json");
  const desired = parseSettings(defaultContent, "The image default settings.json");
  permissionRules(desired, "The image default settings.json");
  const reset = { ...current };
  for (const key of desiredOwnership.keys) {
    if (!Object.hasOwn(desired, key)) {
      throw new Error(`The managed settings key ${key} has no image default`);
    }
    reset[key] = desired[key];
  }
  // reset_v2 is the explicit recovery control for an effective Telegram
  // permission layout that the startup gate cannot safely accept. Preserve
  // non-managed top-level settings, but never retain user buckets or unknown
  // allow/ask rules inside the managed permission object.
  reset.permissions = {
    allow: [...desired.permissions.allow],
    ask: [...desired.permissions.ask],
    deny: [...desired.permissions.deny],
  };
  return Buffer.from(`${JSON.stringify(reset, null, 2)}\n`, "utf8");
}

function reconcileTelegramManagedSettings(currentContent, defaultContent) {
  const current = parseSettings(currentContent, "Existing settings.json");
  const desired = parseSettings(defaultContent, "The image default settings.json");
  assertTelegramPermissionBoundary(desired);
  if (desired.enableTerminalSandbox !== false) {
    throw new FatalUpdateError(
      "The image default settings.json enables the unsupported native sandbox",
    );
  }
  let currentIsCanonical = true;
  try {
    assertTelegramPermissionBoundary(current);
  } catch {
    currentIsCanonical = false;
  }
  if (currentIsCanonical) {
    if (currentContent.length > TELEGRAM_SETTINGS_MAX_BYTES) {
      throw new Error(
        "Candidate settings.json exceeds the Telegram boundary size limit",
      );
    }
    return currentContent;
  }
  // A settings file that is already canonical stays byte-exact. Any boundary
  // drift is replaced below while preserving unrelated top-level keys.

  // Enabling Telegram makes the five App-owned security settings part of the
  // authenticated approval boundary. Unknown allow/ask/deny rules cannot be
  // carried into a headless session because the bridge could bypass or block
  // proposal cards. Preserve every unrelated top-level user setting, global
  // MCP configuration, and OAuth data.
  const reconciled = {
    ...current,
    allowNonWorkspaceAccess: desired.allowNonWorkspaceAccess,
    artifactReviewPolicy: desired.artifactReviewPolicy,
    toolPermission: desired.toolPermission,
    enableTerminalSandbox: desired.enableTerminalSandbox,
    permissions: {
      allow: [...desired.permissions.allow],
      ask: [...desired.permissions.ask],
      deny: [...desired.permissions.deny],
    },
  };
  assertTelegramPermissionBoundary(reconciled);
  const content = Buffer.from(`${JSON.stringify(reconciled, null, 2)}\n`, "utf8");
  if (content.length > TELEGRAM_SETTINGS_MAX_BYTES) {
    throw new Error(
      "Reconciled settings.json exceeds the Telegram boundary size limit",
    );
  }
  return content;
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
    targets[scope] = {
      existed: true,
      mode: stats.mode & 0o777,
      size: stats.size,
    };
  }

  if ((await inspectPath(LEGACY_CONFIG_PATH)) || (await inspectPath(LEGACY_AGENTS_PATH))) {
    warnings.push(
      "Legacy config.toml or AGENTS.md was preserved but is not loaded by Antigravity 1.1.13",
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
  let permissionMigration = "not_applicable";
  let permissionMigrationWarning = null;
  let scopes = [];
  const refreshed = [];

  let refreshConflictWarning = null;
  if (
    preflight.targets.settings.existed &&
    options.mode === "refresh_managed" &&
    !versionApplied(state, "settings", appVersion) &&
    state.managed.settings.keys.length === 0
  ) {
    const conflict =
      "Existing settings.json has no App ownership state and was preserved";
    refreshConflictWarning = conflict;
  }

  if (!preflight.targets.settings.existed) {
    created.push("settings");
    candidates.settings = defaults.settings;
    state.managed.settings = desiredOwnership;
  } else if (options.mode === "reset_v2") {
    const currentSettings = await readSafeFile(SETTINGS_PATH);
    if (currentSettings === undefined) {
      throw new Error("Existing settings.json disappeared before managed reset");
    }
    const reset = resetManagedSettings(
      currentSettings,
      defaults.settings,
      desiredOwnership,
    );
    state.managed.settings = desiredOwnership;
    if (!reset.equals(currentSettings) ||
        !versionApplied(state, "settings", appVersion)) {
      candidates.settings = reset;
      refreshed.push("settings");
    }
  } else if (options.mode === "preserve") {
    const currentSettings = await readSafeFile(SETTINGS_PATH);
    if (currentSettings === undefined) {
      throw new Error(
        "Existing settings.json disappeared before permission migration",
      );
    }
    const currentOwnership = state.managed.settings;
    const migration = preparePreservePermissionMigration(
      currentSettings,
      defaults.settings,
      currentOwnership,
      desiredOwnership,
    );
    permissionMigration =
      migration.status === "not_needed" &&
      versionApplied(state, "settings", appVersion)
        ? "already_applied"
        : migration.status;
    permissionMigrationWarning = migration.warning;
    if (migration.candidate !== null) {
      candidates.settings = migration.candidate;
      state.managed.settings = refreshedSettingsOwnership(
        currentOwnership,
        desiredOwnership,
      );
      refreshed.push("settings");
    }
  } else if (
    managedRefreshRequested &&
    !versionApplied(state, "settings", appVersion) &&
    state.managed.settings.keys.length > 0
  ) {
    const currentSettings = await readSafeFile(
      SETTINGS_PATH,
      options.telegramEnabled
        ? TELEGRAM_SETTINGS_MAX_BYTES
        : MAX_USER_FILE_BYTES,
    );
    if (currentSettings === undefined) {
      throw new Error("Existing settings.json disappeared before managed merge");
    }
    const currentOwnership = state.managed.settings;
    // The generic managed merge validates every current permission bucket.
    // Telegram startup owns the complete permission boundary, so repair the
    // raw file before that validation can reject a malformed legacy bucket.
    // Keep Telegram-disabled refresh behavior unchanged and fail closed there.
    const managedMergeBase = options.telegramEnabled
      ? reconcileTelegramManagedSettings(
          currentSettings,
          defaults.settings,
        )
      : currentSettings;
    candidates.settings = mergeManagedSettings(
      managedMergeBase,
      defaults.settings,
      currentOwnership,
    );
    state.managed.settings = refreshedSettingsOwnership(
      currentOwnership,
      desiredOwnership,
    );
    refreshed.push("settings");
  }

  if (options.telegramEnabled && preflight.targets.settings.existed) {
    const currentSettings = await readSafeFile(
      SETTINGS_PATH,
      TELEGRAM_SETTINGS_MAX_BYTES,
    );
    if (currentSettings === undefined) {
      throw new Error(
        "Existing settings.json disappeared before Telegram permission reconciliation",
      );
    }
    const reconciliationBase = candidates.settings ?? currentSettings;
    const reconciledOwnership = telegramSettingsOwnership(
      state.managed.settings,
      desiredOwnership,
    );
    const reconciled = reconcileTelegramManagedSettings(
      reconciliationBase,
      defaults.settings,
    );
    const reconciliationNeeded =
      Object.hasOwn(candidates, "settings") ||
      !reconciled.equals(currentSettings) ||
      preflight.targets.settings.mode !== 0o600 ||
      !sameStringSet(
        state.managed.settings.keys,
        reconciledOwnership.keys,
      ) ||
      !sameStringSet(
        state.managed.settings.permission_rules,
        reconciledOwnership.permission_rules,
      );
    if (reconciliationNeeded) {
      candidates.settings = reconciled;
      state.managed.settings = reconciledOwnership;
      if (!refreshed.includes("settings")) refreshed.push("settings");
      permissionMigration = "telegram_reconciled";
      warnings.push(
        "Telegram-enabled startup reconciled managed security keys and permissions to the safe Telegram policy while preserving unrelated settings",
      );
    } else if (options.mode === "preserve") {
      permissionMigration = "already_applied";
    }
    permissionMigrationWarning = null;
    refreshConflictWarning = null;
  }
  if (permissionMigrationWarning !== null &&
      permissionMigration !== "telegram_reconciled") {
    warnings.push(permissionMigrationWarning);
  }
  if (refreshConflictWarning !== null &&
      permissionMigration !== "telegram_reconciled") {
    warnings.push(refreshConflictWarning);
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

  const preservedBackups = new Set();
  if (backupDirectory !== null) {
    preservedBackups.add(basename(backupDirectory));
  }
  try {
    await ensurePrivateDirectory(USER_BACKUPS_DIRECTORY);
    await pruneCompletedBackups(preservedBackups);
  } catch {
    warnings.push("Completed user-file backup retention was deferred safely");
  }

  process.stdout.write(
    `${JSON.stringify({
      app_version: appVersion,
      backup_directory: backupDirectory,
      created,
      mode: options.mode,
      permission_migration: permissionMigration,
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
