const TELEGRAM_EFFECTIVE_TOOL_PERMISSIONS = new Set(["request-review"]);
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
const TELEGRAM_SAFE_ALLOW_RULES = new Set([
  "read_file(/config)",
  "read_file(/data/home/.gemini/config)",
  "read_file(/data/home/.gemini/antigravity-cli/agents)",
  "read_file(/data/home/.gemini/antigravity-cli/plugins)",
  "read_file(/data/home/.gemini/antigravity-cli/skills)",
  "read_file(/data/home/.gemini/GEMINI.md)",
  "read_file(/data/home/.gemini/antigravity-cli/settings.json)",
  ...TELEGRAM_REQUIRED_PROPOSAL_RULES,
  "mcp(ha_memory/memory_search)",
  "mcp(ha_memory/memory_show)",
  "mcp(ha_memory/memory_status)",
  "mcp(ha_read/ha_read_app_logs)",
  "mcp(ha_read/ha_read_config)",
  "mcp(ha_read/ha_read_core_logs)",
  "mcp(ha_read/ha_read_history)",
  "mcp(ha_read/ha_read_registry)",
  "mcp(ha_read/ha_read_services)",
  "mcp(ha_read/ha_read_state)",
  "mcp(ha_read/ha_read_states)",
  "mcp(ha_read/ha_read_storage_usage)",
  "mcp(ha_read/ha_read_system_info)",
  "mcp(ha_read/ha_read_traces)",
  "mcp(ha_validate/ha_validate_config)",
  "mcp(ha_validate/ha_verify_state)",
  "mcp(playwright/browser_console_messages)",
  "mcp(playwright/browser_network_requests)",
  "mcp(playwright/browser_snapshot)",
  "mcp(playwright/browser_take_screenshot)",
]);
const TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES = new Set([
  "write_file(/data/home/.gemini/antigravity-cli/settings.json)",
  "read_file(/data/home/.gemini/config/mcp_config.json)",
  "write_file(/data/home/.gemini/config/mcp_config.json)",
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
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertTelegramPermissionBoundary(value) {
  if (!isPlainObject(value) ||
      !TELEGRAM_EFFECTIVE_TOOL_PERMISSIONS.has(value.toolPermission) ||
      value.enableTerminalSandbox !== false ||
      value.allowNonWorkspaceAccess !== false ||
      value.artifactReviewPolicy !== "agent-decides" ||
      !isPlainObject(value.permissions) ||
      Object.keys(value.permissions).length !== 3 ||
      !["allow", "ask", "deny"].every((bucket) =>
        Array.isArray(value.permissions[bucket]) &&
        value.permissions[bucket].every((rule) => typeof rule === "string"))) {
    throw new Error(
      "effective Antigravity permissions are not safe for Telegram approval; select reset_v2 in the App user-file update option and restart",
    );
  }
  const { allow, ask, deny } = value.permissions;
  const allRules = [...allow, ...ask, ...deny];
  if (new Set(allRules).size !== allRules.length || ask.length !== 0 ||
      allow.length !== TELEGRAM_SAFE_ALLOW_RULES.size ||
      allow.some((rule) => !TELEGRAM_SAFE_ALLOW_RULES.has(rule)) ||
      TELEGRAM_REQUIRED_PROPOSAL_RULES.some((rule) => !allow.includes(rule)) ||
      deny.length !== TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES.size ||
      deny.some((rule) => !TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES.has(rule)) ||
      [...TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES].some((rule) => !deny.includes(rule))) {
    throw new Error(
      "effective Antigravity permissions would bypass or block Telegram approval; select reset_v2 in the App user-file update option and restart",
    );
  }
  return {
    toolPermission: value.toolPermission,
    allowCount: allow.length,
    denyCount: deny.length,
  };
}

export {
  TELEGRAM_EFFECTIVE_TOOL_PERMISSIONS,
  TELEGRAM_MANAGED_SECURITY_KEYS,
  TELEGRAM_REQUIRED_PROPOSAL_RULES,
  TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES,
  TELEGRAM_SAFE_ALLOW_RULES,
  TELEGRAM_SETTINGS_MAX_BYTES,
  assertTelegramPermissionBoundary,
};
