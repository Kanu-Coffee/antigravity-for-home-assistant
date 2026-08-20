const TELEGRAM_EFFECTIVE_TOOL_PERMISSIONS = new Set([
  "request-review",
  "always-proceed",
]);
const NATIVE_TOP_LEVEL_KEY_ORDER = Symbol("nativeTopLevelKeyOrder");
const TELEGRAM_SETTINGS_MAX_BYTES = 256 * 1024;
const TELEGRAM_MANAGED_SECURITY_KEYS = new Set([
  "allowNonWorkspaceAccess",
  "artifactReviewPolicy",
  "permissions",
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
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && !isNativeRawJsonNumber(value);
}

function canonicalTelegramPermissionRules(toolPermission) {
  if (toolPermission === "request-review") {
    return {
      allow: [...TELEGRAM_REQUEST_REVIEW_ALLOW_RULES],
      deny: [...TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES],
      ask: [...TELEGRAM_REQUEST_REVIEW_ASK_RULES],
    };
  }
  if (toolPermission === "always-proceed") {
    return {
      allow: [...TELEGRAM_ALWAYS_PROCEED_ALLOW_RULES],
      deny: [...TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES],
      ask: [],
    };
  }
  throw new Error(`unsupported Telegram tool permission: ${toolPermission}`);
}

function nativeSettingsToolPermission(value) {
  if (!isPlainObject(value)) {
    throw new Error("Antigravity settings must be a JSON object");
  }
  if (!Object.hasOwn(value, "toolPermission") ||
      value.toolPermission === "request-review") {
    return "request-review";
  }
  if (value.toolPermission === "always-proceed") return "always-proceed";
  throw new Error("Antigravity settings contain an unsupported tool permission");
}

function isNativeRawJsonNumber(value) {
  return typeof JSON.isRawJSON === "function" && JSON.isRawJSON(value);
}

function skipNativeJsonWhitespace(text, start) {
  let index = start;
  while (index < text.length && /[\t\n\r ]/u.test(text[index])) index += 1;
  return index;
}

function scanNativeJsonStringEnd(text, start) {
  if (text[start] !== '"') return -1;
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === '"') return index + 1;
  }
  return -1;
}

function scanNativeJsonValueEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      if (depth === 0) return index;
      depth -= 1;
    } else if (character === "," && depth === 0) {
      return index;
    }
  }
  return text.length;
}

function nativeTopLevelKeyOrder(text) {
  let index = skipNativeJsonWhitespace(text, 0);
  if (text[index] !== "{") return null;
  index = skipNativeJsonWhitespace(text, index + 1);
  if (text[index] === "}") return [];
  const lastPositions = new Map();
  let position = 0;
  while (index < text.length) {
    const keyStart = index;
    const keyEnd = scanNativeJsonStringEnd(text, keyStart);
    if (keyEnd < 0) return null;
    let key;
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd));
    } catch {
      return null;
    }
    index = skipNativeJsonWhitespace(text, keyEnd);
    if (text[index] !== ":") return null;
    index = skipNativeJsonWhitespace(text, index + 1);
    const valueEnd = scanNativeJsonValueEnd(text, index);
    index = skipNativeJsonWhitespace(text, valueEnd);
    lastPositions.set(key, position);
    position += 1;
    if (text[index] === "}") break;
    if (text[index] !== ",") return null;
    index = skipNativeJsonWhitespace(text, index + 1);
  }
  return [...lastPositions]
    .sort((left, right) => left[1] - right[1])
    .map(([key]) => key);
}

function nativeParseJsonContent(content) {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : content;
  if (typeof text !== "string") {
    throw new Error("Native JSON content must be a string or Buffer");
  }
  const value = JSON.parse(text, (_key, parsedValue, context) => {
    if (typeof parsedValue === "number" && typeof context?.source === "string") {
      return JSON.rawJSON(context.source);
    }
    return parsedValue;
  });
  const keyOrder = nativeTopLevelKeyOrder(text);
  if (isPlainObject(value) && Array.isArray(keyOrder)) {
    Object.defineProperty(value, NATIVE_TOP_LEVEL_KEY_ORDER, {
      value: Object.freeze(keyOrder),
      enumerable: true,
    });
  }
  return value;
}

