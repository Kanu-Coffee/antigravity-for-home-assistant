const TELEGRAM_EFFECTIVE_TOOL_PERMISSIONS = new Set([
  "request-review",
  "always-proceed",
]);
const TELEGRAM_SETTINGS_MAX_BYTES = 256 * 1024;
const TELEGRAM_MANAGED_SECURITY_KEYS = new Set([
  "allowNonWorkspaceAccess",
  "artifactReviewPolicy",
  "enableTerminalSandbox",
  "permissions",
  "toolPermission",
]);
const TELEGRAM_REQUIRED_PROPOSAL_RULES = Object.freeze([
  "mcp(ha_change/ha_change_propose)",
  "mcp(telegram_action/telegram_action_propose)",
]);
const TELEGRAM_MANAGED_READ_MCP_RULES = Object.freeze([
  "mcp(ha_files/ha_files_list)",
  "mcp(ha_files/ha_files_read_text)",
  "mcp(ha_memory/memory_search)",
  "mcp(ha_memory/memory_show)",
  "mcp(ha_memory/memory_status)",
  "mcp(ha_read/ha_read_app_logs)",
  "mcp(ha_read/ha_read_addon_logs)",
  "mcp(ha_read/ha_read_config)",
  "mcp(ha_read/ha_read_core_logs)",
  "mcp(ha_read/ha_read_history)",
  "mcp(ha_read/ha_read_host_logs)",
  "mcp(ha_read/ha_read_registry)",
  "mcp(ha_read/ha_read_services)",
  "mcp(ha_read/ha_read_state)",
  "mcp(ha_read/ha_read_states)",
  "mcp(ha_read/ha_read_storage_usage)",
  "mcp(ha_read/ha_read_supervisor_logs)",
  "mcp(ha_read/ha_read_system_info)",
  "mcp(ha_read/ha_read_traces)",
  "mcp(ha_validate/ha_validate_config)",
  "mcp(ha_validate/ha_verify_state)",
  "mcp(playwright/browser_console_messages)",
  "mcp(playwright/browser_network_requests)",
  "mcp(playwright/browser_snapshot)",
  "mcp(playwright/browser_take_screenshot)",
]);
const TELEGRAM_REQUEST_REVIEW_ALLOW_RULES = new Set([
  "read_url(*)",
  ...TELEGRAM_REQUIRED_PROPOSAL_RULES,
  ...TELEGRAM_MANAGED_READ_MCP_RULES,
]);
const TELEGRAM_REQUEST_REVIEW_ASK_RULES = new Set([
  "mcp(ha_files/ha_files_write_text)",
  "execute_url(*)",
  "command(*)",
]);
const TELEGRAM_ALWAYS_PROCEED_ALLOW_RULES = new Set([
  "read_url(*)",
  "execute_url(*)",
  "command(*)",
  "mcp(*)",
]);

// These are native-tool rules, not filesystem mediation. Keep the paths exact:
// the documented permission grammar supports exact paths, recursive directory
// targets and a global `*`, but does not promise arbitrary partial path globs.
// AppArmor remains responsible for dynamic PID paths and unknown OAuth backend
// filenames that cannot be expressed exactly here.
const TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES = new Set([
  // Native file permissions compare lexical paths before opening them. A
  // symlink under an allowed directory can therefore resolve into OAuth or
  // .storage after the permission decision. Keep both native file tools
  // globally disabled; the image-managed ha_files MCP performs descriptor-
  // relative, no-follow operations under its own AppArmor profile instead.
  "read_file(*)",
  "write_file(*)",
  "read_file(/data/home/.gemini)",
  "write_file(/data/home/.gemini)",
  "read_file(/data/home/.gemini/antigravity-cli/settings.json)",
  "write_file(/data/home/.gemini/antigravity-cli/settings.json)",
  "read_file(/data/home/.gemini/config/mcp_config.json)",
  "write_file(/data/home/.gemini/config/mcp_config.json)",
  "read_file(/data/antigravity/auth.json)",
  "write_file(/data/antigravity/auth.json)",
  "read_file(/data/home/.gemini/antigravity-cli/auth.json)",
  "write_file(/data/home/.gemini/antigravity-cli/auth.json)",
  "read_file(/data/home/.gemini/antigravity-cli/oauth)",
  "write_file(/data/home/.gemini/antigravity-cli/oauth)",
  "read_file(/data/browser-auth)",
  "write_file(/data/browser-auth)",
  "read_file(/data/github-cli)",
  "write_file(/data/github-cli)",
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
  "read_file(/config/.cloud)",
  "write_file(/config/.cloud)",
  "read_file(/config/ssl)",
  "write_file(/config/ssl)",
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
  "read_file(/root/.aws)",
  "write_file(/root/.aws)",
  "read_file(/root/.azure)",
  "write_file(/root/.azure)",
  "read_file(/root/.config/gcloud)",
  "write_file(/root/.config/gcloud)",
  "read_file(/root/.kube)",
  "write_file(/root/.kube)",
  "read_file(/root/.docker/config.json)",
  "write_file(/root/.docker/config.json)",
  "read_file(/root/.netrc)",
  "write_file(/root/.netrc)",
  "read_file(/root/.npmrc)",
  "write_file(/root/.npmrc)",
  "read_file(/etc/ssl/private)",
  "write_file(/etc/ssl/private)",
  "read_file(/proc/self/environ)",
  "write_file(/proc/self/environ)",
  "read_file(/proc/self/cmdline)",
  "write_file(/proc/self/cmdline)",
  "read_file(/proc/self/mem)",
  "write_file(/proc/self/mem)",
  "read_file(/proc/self/fd)",
  "write_file(/proc/self/fd)",
  "read_file(/proc/self/root)",
  "write_file(/proc/self/root)",
  "read_file(/proc/self/map_files)",
  "write_file(/proc/self/map_files)",
]);