function nativeSourceOrderedTopLevelKeys(value) {
  const keys = Object.keys(value);
  const recorded = value[NATIVE_TOP_LEVEL_KEY_ORDER];
  if (!Array.isArray(recorded)) return keys;
  const remaining = new Set(keys);
  const ordered = [];
  for (const key of recorded) {
    if (!remaining.delete(key)) continue;
    ordered.push(key);
  }
  for (const key of keys) {
    if (remaining.delete(key)) ordered.push(key);
  }
  return ordered;
}

function nativeTopLevelKeyCompare(left, right) {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0));
  const rightPoints = Array.from(right, (value) => value.codePointAt(0));
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] - rightPoints[index];
    }
  }
  return leftPoints.length - rightPoints.length;
}

function nativeTopLevelKey(value) {
  let normalized = "";
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        normalized += value[index] + value[index + 1];
        index += 1;
        continue;
      }
      normalized += "\ufffd";
      continue;
    }
    normalized += codeUnit >= 0xdc00 && codeUnit <= 0xdfff
      ? "\ufffd"
      : value[index];
  }
  return normalized;
}

// Antigravity CLI 1.1.13 rewrites settings through an atomic rename whenever
// these bytes differ. Interactive AppArmor profiles deliberately deny writes
// to the destination settings file, so every App-owned writer must emit this
// exact native representation before launching the CLI.
function nativeCanonicalSettingsValue(value, expectedToolPermission) {
  if (!isPlainObject(value) ||
      !TELEGRAM_EFFECTIVE_TOOL_PERMISSIONS.has(expectedToolPermission)) {
    throw new Error("Antigravity settings cannot be canonically serialized");
  }
  // The native top-level decoder replaces each unpaired UTF-16 surrogate in a
  // property name with U+FFFD. If two names normalize to the same value, the
  // later source property wins. Map plus Object.fromEntries preserves that
  // behavior without invoking the legacy __proto__ object setter. Nested JSON
  // remains raw structured data and must not receive this key normalization.
  const normalizedEntries = new Map();
  for (const key of nativeSourceOrderedTopLevelKeys(value)) {
    normalizedEntries.set(nativeTopLevelKey(key), value[key]);
  }
  const normalized = Object.fromEntries(normalizedEntries);
  delete normalized.enableTerminalSandbox;
  // Native 1.1.13 omits these values as their schema defaults. Other values,
  // including explicit false for the two UI booleans, remain serialized.
  if (normalized.showTips === true) delete normalized.showTips;
  if (normalized.showFeedbackSurvey === true) {
    delete normalized.showFeedbackSurvey;
  }
  if (normalized.allowNonWorkspaceAccess === false) {
    delete normalized.allowNonWorkspaceAccess;
  }
  if (normalized.modelProvider === "") delete normalized.modelProvider;
  if (normalized.disableSlashCommands === false) {
    delete normalized.disableSlashCommands;
  }
  if (normalized.clearScrollbackOnResize === true) {
    delete normalized.clearScrollbackOnResize;
  }
  if (normalized.notifications === false) delete normalized.notifications;
  if (expectedToolPermission === "always-proceed") {
    normalized.toolPermission = "always-proceed";
  } else {
    delete normalized.toolPermission;
  }
  if (Object.hasOwn(normalized, "permissions")) {
    if (!isPlainObject(normalized.permissions)) {
      throw new Error("Antigravity permissions must be a JSON object");
    }
    const allow = normalized.permissions.allow;
    const deny = normalized.permissions.deny;
    const ask = normalized.permissions.ask ?? [];
    if (![allow, deny, ask].every(
      (bucket) => Array.isArray(bucket) &&
        bucket.every((rule) => typeof rule === "string"),
    )) {
      throw new Error("Antigravity permission buckets must be string arrays");
    }
    normalized.permissions = {
      allow: [...allow],
      deny: [...deny],
      ...(ask.length > 0 ? { ask: [...ask] } : {}),
    };
  }
  return Object.fromEntries(
    Object.keys(normalized)
      .sort(nativeTopLevelKeyCompare)
      .map((key) => [key, normalized[key]]),
  );
}