// Backward-compatible export name used by the bridge and existing consumers.
const TELEGRAM_SAFE_ALLOW_RULES = TELEGRAM_REQUEST_REVIEW_ALLOW_RULES;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalTelegramPermissionRules(toolPermission) {
  if (toolPermission === "request-review") {
    return {
      allow: [...TELEGRAM_REQUEST_REVIEW_ALLOW_RULES],
      ask: [...TELEGRAM_REQUEST_REVIEW_ASK_RULES],
      deny: [...TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES],
    };
  }
  if (toolPermission === "always-proceed") {
    return {
      allow: [...TELEGRAM_ALWAYS_PROCEED_ALLOW_RULES],
      ask: [],
      deny: [...TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES],
    };
  }
  throw new Error(`unsupported Telegram tool permission: ${toolPermission}`);
}

function sameRuleSet(actual, expected) {
  return (
    actual.every((rule) => expected.has(rule)) &&
    [...expected].every((rule) => actual.includes(rule))
  );
}

function assertTelegramPermissionBoundary(value) {
  if (!isPlainObject(value) ||
      !TELEGRAM_EFFECTIVE_TOOL_PERMISSIONS.has(value.toolPermission) ||
      value.enableTerminalSandbox !== false ||
      value.allowNonWorkspaceAccess !== true ||
      value.artifactReviewPolicy !== "agent-decides" ||
      !isPlainObject(value.permissions) ||
      Object.keys(value.permissions).length !== 3 ||
      !["allow", "ask", "deny"].every((bucket) =>
        Array.isArray(value.permissions[bucket]) &&
        value.permissions[bucket].every((rule) => typeof rule === "string"))) {
    throw new Error(
      "effective Antigravity permissions are not valid for Telegram; select reset_v2 in the App user-file update option and restart",
    );
  }
  const { allow, ask, deny } = value.permissions;
  const allRules = [...allow, ...ask, ...deny];
  const expected = canonicalTelegramPermissionRules(value.toolPermission);
  if (new Set(allRules).size !== allRules.length ||
      !sameRuleSet(allow, new Set(expected.allow)) ||
      !sameRuleSet(ask, new Set(expected.ask)) ||
      [...TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES].some(
        (rule) => !deny.includes(rule),
      ) ||
      (value.toolPermission === "request-review" &&
        TELEGRAM_REQUIRED_PROPOSAL_RULES.some((rule) => !allow.includes(rule)))) {
    throw new Error(
      "effective Antigravity permissions would bypass or block the configured Telegram policy; select reset_v2 in the App user-file update option and restart",
    );
  }
  return {
    toolPermission: value.toolPermission,
    allowCount: allow.length,
    denyCount: deny.length,
  };
}

export {
  TELEGRAM_ALWAYS_PROCEED_ALLOW_RULES,
  TELEGRAM_EFFECTIVE_TOOL_PERMISSIONS,
  TELEGRAM_MANAGED_READ_MCP_RULES,
  TELEGRAM_MANAGED_SECURITY_KEYS,
  TELEGRAM_REQUEST_REVIEW_ALLOW_RULES,
  TELEGRAM_REQUEST_REVIEW_ASK_RULES,
  TELEGRAM_REQUIRED_PROPOSAL_RULES,
  TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES,
  TELEGRAM_SAFE_ALLOW_RULES,
  TELEGRAM_SETTINGS_MAX_BYTES,
  assertTelegramPermissionBoundary,
  canonicalTelegramPermissionRules,
};