function nativeJsonStringify(value, indentation) {
  // Antigravity 1.1.13 serializes settings with Go's encoding/json defaults.
  // JSON.stringify leaves these five code points literal, while encoding/json
  // escapes them in every JSON string, including object keys and nested values.
  // Keep nested object insertion order intact and transform only the bytes that
  // differ from the native encoder.
  return JSON.stringify(value, null, indentation)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function nativeCanonicalSettingsContent(value, expectedToolPermission) {
  const normalized = nativeCanonicalSettingsValue(
    value,
    expectedToolPermission,
  );
  const keys = Object.keys(normalized).sort(nativeTopLevelKeyCompare);
  if (keys.length === 0) return Buffer.from("{}\n", "utf8");
  const properties = keys.map((key) => {
    const serialized = nativeJsonStringify(normalized[key], 2).replaceAll(
      "\n",
      "\n  ",
    );
    return `  ${nativeJsonStringify(key)}: ${serialized}`;
  });
  return Buffer.from(`{\n${properties.join(",\n")}\n}\n`, "utf8");
}

function sameRuleSet(actual, expected) {
  return (
    actual.every((rule) => expected.has(rule)) &&
    [...expected].every((rule) => actual.includes(rule))
  );
}

function assertTelegramPermissionBoundary(value, expectedToolPermission) {
  const expectedPermissionKeys = expectedToolPermission === "always-proceed"
    ? ["allow", "deny"]
    : ["allow", "deny", "ask"];
  const toolPermissionIsCanonical = expectedToolPermission === "always-proceed"
    ? value?.toolPermission === "always-proceed"
    : !Object.hasOwn(value ?? {}, "toolPermission");
  if (!isPlainObject(value) ||
      !TELEGRAM_EFFECTIVE_TOOL_PERMISSIONS.has(expectedToolPermission) ||
      !toolPermissionIsCanonical ||
      Object.hasOwn(value, "enableTerminalSandbox") ||
      value.allowNonWorkspaceAccess !== true ||
      value.artifactReviewPolicy !== "agent-decides" ||
      !isPlainObject(value.permissions) ||
      JSON.stringify(Object.keys(value.permissions)) !==
        JSON.stringify(expectedPermissionKeys) ||
      !expectedPermissionKeys.every((bucket) =>
        Array.isArray(value.permissions[bucket]) &&
        value.permissions[bucket].every((rule) => typeof rule === "string"))) {
    throw new Error(
      "effective Antigravity permissions are not valid for Telegram; select reset_v2 in the App user-file update option and restart",
    );
  }
  const { allow, deny } = value.permissions;
  const ask = value.permissions.ask ?? [];
  const allRules = [...allow, ...ask, ...deny];
  const expected = canonicalTelegramPermissionRules(expectedToolPermission);
  if (new Set(allRules).size !== allRules.length ||
      !sameRuleSet(allow, new Set(expected.allow)) ||
      !sameRuleSet(ask, new Set(expected.ask)) ||
      !sameRuleSet(deny, new Set(expected.deny)) ||
      (expectedToolPermission === "request-review" &&
        TELEGRAM_REQUIRED_PROPOSAL_RULES.some((rule) => !allow.includes(rule)))) {
    throw new Error(
      "effective Antigravity permissions would bypass or block the configured Telegram policy; select reset_v2 in the App user-file update option and restart",
    );
  }
  return {
    toolPermission: expectedToolPermission,
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
  isNativeRawJsonNumber,
  nativeCanonicalSettingsContent,
  nativeCanonicalSettingsValue,
  nativeParseJsonContent,
  nativeSettingsToolPermission,
};
