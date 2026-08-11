import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import net from "node:net";
import { basename, dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { consumeSupervisorCredentialFromInheritedFd } from "./supervisor-credential-fd.mjs";

export const DEFAULT_SOCKET_PATH = "/run/antigravity-ha/change-broker.sock";
export const DEFAULT_PROPOSAL_SOCKET_PATH = "/run/antigravity-ha/change-proposal.sock";
export const DEFAULT_CONFIG_ROOT = "/config";
export const DEFAULT_DATA_ROOT = "/data/antigravity-ha/change-broker";

const SERVER_NAME = "antigravity-ha-change-broker";
const SERVER_VERSION = "1.2.0";
const STATE_VERSION = 1;
const MAX_SOCKET_MESSAGE_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_PUBLIC_PREVIEW_BYTES = 16 * 1024;
const MAX_PREVIEW_LINES_PER_SIDE = 12;
const MAX_PREVIEW_LINE_CODEPOINTS = 80;
const MAX_MEMORY_COMMAND_BYTES = 64 * 1024;
const MAX_ACTIVATION_HELPERS = 50;
const MAX_PROPOSALS = 128;
const MAX_COMPLETED_ENTRIES = 256;
const DEFAULT_PROPOSAL_TTL_SECONDS = 120;
const MAX_PROPOSAL_TTL_SECONDS = 300;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_CONFIG_EXTENSIONS = new Set([".yaml", ".yml"]);
const SUPPORTED_CONFIG_ACTIVATIONS = new Set(["input_boolean_reload"]);
const SUPPORTED_SERVICE_CALLS = new Set([
  "input_boolean.turn_off",
  "input_boolean.turn_on",
  "light.turn_off",
  "light.turn_on",
  "switch.turn_off",
  "switch.turn_on",
]);
// Keep transient tests as a separate operation contract even though the first
// service leg currently has the same narrow domain/service allowlist as a
// persistent service call. A device test must always execute and verify its
// broker-derived restore leg.
const SUPPORTED_DEVICE_TESTS = new Set([
  "input_boolean.turn_off",
  "input_boolean.turn_on",
  "light.turn_off",
  "light.turn_on",
  "switch.turn_off",
  "switch.turn_on",
]);
const UNSUPPORTED_OPERATIONS = new Set(["restart", "update", "restore", "delete"]);
const HIGH_RISK_CONFIG_NAMES = new Set([
  "automations.yaml",
  "configuration.yaml",
  "scenes.yaml",
  "scripts.yaml",
]);
const HIGH_RISK_TEXT = /(?:\b(?:alarm|boiler|credential|delete|door|garage|gate|heat|host|lock|password|restart|restore|secret|token|valve|water)\b|(?:경보|난방|도어|문|물|밸브|보일러|비밀번호|삭제|열기|잠금|재시작|토큰))/iu;
const HIGH_RISK_CONFIG_CONTENT = /(?:alarm_control_panel\s*\.\s*alarm_disarm|cover\s*\.\s*open_cover|homeassistant\s*\.\s*(?:restart|stop)|lock\s*\.\s*unlock|shell_command\s*:|command_line\s*:|rest_command\s*:|python_script\s*:|update\s*\.\s*install)/iu;
const SENSITIVE_YAML_KEY = /(?:^|[_\s-])(?:access[_\s-]?key|api[_\s-]?key|auth(?:orization)?|bearer|client[_\s-]?secret|credential|email|key|latitude|location|longitude|pass(?:code|phrase|word)?|pin|private[_\s-]?key|secret|ssid|token|username|webhook)(?:$|[_\s-])|(?:비밀|암호|토큰|인증|자격)/iu;
const SENSITIVE_YAML_VALUE = /(?:!secret\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bbearer\s+\S|(?:password|passcode|secret|token|api[_-]?key|authorization)\s*[=:]|[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/iu;
const SENSITIVE_PATH_SEGMENTS = new Set([
  ".cloud",
  ".ssh",
  ".storage",
  "backups",
  "ssl",
]);
const SOCKET_ACTIONS = Object.freeze({
  proposal: new Set(["health", "propose"]),
  coordinator: new Set(["health", "inspect", "authorize", "execute", "execute_status"]),
});

export class BrokerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new BrokerError("invalid_request", `${label} must be an object`);
  }
  return value;
}

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new BrokerError("invalid_request", `${label} contains an unsupported field`);
  }
}

function requireString(value, label, { min = 1, max = 512, pattern } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new BrokerError("invalid_request", `${label} is invalid`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new BrokerError("invalid_request", `${label} contains control characters`);
  }
  if (pattern && !pattern.test(value)) {
    throw new BrokerError("invalid_request", `${label} has an invalid format`);
  }
  return value;
}

function normalizeRequester(value) {
  const requester = assertPlainObject(value, "requester");
  assertOnlyKeys(requester, new Set(["surface", "user_id", "chat_id"]), "requester");
  if (requester.surface !== "telegram") {
    throw new BrokerError("invalid_request", "requester.surface must be telegram");
  }
  return {
    surface: "telegram",
    user_id: requireString(requester.user_id, "requester.user_id", {
      max: 20,
      pattern: /^[1-9][0-9]{0,19}$/u,
    }),
    chat_id: requireString(requester.chat_id, "requester.chat_id", {
      max: 21,
      pattern: /^-?[1-9][0-9]{0,19}$/u,
    }),
  };
}

function normalizeSummary(value) {
  return requireString(value, "summary", { max: 500 }).replace(/\s+/gu, " ").trim();
}

function normalizeConfigActivation(value) {
  if (value === undefined) return null;
  const activation = assertPlainObject(value, "payload.activation");
  assertOnlyKeys(activation, new Set(["kind"]), "payload.activation");
  const kind = requireString(activation.kind, "payload.activation.kind", {
    max: 64,
    pattern: /^[a-z_]+$/u,
  });
  if (!SUPPORTED_CONFIG_ACTIVATIONS.has(kind)) {
    throw new BrokerError("unsupported_activation", "configuration activation is not supported");
  }
  return { kind };
}

function stripYamlComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"') {
      if (character === "\\") index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'" && value[index + 1] === "'") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/u.test(value[index - 1]))) {
      return value.slice(0, index);
    }
  }
  if (quote !== null) {
    throw new BrokerError("unsupported_config_syntax", "input_boolean YAML contains an unterminated quote");
  }
  return value;
}

function parseRestrictedNameScalar(value) {
  const candidate = value.trim();
  let parsed;
  if (candidate.startsWith('"')) {
    try {
      parsed = JSON.parse(candidate);
    } catch {
      throw new BrokerError("unsupported_config_syntax", "input_boolean name must be a bounded scalar");
    }
  } else if (candidate.startsWith("'")) {
    if (!candidate.endsWith("'") || candidate.length < 2) {
      throw new BrokerError("unsupported_config_syntax", "input_boolean name must be a bounded scalar");
    }
    const inner = candidate.slice(1, -1);
    if (/(?:^|[^'])'(?:[^']|$)/u.test(inner)) {
      throw new BrokerError("unsupported_config_syntax", "input_boolean single quotes must be escaped");
    }
    parsed = inner.replace(/''/gu, "'");
  } else {
    parsed = candidate;
    if (!/^[\p{L}\p{N} _./%+()'-]{1,100}$/u.test(parsed)) {
      throw new BrokerError("unsupported_config_syntax", "input_boolean name uses unsupported YAML syntax");
    }
  }
  if (
    typeof parsed !== "string" ||
    parsed.length < 1 ||
    Array.from(parsed).length > 100 ||
    /[\u0000-\u001f\u007f]/u.test(parsed) ||
    SENSITIVE_YAML_VALUE.test(parsed) ||
    /[A-Za-z0-9_-]{48,}/u.test(parsed)
  ) {
    throw new BrokerError("unsafe_expectation", "input_boolean name is unsafe for verified memory");
  }
  return parsed;
}

function parseRestrictedInputBooleanYaml(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  if (text.includes("\uFFFD") || /\t|\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new BrokerError("unsupported_config_syntax", "input_boolean YAML contains unsafe characters");
  }
  const helpers = new Map();
  let current = null;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = stripYamlComment(rawLine).replace(/\s+$/u, "");
    if (line.trim() === "") continue;
    const helper = /^([a-z][a-z0-9_]*)\s*:\s*$/u.exec(line);
    if (helper) {
      if (helpers.has(helper[1])) {
        throw new BrokerError("unsupported_config_syntax", "input_boolean YAML contains a duplicate helper");
      }
      if (helpers.size >= 500) {
        throw new BrokerError("unsupported_config_syntax", "input_boolean YAML exceeds the helper limit");
      }
      current = {};
      helpers.set(helper[1], current);
      continue;
    }
    const option = /^ {2}(name|icon|initial)\s*:\s*(.+?)\s*$/u.exec(line);
    if (!option || current === null || own(current, option[1])) {
      throw new BrokerError(
        "unsupported_config_syntax",
        "input_boolean YAML must be a flat helper map using only name, icon, and initial",
      );
    }
    if (option[1] === "name") current.name = parseRestrictedNameScalar(option[2]);
    else if (option[1] === "icon") {
      const icon = option[2].trim();
      if (!/^mdi:[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(icon) || icon.length > 100) {
        throw new BrokerError("unsupported_config_syntax", "input_boolean icon must be a canonical mdi icon");
      }
      current.icon = icon;
    } else {
      if (!/^(?:false|true)$/u.test(option[2].trim())) {
        throw new BrokerError("unsupported_config_syntax", "input_boolean initial must be true or false");
      }
      current.initial = option[2].trim() === "true";
    }
  }
  return helpers;
}

function canonicalInputBooleanInclude(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  if (text.includes("\uFFFD")) {
    throw new BrokerError("unsupported_activation", "configuration.yaml is not valid UTF-8");
  }
  const declarations = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = stripYamlComment(rawLine).trimEnd();
    if (/^input_boolean(?:\s+[^:]*)?\s*:/u.test(line)) declarations.push(line);
  }
  if (declarations.length !== 1) {
    throw new BrokerError(
      "unsupported_activation",
      "input_boolean activation requires one canonical top-level declaration",
    );
  }
  const include = /^input_boolean\s*:\s*!include\s+([a-z][a-z0-9_.-]*\.ya?ml)\s*$/u.exec(
    declarations[0],
  );
  if (!include) {
    throw new BrokerError(
      "unsupported_activation",
      "input_boolean activation requires an unquoted root-level !include file",
    );
  }
  return include[1];
}

function expectationForInputBoolean(helperId, definition, { added = false } = {}) {
  if (definition === null) return { exists: false };
  const expectation = { exists: true };
  const attributes = {};
  if (own(definition, "name")) attributes.friendly_name = definition.name;
  if (own(definition, "icon")) attributes.icon = definition.icon;
  if (Object.keys(attributes).length > 0) expectation.attributes = attributes;
  if (added && own(definition, "initial")) {
    expectation.state = definition.initial ? "on" : "off";
  }
  return expectation;
}

function inputBooleanActivationPlan(payload, current, configuration) {
  if (!payload.activation || payload.activation.kind !== "input_boolean_reload") {
    return null;
  }
  if (!/^[a-z][a-z0-9_-]*\.ya?ml$/u.test(payload.path) || payload.path === "configuration.yaml") {
    throw new BrokerError(
      "unsupported_activation",
      "input_boolean activation is limited to one root-level included YAML file",
    );
  }
  const includedPath = canonicalInputBooleanInclude(configuration.content);
  if (includedPath !== payload.path) {
    throw new BrokerError("unsupported_activation", "config target is not the active input_boolean include");
  }
  const before = parseRestrictedInputBooleanYaml(current.content ?? "");
  const after = parseRestrictedInputBooleanYaml(payload.content);
  if (current.digest === sha256Digest(payload.content)) {
    return {
      kind: "input_boolean_reload",
      reload_service: "input_boolean.reload",
      configuration_sha256: configuration.digest,
      subjects: [],
      expectations: null,
      rollback_expectations: null,
      changes: [],
    };
  }
  const changedIds = [...new Set([...before.keys(), ...after.keys()])]
    .filter((helperId) => stableStringify(before.get(helperId)) !== stableStringify(after.get(helperId)))
    .sort();
  if (changedIds.length === 0) {
    throw new BrokerError(
      "unverifiable_config_change",
      "format-only input_boolean changes do not have a fresh API postcondition",
    );
  }
  if (changedIds.length > MAX_ACTIVATION_HELPERS) {
    throw new BrokerError("unsupported_activation", "input_boolean change exceeds the verification limit");
  }
  const expectations = { states: {} };
  const rollbackExpectations = { states: {} };
  const changes = [];
  for (const helperId of changedIds) {
    const beforeDefinition = before.get(helperId) ?? null;
    const afterDefinition = after.get(helperId) ?? null;
    const subject = `entity:input_boolean.${helperId}`;
    if (
      beforeDefinition !== null &&
      afterDefinition !== null &&
      beforeDefinition.initial !== afterDefinition.initial
    ) {
      throw new BrokerError(
        "unverifiable_config_change",
        "changing initial on an existing input_boolean is not a reliable reload postcondition",
      );
    }
    if (
      beforeDefinition !== null &&
      afterDefinition !== null &&
      own(beforeDefinition, "name") &&
      !own(afterDefinition, "name")
    ) {
      throw new BrokerError(
        "unverifiable_config_change",
        "removing an input_boolean name has no stable fresh API expectation",
      );
    }
    if (
      beforeDefinition !== null &&
      afterDefinition !== null &&
      own(beforeDefinition, "icon") &&
      !own(afterDefinition, "icon")
    ) {
      throw new BrokerError(
        "unverifiable_config_change",
        "removing an input_boolean icon has no stable fresh API expectation",
      );
    }
    expectations.states[subject] = expectationForInputBoolean(
      helperId,
      afterDefinition,
      { added: beforeDefinition === null },
    );
    rollbackExpectations.states[subject] = expectationForInputBoolean(helperId, beforeDefinition);
    if (
      beforeDefinition !== null &&
      afterDefinition !== null &&
      !own(beforeDefinition, "icon") &&
      own(afterDefinition, "icon")
    ) {
      rollbackExpectations.states[subject].attributes = {
        ...(rollbackExpectations.states[subject].attributes ?? {}),
        icon: null,
      };
    }
    const verifiedFields = new Set(["exists"]);
    if (afterDefinition && own(afterDefinition, "name")) verifiedFields.add("attribute:friendly_name");
    if (
      (afterDefinition && own(afterDefinition, "icon")) ||
      (beforeDefinition && own(beforeDefinition, "icon"))
    ) verifiedFields.add("attribute:icon");
    if (beforeDefinition === null && afterDefinition && own(afterDefinition, "initial")) {
      verifiedFields.add("state");
    }
    changes.push({
      entity_id: `input_boolean.${helperId}`,
      change_kind: beforeDefinition === null ? "create" : afterDefinition === null ? "remove" : "update",
      verified_fields: [...verifiedFields].sort(),
    });
  }
  return {
    kind: "input_boolean_reload",
    reload_service: "input_boolean.reload",
    configuration_sha256: configuration.digest,
    subjects: changedIds.map((helperId) => `entity:input_boolean.${helperId}`),
    expectations,
    rollback_expectations: rollbackExpectations,
    changes,
  };
}

function previewCodePoints(value, limit = MAX_PREVIEW_LINE_CODEPOINTS) {
  const points = Array.from(value);
  if (points.length <= limit) return { value, truncated: false };
  return {
    value: `${points.slice(0, limit).join("")}… <line truncated>`,
    truncated: true,
  };
}

function normalizedYamlKey(value) {
  return value
    .trim()
    .replace(/^["']|["']$/gu, "")
    .toLocaleLowerCase("en-US");
}

function yamlKeyForPreview(value) {
  const candidate = value.trim();
  if (
    Array.from(candidate).length > MAX_PREVIEW_LINE_CODEPOINTS ||
    SENSITIVE_YAML_VALUE.test(candidate) ||
    /[A-Fa-f0-9]{24,}/u.test(candidate) ||
    /[A-Za-z0-9_-]{32,}/u.test(candidate)
  ) {
    return { value: "<key redacted>", redacted: true };
  }
  return { value: candidate, redacted: false };
}

function yamlValueIsSafeForPreview(value) {
  const candidate = value.trim();
  if (candidate === "" || /^(?:[>|][+-]?|null|~|true|false)$/iu.test(candidate)) return true;
  if (candidate.length > 120 || SENSITIVE_YAML_VALUE.test(candidate)) return false;
  if (/^(?:\[|\{|&|\*|!!)/u.test(candidate) || /\$\{|\{\{|\{%/u.test(candidate)) return false;
  if (/[A-Fa-f0-9]{24,}/u.test(candidate) || /[A-Za-z0-9_-]{32,}/u.test(candidate)) return false;
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(candidate)) return true;
  const unquoted = candidate.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2");
  return /^[\p{L}\p{N} _./:@%+(),#-]{1,120}$/u.test(unquoted) &&
    !SENSITIVE_YAML_VALUE.test(unquoted) &&
    !/[a-z][a-z0-9+.-]*:\/\//iu.test(unquoted);
}

function sanitizeYamlPreviewLines(lines, selectedIndices) {
  const selected = new Set(selectedIndices);
  const maximum = selectedIndices.length === 0 ? -1 : Math.max(...selectedIndices);
  const result = new Map();
  const stack = [];
  for (let index = 0; index <= maximum; index += 1) {
    const raw = lines[index] ?? "";
    const indentation = raw.match(/^ */u)?.[0].length ?? 0;
    while (stack.length > 0 && stack.at(-1).indentation >= indentation) stack.pop();
    const parentSensitive = stack.at(-1)?.sensitive === true;
    const trimmed = raw.trim();
    let text = "";
    let redacted = false;
    if (trimmed === "") {
      text = "";
    } else if (trimmed.startsWith("#")) {
      text = `${" ".repeat(indentation)}# <comment omitted>`;
      redacted = true;
    } else {
      const mapping = /^(\s*(?:-\s*)?)([^:#\n]+?):(?:\s*)(.*)$/u.exec(raw);
      if (mapping) {
        const key = normalizedYamlKey(mapping[2]);
        const previewKey = yamlKeyForPreview(mapping[2]);
        const valueWithComment = mapping[3];
        const commentIndex = valueWithComment.search(/\s+#/u);
        const value = commentIndex === -1
          ? valueWithComment
          : valueWithComment.slice(0, commentIndex);
        const sensitive = parentSensitive || SENSITIVE_YAML_KEY.test(key);
        const structural = /^(?:\s*|[>|][+-]?)$/u.test(value);
        stack.push({ indentation, sensitive });
        if (sensitive || !yamlValueIsSafeForPreview(value)) {
          text = `${mapping[1]}${previewKey.value}: ${structural ? "<redacted block>" : "<redacted>"}`;
          redacted = true;
        } else {
          text = `${mapping[1]}${previewKey.value}:${value === "" ? "" : ` ${value.trim()}`}`;
          redacted = previewKey.redacted;
          if (commentIndex !== -1) {
            text += " # <comment omitted>";
            redacted = true;
          }
        }
      } else if (/^\s*-\s+/u.test(raw)) {
        const prefix = raw.match(/^\s*-\s*/u)?.[0] ?? "- ";
        const value = raw.slice(prefix.length);
        if (parentSensitive || !yamlValueIsSafeForPreview(value)) {
          text = `${prefix}<redacted>`;
          redacted = true;
        } else {
          text = `${prefix}${value.trim()}`;
        }
      } else {
        text = `${" ".repeat(indentation)}<unparsed YAML line omitted>`;
        redacted = true;
      }
    }
    if (selected.has(index)) {
      const bounded = previewCodePoints(text);
      result.set(index, {
        line: index + 1,
        text: bounded.value,
        redacted,
        truncated: bounded.truncated,
      });
    }
  }
  return result;
}

function boundedChangedIndices(start, end) {
  const count = Math.max(0, end - start);
  if (count <= MAX_PREVIEW_LINES_PER_SIDE) {
    return {
      indices: Array.from({ length: count }, (_, offset) => start + offset),
      omitted: 0,
    };
  }
  const head = Math.ceil(MAX_PREVIEW_LINES_PER_SIDE / 2);
  const tail = MAX_PREVIEW_LINES_PER_SIDE - head;
  return {
    indices: [
      ...Array.from({ length: head }, (_, offset) => start + offset),
      ...Array.from({ length: tail }, (_, offset) => end - tail + offset),
    ],
    omitted: count - MAX_PREVIEW_LINES_PER_SIDE,
  };
}

function yamlLines(value) {
  if (value === null || value.length === 0) return [];
  return value.toString("utf8").split("\n").map((line) => line.replace(/\r$/u, ""));
}

function buildConfigPatchPreview(payload, current, activationPlan) {
  const beforeLines = yamlLines(current.content);
  const afterLines = yamlLines(Buffer.from(payload.content));
  let commonPrefix = 0;
  while (
    commonPrefix < beforeLines.length &&
    commonPrefix < afterLines.length &&
    beforeLines[commonPrefix] === afterLines[commonPrefix]
  ) {
    commonPrefix += 1;
  }
  let commonSuffix = 0;
  while (
    commonSuffix < beforeLines.length - commonPrefix &&
    commonSuffix < afterLines.length - commonPrefix &&
    beforeLines[beforeLines.length - 1 - commonSuffix] ===
      afterLines[afterLines.length - 1 - commonSuffix]
  ) {
    commonSuffix += 1;
  }
  const beforeEnd = beforeLines.length - commonSuffix;
  const afterEnd = afterLines.length - commonSuffix;
  const beforeSelection = boundedChangedIndices(commonPrefix, beforeEnd);
  const afterSelection = boundedChangedIndices(commonPrefix, afterEnd);
  const beforeSanitized = sanitizeYamlPreviewLines(beforeLines, beforeSelection.indices);
  const afterSanitized = sanitizeYamlPreviewLines(afterLines, afterSelection.indices);
  const replacementSha256 = sha256Digest(payload.content);
  const mutationSha256 = sha256Digest(stableStringify({
    operation: "config_patch",
    target: payload.path,
    expected_sha256: payload.expected_sha256,
    replacement_sha256: replacementSha256,
    activation: activationPlan
      ? {
          kind: activationPlan.kind,
          reload_service: activationPlan.reload_service,
          configuration_sha256: activationPlan.configuration_sha256,
          changes: activationPlan.changes,
        }
      : {
          kind: "none",
          executable: false,
          reason: "supported_activation_contract_required",
        },
  }));
  const preview = {
    format: "yaml-line-diff-v1",
    target: payload.path,
    change_kind: current.exists
      ? (current.digest === replacementSha256 ? "no_change" : "update")
      : "create",
    expected_sha256: payload.expected_sha256,
    replacement_sha256: replacementSha256,
    mutation_sha256: mutationSha256,
    replacement_bytes: Buffer.byteLength(payload.content),
    before_line_count: beforeLines.length,
    after_line_count: afterLines.length,
    before: beforeSelection.indices.map((index) => beforeSanitized.get(index)),
    after: afterSelection.indices.map((index) => afterSanitized.get(index)),
    omitted_before_lines: beforeSelection.omitted,
    omitted_after_lines: afterSelection.omitted,
    truncated: beforeSelection.omitted > 0 || afterSelection.omitted > 0 ||
      [...beforeSanitized.values(), ...afterSanitized.values()]
        .some((line) => line.truncated),
    activation: activationPlan
      ? {
          kind: activationPlan.kind,
          reload_service: activationPlan.reload_service,
          configuration_sha256: activationPlan.configuration_sha256,
          changes: activationPlan.changes,
        }
      : {
          kind: "none",
          executable: false,
          reason: "supported_activation_contract_required",
        },
  };
  if (Buffer.byteLength(JSON.stringify(preview)) > MAX_PUBLIC_PREVIEW_BYTES) {
    throw new BrokerError("preview_too_large", "safe configuration preview exceeded the limit");
  }
  return preview;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256Digest(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function opaqueId(bytes = 16) {
  return randomBytes(bytes).toString("base64url");
}

function constantTimeDigestMatch(expected, candidate) {
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  return expectedBuffer.length === candidateBuffer.length &&
    timingSafeEqual(expectedBuffer, candidateBuffer);
}

function normalizeRelativeConfigPath(value) {
  const input = requireString(value, "payload.path", { max: 240 });
  if (input.startsWith("/") || input.includes("\\") || input.endsWith("/")) {
    throw new BrokerError("unsafe_target", "config target must be a relative file path");
  }
  const normalized = posix.normalize(input);
  if (normalized !== input || normalized === "." || normalized.startsWith("../")) {
    throw new BrokerError("unsafe_target", "config target is not canonical");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new BrokerError("unsafe_target", "config target has an unsafe segment");
  }
  if (
    segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment)) ||
    segments.some((segment) => segment.startsWith(".")) ||
    basename(normalized) === "secrets.yaml" ||
    /home-assistant_v2\.db(?:-(?:shm|wal))?$/u.test(normalized)
  ) {
    throw new BrokerError("sensitive_target", "config target is protected");
  }
  if (!SUPPORTED_CONFIG_EXTENSIONS.has(extname(normalized).toLowerCase())) {
    throw new BrokerError("unsupported_target", "only YAML configuration files are supported");
  }
  return normalized;
}

function normalizeExpectedDigest(value) {
  if (value === "missing") return value;
  return requireString(value, "payload.expected_sha256", {
    min: 71,
    max: 71,
    pattern: /^sha256:[a-f0-9]{64}$/u,
  });
}

function normalizeConfigPatchPayload(value) {
  const payload = assertPlainObject(value, "payload");
  assertOnlyKeys(
    payload,
    new Set(["path", "expected_sha256", "content", "activation"]),
    "payload",
  );
  const content = requireString(payload.content, "payload.content", {
    max: MAX_CONFIG_BYTES,
  });
  if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) {
    throw new BrokerError("invalid_request", "payload.content is too large");
  }
  return {
    path: normalizeRelativeConfigPath(payload.path),
    expected_sha256: normalizeExpectedDigest(payload.expected_sha256),
    content,
    activation: normalizeConfigActivation(payload.activation),
  };
}

function normalizeEntityId(value) {
  return requireString(value, "payload.entity_id", {
    max: 255,
    pattern: /^[a-z0-9_]+\.[a-z0-9_]+$/u,
  });
}

function normalizeServiceCallPayload(value) {
  const payload = assertPlainObject(value, "payload");
  assertOnlyKeys(
    payload,
    new Set(["domain", "service", "entity_id", "expected_state"]),
    "payload",
  );
  const domain = requireString(payload.domain, "payload.domain", {
    max: 64,
    pattern: /^[a-z][a-z0-9_]*$/u,
  });
  const service = requireString(payload.service, "payload.service", {
    max: 64,
    pattern: /^[a-z][a-z0-9_]*$/u,
  });
  if (!SUPPORTED_SERVICE_CALLS.has(`${domain}.${service}`)) {
    throw new BrokerError("unsupported_service", "service call is outside the minimal allowlist");
  }
  const entityId = normalizeEntityId(payload.entity_id);
  if (!entityId.startsWith(`${domain}.`)) {
    throw new BrokerError("invalid_request", "entity domain does not match service domain");
  }
  const expectedState = requireString(payload.expected_state, "payload.expected_state", {
    max: 16,
    pattern: /^(?:off|on)$/u,
  });
  return {
    domain,
    service,
    entity_id: entityId,
    expected_state: expectedState,
    verify_state: service === "turn_on" ? "on" : "off",
  };
}

function normalizeDeviceTestPayload(value) {
  const payload = assertPlainObject(value, "payload");
  assertOnlyKeys(
    payload,
    new Set(["domain", "service", "entity_id", "expected_prior_state"]),
    "payload",
  );
  const domain = requireString(payload.domain, "payload.domain", {
    max: 64,
    pattern: /^[a-z][a-z0-9_]*$/u,
  });
  const service = requireString(payload.service, "payload.service", {
    max: 64,
    pattern: /^[a-z][a-z0-9_]*$/u,
  });
  if (!SUPPORTED_DEVICE_TESTS.has(`${domain}.${service}`)) {
    throw new BrokerError("unsupported_device_test", "device test is outside the transient allowlist");
  }
  const entityId = normalizeEntityId(payload.entity_id);
  if (!entityId.startsWith(`${domain}.`)) {
    throw new BrokerError("invalid_request", "entity domain does not match device test domain");
  }
  const expectedPriorState = requireString(
    payload.expected_prior_state,
    "payload.expected_prior_state",
    {
      max: 16,
      pattern: /^(?:off|on)$/u,
    },
  );
  const testState = service === "turn_on" ? "on" : "off";
  if (expectedPriorState === testState) {
    throw new BrokerError(
      "invalid_device_test",
      "device test target must differ from the expected prior state",
    );
  }
  return {
    domain,
    service,
    entity_id: entityId,
    expected_prior_state: expectedPriorState,
    test_state: testState,
    restore_service: expectedPriorState === "on" ? "turn_on" : "turn_off",
  };
}

function classifyRisk(operation, payload, summary, activationPlan = null) {
  if (operation === "config_patch") {
    if (
      payload.activation?.kind !== "input_boolean_reload" ||
      activationPlan?.kind !== "input_boolean_reload" ||
      !Array.isArray(activationPlan.changes) ||
      !activationPlan.changes.every((change) => change.change_kind === "update") ||
      !/^[a-z][a-z0-9_-]*\.ya?ml$/u.test(payload.path)
    ) {
      return "high";
    }
    if (
      HIGH_RISK_CONFIG_NAMES.has(basename(payload.path)) ||
      HIGH_RISK_TEXT.test(payload.path.replace(/[./_-]+/gu, " ")) ||
      HIGH_RISK_TEXT.test(summary) ||
      HIGH_RISK_CONFIG_CONTENT.test(payload.content) ||
      SENSITIVE_YAML_KEY.test(payload.content) ||
      SENSITIVE_YAML_VALUE.test(payload.content)
    ) {
      return "high";
    }
    return "low";
  }
  if (operation === "service_call") {
    return "high";
  }
  if (operation === "device_test") {
    return "high";
  }
  return "high";
}

function normalizeProposal(value, nowMs) {
  const input = assertPlainObject(value, "proposal");
  assertOnlyKeys(
    input,
    new Set(["requester", "operation", "summary", "payload", "ttl_seconds"]),
    "proposal",
  );
  const requester = normalizeRequester(input.requester);
  const operation = requireString(input.operation, "operation", {
    max: 32,
    pattern: /^[a-z_]+$/u,
  });
  if (UNSUPPORTED_OPERATIONS.has(operation)) {
    throw new BrokerError("unsupported_operation", `${operation} is not implemented by this broker`);
  }
  if (
    operation !== "config_patch" &&
    operation !== "service_call" &&
    operation !== "device_test"
  ) {
    throw new BrokerError("unsupported_operation", "operation is not implemented by this broker");
  }
  const summary = normalizeSummary(input.summary);
  let ttlSeconds = DEFAULT_PROPOSAL_TTL_SECONDS;
  if (own(input, "ttl_seconds")) {
    if (
      !Number.isInteger(input.ttl_seconds) ||
      input.ttl_seconds < 30 ||
      input.ttl_seconds > MAX_PROPOSAL_TTL_SECONDS
    ) {
      throw new BrokerError("invalid_request", "ttl_seconds must be between 30 and 300");
    }
    ttlSeconds = input.ttl_seconds;
  }
  const payload = operation === "config_patch"
    ? normalizeConfigPatchPayload(input.payload)
    : operation === "service_call"
      ? normalizeServiceCallPayload(input.payload)
      : normalizeDeviceTestPayload(input.payload);
  const expiresAtMs = nowMs + ttlSeconds * 1000;
  return {
    requester,
    operation,
    summary,
    payload,
    expires_at_ms: expiresAtMs,
  };
}

function bindProposalPreview(proposal, preview) {
  const digestInput = {
    version: 2,
    requester: proposal.requester,
    operation: proposal.operation,
    payload: proposal.payload,
    activation_plan: proposal.activation_plan ?? null,
    preview,
    risk: proposal.risk,
  };
  return {
    ...proposal,
    preview,
    preview_digest: sha256Digest(stableStringify(digestInput)),
  };
}

async function fsyncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path, contents, mode = 0o600) {
  const parent = dirname(path);
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${opaqueId(8)}`);
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  await chmod(temporary, mode);
  await rename(temporary, path);
  await fsyncDirectory(parent);
}

async function ensurePrivateDirectory(path, requiredUid) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== requiredUid) {
    throw new BrokerError("unsafe_storage", "broker storage directory is unsafe");
  }
  if ((info.mode & 0o777) !== 0o700) {
    throw new BrokerError("unsafe_storage", "broker storage directory permissions are unsafe");
  }
}

async function assertNoSymlinkComponents(rootPath, relativePath) {
  const segments = relativePath.split("/");
  let current = rootPath;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new BrokerError("unsafe_target", "config target parent is unsafe");
    }
  }
}

function safeExecutionResult(error, operation) {
  if (error instanceof BrokerError) {
    if (["config_verification_in_doubt", "execution_in_doubt", "rollback_failed"].includes(error.code)) {
      return {
        status: "in_doubt",
        operation,
        reason: error.code,
        changed: null,
      };
    }
    return {
      status: "failed",
      operation,
      reason: error.code,
      changed: false,
    };
  }
  return {
    status: "in_doubt",
    operation,
    reason: "internal_error",
    changed: null,
  };
}

function requesterHash(requester) {
  return sha256Digest(stableStringify(requester)).slice(7, 19);
}

function runBoundedJsonCommand(command, argumentsList, {
  spawnImpl = spawn,
  timeoutMs = 60_000,
} = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    let child;
    try {
      child = spawnImpl(command, argumentsList, {
        env: {
          HOME: "/tmp",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      rejectCommand(new BrokerError("memory_unavailable", "semantic memory process is unavailable"));
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let terminalError = null;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectCommand(error);
    };
    const timer = setTimeout(() => {
      terminalError = new BrokerError("memory_timeout", "semantic memory process timed out");
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (terminalError) return;
      if (stdout.length + chunk.length > MAX_MEMORY_COMMAND_BYTES) {
        terminalError = new BrokerError("memory_protocol_error", "semantic memory output exceeded its limit");
        child.kill("SIGKILL");
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_MEMORY_COMMAND_BYTES && !terminalError) {
        terminalError = new BrokerError("memory_protocol_error", "semantic memory error output exceeded its limit");
        child.kill("SIGKILL");
      }
    });
    child.once("error", () => fail(
      new BrokerError("memory_unavailable", "semantic memory process could not start"),
    ));
    child.once("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (terminalError) {
        fail(terminalError);
        return;
      }
      if (code !== 0) {
        fail(new BrokerError("memory_unavailable", "semantic memory command failed"));
        return;
      }
      let result;
      try {
        result = JSON.parse(stdout.toString("utf8"));
      } catch {
        fail(new BrokerError("memory_protocol_error", "semantic memory returned invalid JSON"));
        return;
      }
      if (!isPlainObject(result)) {
        fail(new BrokerError("memory_protocol_error", "semantic memory returned an invalid result"));
        return;
      }
      settled = true;
      resolveCommand(result);
    });
  });
}

function createMemoryChangeAdapter() {
  return {
    begin({ summary, subjects, expectations }) {
      return runBoundedJsonCommand(
        "/usr/local/bin/ha-memory",
        [
          "change",
          "begin",
          "--summary",
          summary,
          "--subjects-json",
          JSON.stringify(subjects),
          "--expect-json",
          JSON.stringify(expectations),
        ],
        { timeoutMs: 30_000 },
      );
    },
    verify({ changeId, expectations }) {
      return runBoundedJsonCommand(
        "/usr/local/bin/ha-memory",
        [
          "change",
          "verify",
          String(changeId),
          "--expect-json",
          JSON.stringify(expectations),
        ],
        { timeoutMs: 60_000 },
      );
    },
  };
}

export class ChangeBroker {
  constructor({
    socketPath = DEFAULT_SOCKET_PATH,
    proposalSocketPath = DEFAULT_PROPOSAL_SOCKET_PATH,
    configRoot = DEFAULT_CONFIG_ROOT,
    dataRoot = DEFAULT_DATA_ROOT,
    supervisorToken,
    supervisorUrl = "http://supervisor",
    haUrl = "http://supervisor/core/api",
    fetchImpl = globalThis.fetch,
    memoryChange = createMemoryChangeAdapter(),
    now = () => Date.now(),
    sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
    audit = (event, fields = {}) => console.log(JSON.stringify({ service: SERVER_NAME, event, ...fields })),
    requiredUid = typeof process.getuid === "function" ? process.getuid() : 0,
  } = {}) {
    this.socketPath = socketPath;
    this.proposalSocketPath = proposalSocketPath;
    this.configRoot = resolve(configRoot);
    this.dataRoot = resolve(dataRoot);
    this.backupRoot = join(this.dataRoot, "backups");
    this.statePath = join(this.dataRoot, "idempotency.json");
    this.supervisorToken = supervisorToken;
    this.supervisorUrl = supervisorUrl.replace(/\/$/u, "");
    this.haUrl = haUrl.replace(/\/$/u, "");
    this.fetchImpl = fetchImpl;
    this.memoryChange = memoryChange;
    this.now = now;
    this.sleep = sleep;
    this.audit = audit;
    this.requiredUid = requiredUid;
    this.proposals = new Map();
    this.capabilities = new Map();
    this.idempotency = new Map();
    this.executionJobs = new Map();
    this.servers = new Map();
    this.executionTail = Promise.resolve();
    this.configRootReal = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    if (
      typeof this.supervisorToken !== "string" ||
      this.supervisorToken === "" ||
      this.supervisorToken.length > 16_384 ||
      /[\u0000-\u001f\u007f]/u.test(this.supervisorToken)
    ) {
      throw new BrokerError("credential_unavailable", "Supervisor credential is unavailable");
    }
    if (typeof this.fetchImpl !== "function") {
      throw new BrokerError("runtime_unavailable", "fetch runtime is unavailable");
    }
    if (
      !isPlainObject(this.memoryChange) ||
      typeof this.memoryChange.begin !== "function" ||
      typeof this.memoryChange.verify !== "function"
    ) {
      throw new BrokerError("runtime_unavailable", "semantic memory adapter is unavailable");
    }
    this.configRootReal = await realpath(this.configRoot);
    const configInfo = await lstat(this.configRootReal);
    if (!configInfo.isDirectory() || configInfo.isSymbolicLink()) {
      throw new BrokerError("unsafe_config_root", "config root is unsafe");
    }
    await ensurePrivateDirectory(this.dataRoot, this.requiredUid);
    await ensurePrivateDirectory(this.backupRoot, this.requiredUid);
    await this.#loadIdempotencyState();
    this.initialized = true;
  }

  async start() {
    await this.initialize();
    if (this.servers.size > 0) {
      throw new BrokerError("already_running", "broker is already running");
    }
    if (resolve(this.socketPath) === resolve(this.proposalSocketPath)) {
      throw new BrokerError("unsafe_socket", "broker sockets must use distinct paths");
    }
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await mkdir(dirname(this.proposalSocketPath), { recursive: true, mode: 0o700 });
    try {
      await this.#startListener(this.proposalSocketPath, "proposal");
      await this.#startListener(this.socketPath, "coordinator");
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
    this.audit("ready", { sockets: 2 });
  }

  async close() {
    const listeners = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(listeners.map(({ server }) => new Promise((resolveClose) => {
      server.close(() => resolveClose());
    })));
    for (const { socketPath } of listeners) {
      await unlink(socketPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async #startListener(socketPath, role) {
    try {
      const existing = await lstat(socketPath);
      if (!existing.isSocket() || existing.isSymbolicLink()) {
        throw new BrokerError("unsafe_socket", "broker socket path is occupied by an unsafe file");
      }
      await unlink(socketPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const server = net.createServer((socket) => this.#handleSocket(socket, role));
    server.on("error", (error) => {
      this.audit("server_error", { role, code: String(error?.code || "unknown") });
    });
    await new Promise((resolveStart, rejectStart) => {
      const onError = (error) => {
        server.off("listening", onListening);
        rejectStart(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolveStart();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });
    this.servers.set(role, { server, socketPath });
    await chmod(socketPath, 0o600);
  }

  async dispatch(action, payload = {}) {
    await this.initialize();
    this.#cleanupExpired();
    switch (action) {
      case "health":
        return {
          status: "ready",
          version: SERVER_VERSION,
          proposals: this.proposals.size,
          idempotency_entries: this.idempotency.size,
          executions_active: this.executionJobs.size,
        };
      case "propose":
        return this.propose(payload.proposal);
      case "inspect":
        return this.inspect(payload);
      case "authorize":
        return this.authorize(payload);
      case "execute":
        return this.startExecution(payload);
      case "execute_status":
        return this.executionStatus(payload);
      default:
        throw new BrokerError("unsupported_action", "broker action is not supported");
    }
  }

  async propose(input) {
    if (this.proposals.size >= MAX_PROPOSALS) {
      throw new BrokerError("proposal_capacity", "proposal capacity is exhausted");
    }
    const normalized = normalizeProposal(input, this.now());
    let preview;
    let activationPlan = null;
    if (normalized.operation === "config_patch") {
      const target = await this.#resolveConfigTarget(normalized.payload.path);
      const current = await this.#readConfigTarget(target);
      if (current.digest !== normalized.payload.expected_sha256) {
        throw new BrokerError(
          "precondition_failed",
          "config target does not match the proposed expected digest",
        );
      }
      if (normalized.payload.activation !== null) {
        const configurationTarget = await this.#resolveConfigTarget("configuration.yaml");
        const configuration = await this.#readConfigTarget(configurationTarget);
        if (!configuration.exists) {
          throw new BrokerError("unsupported_activation", "configuration.yaml is unavailable");
        }
        activationPlan = inputBooleanActivationPlan(normalized.payload, current, configuration);
      }
      preview = buildConfigPatchPreview(normalized.payload, current, activationPlan);
    } else if (normalized.operation === "service_call") {
      preview = {
        summary: normalized.summary,
        service: `${normalized.payload.domain}.${normalized.payload.service}`,
        entity_id: normalized.payload.entity_id,
        expected_state: normalized.payload.expected_state,
        verify_state: normalized.payload.verify_state,
      };
    } else {
      preview = {
        format: "device-test-plan-v1",
        summary: normalized.summary,
        entity_id: normalized.payload.entity_id,
        precondition: {
          expected_prior_state: normalized.payload.expected_prior_state,
          fresh_read_required: true,
        },
        test: {
          service: `${normalized.payload.domain}.${normalized.payload.service}`,
          verify_state: normalized.payload.test_state,
          fresh_verification_required: true,
        },
        restore: {
          service: `${normalized.payload.domain}.${normalized.payload.restore_service}`,
          verify_state: normalized.payload.expected_prior_state,
          always: true,
          fresh_verification_required: true,
        },
      };
    }
    const risk = classifyRisk(
      normalized.operation,
      normalized.payload,
      normalized.summary,
      activationPlan,
    );
    const proposal = bindProposalPreview({
      ...normalized,
      activation_plan: activationPlan,
      risk,
    }, preview);
    // Config preview generation performs filesystem I/O, so another request may
    // have consumed the last slot while this proposal was awaiting it.
    if (this.proposals.size >= MAX_PROPOSALS) {
      throw new BrokerError("proposal_capacity", "proposal capacity is exhausted");
    }
    const proposalId = opaqueId(16);
    const stored = { ...proposal, proposal_id: proposalId };
    this.proposals.set(proposalId, stored);
    this.audit("proposal_created", {
      operation: proposal.operation,
      risk: proposal.risk,
      requester: requesterHash(proposal.requester),
    });
    return this.#publicProposal(stored);
  }

  inspect(input) {
    const value = assertPlainObject(input, "inspection");
    assertOnlyKeys(value, new Set(["proposal_id", "requester"]), "inspection");
    const proposal = this.#requireLiveProposal(value.proposal_id);
    const requester = normalizeRequester(value.requester);
    this.#assertRequesterBinding(proposal, requester);
    return this.#publicProposal(proposal);
  }

  authorize(input) {
    const value = assertPlainObject(input, "authorization");
    assertOnlyKeys(
      value,
      new Set(["proposal_id", "requester", "preview_digest", "authorization"]),
      "authorization",
    );
    const proposal = this.#requireLiveProposal(value.proposal_id);
    const requester = normalizeRequester(value.requester);
    this.#assertBinding(proposal, requester, value.preview_digest);
    const authorization = requireString(value.authorization, "authorization", {
      max: 32,
      pattern: /^(?:autonomous_policy|human_confirmed)$/u,
    });
    if (authorization === "autonomous_policy" && proposal.risk !== "low") {
      throw new BrokerError("human_confirmation_required", "high-risk proposal requires human confirmation");
    }
    if (this.capabilities.has(proposal.proposal_id)) {
      throw new BrokerError("already_authorized", "proposal already has an active capability");
    }
    const capability = opaqueId(32);
    this.capabilities.set(proposal.proposal_id, {
      digest: sha256Digest(capability),
      requester_digest: sha256Digest(stableStringify(requester)),
      preview_digest: proposal.preview_digest,
      expires_at_ms: proposal.expires_at_ms,
    });
    this.audit("proposal_authorized", {
      operation: proposal.operation,
      risk: proposal.risk,
      authorization,
      requester: requesterHash(requester),
    });
    return {
      proposal_id: proposal.proposal_id,
      preview_digest: proposal.preview_digest,
      capability,
      expires_at: new Date(proposal.expires_at_ms).toISOString(),
    };
  }

  #executionState(scopeDigest, { replayed = false, accepted = false } = {}) {
    const entry = this.idempotency.get(scopeDigest);
    if (!entry) {
      throw new BrokerError("execution_not_found", "execution record does not exist");
    }
    if (this.executionJobs.has(scopeDigest)) {
      return {
        status: accepted ? "accepted" : "running",
        operation: entry.operation,
        replayed,
      };
    }
    if (entry.status === "completed") {
      return {
        status: "completed",
        operation: entry.operation,
        result: entry.result,
        replayed,
      };
    }
    return {
      status: "in_doubt",
      operation: entry.operation,
      reason: "previous_attempt_not_proven_complete",
      replayed,
    };
  }

  async #startExecutionInternal(input) {
    const value = assertPlainObject(input, "execution");
    assertOnlyKeys(
      value,
      new Set(["proposal_id", "requester", "preview_digest", "capability", "idempotency_key"]),
      "execution",
    );
    const requester = normalizeRequester(value.requester);
    const proposalId = requireString(value.proposal_id, "proposal_id", {
      max: 64,
      pattern: /^[A-Za-z0-9_-]+$/u,
    });
    const previewDigest = normalizeExpectedDigest(value.preview_digest);
    const idempotencyKey = requireString(value.idempotency_key, "idempotency_key", {
      min: 8,
      max: 128,
      pattern: /^[A-Za-z0-9._:@+-]+$/u,
    });
    const scopeDigest = sha256Digest(stableStringify({ requester, idempotency_key: idempotencyKey }));
    const existing = this.idempotency.get(scopeDigest);
    if (existing) {
      if (
        existing.proposal_id !== proposalId ||
        existing.preview_digest !== previewDigest
      ) {
        throw new BrokerError("idempotency_conflict", "idempotency key is bound to another proposal");
      }
      return {
        state: this.#executionState(scopeDigest, { replayed: true }),
        promise: this.executionJobs.get(scopeDigest) ?? null,
        replayed: true,
      };
    }

    const proposal = this.#requireLiveProposal(proposalId);
    this.#assertBinding(proposal, requester, previewDigest);
    const capability = requireString(value.capability, "capability", {
      min: 43,
      max: 64,
      pattern: /^[A-Za-z0-9_-]+$/u,
    });
    const storedCapability = this.capabilities.get(proposalId);
    if (
      !storedCapability ||
      storedCapability.expires_at_ms <= this.now() ||
      !constantTimeDigestMatch(
        storedCapability.requester_digest,
        sha256Digest(stableStringify(requester)),
      ) ||
      !constantTimeDigestMatch(storedCapability.preview_digest, previewDigest) ||
      !constantTimeDigestMatch(storedCapability.digest, sha256Digest(capability))
    ) {
      throw new BrokerError("invalid_capability", "capability is invalid, expired, or already consumed");
    }
    const inProgressEntry = {
      status: "in_progress",
      proposal_id: proposalId,
      preview_digest: previewDigest,
      operation: proposal.operation,
      started_at: new Date(this.now()).toISOString(),
    };
    this.idempotency.set(scopeDigest, inProgressEntry);
    try {
      await this.#persistIdempotencyState();
    } catch (error) {
      this.idempotency.delete(scopeDigest);
      throw error;
    }
    this.capabilities.delete(proposalId);

    const execution = this.executionTail.then(
      () => this.#completeExecution(scopeDigest, proposal, requester, inProgressEntry),
    );
    this.executionJobs.set(scopeDigest, execution);
    this.executionTail = execution.catch(() => {});
    void execution.catch((error) => {
      this.audit("execution_job_failed", {
        operation: proposal.operation,
        reason: error instanceof BrokerError ? error.code : "internal_error",
        requester: requesterHash(requester),
      });
    });
    return {
      state: this.#executionState(scopeDigest, { accepted: true }),
      promise: execution,
      replayed: false,
    };
  }

  async #completeExecution(scopeDigest, proposal, requester, inProgressEntry) {
    let result;
    try {
      result = proposal.operation === "config_patch"
        ? await this.#executeConfigPatch(proposal)
        : proposal.operation === "service_call"
          ? await this.#executeServiceCall(proposal)
          : await this.#executeDeviceTest(proposal);
    } catch (error) {
      result = safeExecutionResult(error, proposal.operation);
    }
    const completedAtMs = this.now();
    const completedEntry = {
      status: "completed",
      proposal_id: proposal.proposal_id,
      preview_digest: proposal.preview_digest,
      operation: proposal.operation,
      completed_at: new Date(completedAtMs).toISOString(),
      expires_at_ms: completedAtMs + IDEMPOTENCY_TTL_MS,
      result,
    };
    this.idempotency.set(scopeDigest, completedEntry);
    try {
      await this.#persistIdempotencyState();
    } catch {
      this.idempotency.set(scopeDigest, inProgressEntry);
      throw new BrokerError(
        "execution_in_doubt",
        "execution result could not be durably recorded",
      );
    } finally {
      this.executionJobs.delete(scopeDigest);
    }
    this.proposals.delete(proposal.proposal_id);
    this.audit("execution_completed", {
      operation: proposal.operation,
      risk: proposal.risk,
      status: result.status,
      reason: result.reason || "ok",
      requester: requesterHash(requester),
    });
    return result;
  }

  async startExecution(input) {
    const started = await this.#startExecutionInternal(input);
    return started.state;
  }

  executionStatus(input) {
    const value = assertPlainObject(input, "execution status");
    assertOnlyKeys(value, new Set(["requester", "idempotency_key"]), "execution status");
    const requester = normalizeRequester(value.requester);
    const idempotencyKey = requireString(value.idempotency_key, "idempotency_key", {
      min: 8,
      max: 128,
      pattern: /^[A-Za-z0-9._:@+-]+$/u,
    });
    const scopeDigest = sha256Digest(stableStringify({ requester, idempotency_key: idempotencyKey }));
    return this.#executionState(scopeDigest);
  }

  async execute(input) {
    const started = await this.#startExecutionInternal(input);
    if (started.state.status === "completed") {
      return { ...started.state.result, replayed: true };
    }
    if (started.state.status === "in_doubt" || !started.promise) {
      return {
        status: "in_doubt",
        operation: started.state.operation,
        reason: started.state.reason ?? "previous_attempt_not_proven_complete",
        changed: null,
        replayed: true,
      };
    }
    const result = await started.promise;
    return { ...result, replayed: started.replayed };
  }

  #publicProposal(proposal) {
    return {
      proposal_id: proposal.proposal_id,
      operation: proposal.operation,
      risk: proposal.risk,
      requester: proposal.requester,
      preview: proposal.preview,
      preview_digest: proposal.preview_digest,
      expires_at: new Date(proposal.expires_at_ms).toISOString(),
    };
  }

  #requireLiveProposal(value) {
    const proposalId = requireString(value, "proposal_id", {
      max: 64,
      pattern: /^[A-Za-z0-9_-]+$/u,
    });
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new BrokerError("proposal_unavailable", "proposal does not exist or has expired");
    if (proposal.expires_at_ms <= this.now()) {
      this.proposals.delete(proposalId);
      this.capabilities.delete(proposalId);
      throw new BrokerError("proposal_expired", "proposal has expired");
    }
    return proposal;
  }

  #assertBinding(proposal, requester, previewDigest) {
    this.#assertRequesterBinding(proposal, requester);
    const normalizedDigest = normalizeExpectedDigest(previewDigest);
    if (!constantTimeDigestMatch(proposal.preview_digest, normalizedDigest)) {
      throw new BrokerError("preview_mismatch", "proposal preview has changed");
    }
  }

  #assertRequesterBinding(proposal, requester) {
    if (stableStringify(proposal.requester) !== stableStringify(requester)) {
      throw new BrokerError("requester_mismatch", "requester does not own this proposal");
    }
  }

  #cleanupExpired() {
    const nowMs = this.now();
    for (const [proposalId, proposal] of this.proposals) {
      if (proposal.expires_at_ms <= nowMs) {
        this.proposals.delete(proposalId);
        this.capabilities.delete(proposalId);
      }
    }
    for (const [scope, entry] of this.idempotency) {
      if (entry.status === "completed" && entry.expires_at_ms <= nowMs) {
        this.idempotency.delete(scope);
      }
    }
  }

  async #loadIdempotencyState() {
    let raw;
    try {
      const info = await lstat(this.statePath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== this.requiredUid) {
        throw new BrokerError("unsafe_storage", "idempotency state file is unsafe");
      }
      if ((info.mode & 0o777) !== 0o600 || info.size > MAX_SOCKET_MESSAGE_BYTES) {
        throw new BrokerError("unsafe_storage", "idempotency state file metadata is unsafe");
      }
      raw = await readFile(this.statePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    let state;
    try {
      state = JSON.parse(raw);
    } catch {
      throw new BrokerError("invalid_state", "idempotency state is invalid JSON");
    }
    if (!isPlainObject(state) || state.version !== STATE_VERSION || !Array.isArray(state.entries)) {
      throw new BrokerError("invalid_state", "idempotency state schema is unsupported");
    }
    if (state.entries.length > MAX_COMPLETED_ENTRIES) {
      throw new BrokerError("invalid_state", "idempotency state exceeds its limit");
    }
    for (const item of state.entries) {
      if (
        !isPlainObject(item) ||
        typeof item.scope_digest !== "string" ||
        !["completed", "in_progress"].includes(item.entry?.status)
      ) {
        throw new BrokerError("invalid_state", "idempotency state entry is invalid");
      }
      this.idempotency.set(item.scope_digest, item.entry);
    }
    this.#cleanupExpired();
  }

  async #persistIdempotencyState() {
    this.#cleanupExpired();
    const entries = [...this.idempotency.entries()];
    const inProgress = entries.filter(([, entry]) => entry.status === "in_progress");
    const completed = entries
      .filter(([, entry]) => entry.status === "completed")
      .sort((left, right) => String(right[1].completed_at).localeCompare(String(left[1].completed_at)))
      .slice(0, Math.max(0, MAX_COMPLETED_ENTRIES - inProgress.length));
    if (inProgress.length > MAX_COMPLETED_ENTRIES) {
      throw new BrokerError("idempotency_capacity", "too many in-doubt executions require review");
    }
    const retained = [...inProgress, ...completed];
    this.idempotency = new Map(retained);
    await atomicWrite(
      this.statePath,
      `${JSON.stringify({
        version: STATE_VERSION,
        entries: retained.map(([scopeDigest, entry]) => ({ scope_digest: scopeDigest, entry })),
      })}\n`,
      0o600,
    );
  }

  async #resolveConfigTarget(relativePath) {
    await assertNoSymlinkComponents(this.configRootReal, relativePath);
    const absolute = resolve(this.configRootReal, relativePath);
    const rel = relative(this.configRootReal, absolute);
    if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith("/")) {
      throw new BrokerError("unsafe_target", "config target escapes the config root");
    }
    const parentReal = await realpath(dirname(absolute));
    const parentRelative = relative(this.configRootReal, parentReal);
    if (parentRelative === ".." || parentRelative.startsWith(`..${sep}`)) {
      throw new BrokerError("unsafe_target", "config target parent escapes the config root");
    }
    return absolute;
  }

  async #readConfigTarget(path) {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
        throw new BrokerError("unsafe_target", "config target must be a regular single-link file");
      }
      if (info.size > MAX_CONFIG_BYTES) {
        throw new BrokerError("target_too_large", "config target exceeds the size limit");
      }
      const content = await readFile(path);
      return {
        exists: true,
        content,
        digest: sha256Digest(content),
        mode: info.mode & 0o777,
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { exists: false, content: null, digest: "missing", mode: 0o600 };
      }
      throw error;
    }
  }

  async #createBackup(proposal, current) {
    const backupDirectory = join(this.backupRoot, proposal.proposal_id);
    await mkdir(backupDirectory, { mode: 0o700 });
    const info = await lstat(backupDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== this.requiredUid) {
      throw new BrokerError("unsafe_storage", "change backup directory is unsafe");
    }
    if (current.exists) {
      const source = await this.#resolveConfigTarget(proposal.payload.path);
      const backup = join(backupDirectory, "original");
      await copyFile(source, backup, 1);
      await chmod(backup, 0o600);
      const backupContent = await readFile(backup);
      if (sha256Digest(backupContent) !== current.digest) {
        throw new BrokerError("backup_failed", "change backup verification failed");
      }
    }
    const manifest = {
      version: 1,
      proposal_id: proposal.proposal_id,
      target: proposal.payload.path,
      existed: current.exists,
      original_sha256: current.digest,
      original_mode: current.mode,
      created_at: new Date(this.now()).toISOString(),
    };
    await atomicWrite(join(backupDirectory, "manifest.json"), `${JSON.stringify(manifest)}\n`, 0o600);
    await fsyncDirectory(backupDirectory);
    return backupDirectory;
  }

  async #restoreConfigTarget(proposal, backupDirectory, current) {
    const target = await this.#resolveConfigTarget(proposal.payload.path);
    if (!current.exists) {
      await unlink(target).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      await fsyncDirectory(dirname(target));
      return;
    }
    const backup = await readFile(join(backupDirectory, "original"));
    if (sha256Digest(backup) !== current.digest) {
      throw new BrokerError("rollback_failed", "backup digest changed before rollback");
    }
    await atomicWrite(target, backup, current.mode);
  }

  async #prepareConfigActivation(payload, current) {
    if (payload.activation === null) return null;
    const configurationTarget = await this.#resolveConfigTarget("configuration.yaml");
    const configuration = await this.#readConfigTarget(configurationTarget);
    if (!configuration.exists) {
      throw new BrokerError("unsupported_activation", "configuration.yaml is unavailable");
    }
    return inputBooleanActivationPlan(payload, current, configuration);
  }

  #assertActivationPlan(proposal, candidate) {
    if (
      proposal.activation_plan === null ||
      candidate === null ||
      stableStringify(proposal.activation_plan) !== stableStringify(candidate)
    ) {
      throw new BrokerError(
        "activation_precondition_failed",
        "configuration activation contract changed after proposal creation",
      );
    }
  }

  async #beginSemanticChange(plan, { rollback = false } = {}) {
    const expectations = rollback ? plan.rollback_expectations : plan.expectations;
    const result = await this.memoryChange.begin({
      summary: rollback
        ? `Restore ${plan.subjects.length} input_boolean configuration change(s)`
        : `Apply ${plan.subjects.length} verified input_boolean configuration change(s)`,
      subjects: plan.subjects,
      expectations,
    });
    if (
      !isPlainObject(result) ||
      !Number.isSafeInteger(result.change_id) ||
      result.change_id < 1 ||
      result.status !== "pending"
    ) {
      throw new BrokerError("memory_protocol_error", "semantic memory did not begin the change");
    }
    return {
      change_id: result.change_id,
      expectations,
      status: "pending",
    };
  }

  async #verifySemanticChange(change) {
    let result;
    try {
      result = await this.memoryChange.verify({
        changeId: change.change_id,
        expectations: change.expectations,
      });
    } catch (error) {
      return {
        change_id: change.change_id,
        status: "unavailable",
        matched: false,
        reason: error instanceof BrokerError ? error.code : "memory_unavailable",
      };
    }
    if (!isPlainObject(result) || result.change_id !== change.change_id) {
      return {
        change_id: change.change_id,
        status: "unavailable",
        matched: false,
        reason: "memory_protocol_error",
      };
    }
    if (result.status === "verified" && result.matched === true) {
      return { change_id: change.change_id, status: "verified", matched: true };
    }
    if (result.status === "mismatch" && result.matched === false) {
      return { change_id: change.change_id, status: "mismatch", matched: false };
    }
    if (result.status === "unavailable") {
      return {
        change_id: change.change_id,
        status: "unavailable",
        matched: false,
        reason: typeof result.verification?.reason === "string"
          ? result.verification.reason.slice(0, 80)
          : "memory_unavailable",
      };
    }
    return {
      change_id: change.change_id,
      status: "unavailable",
      matched: false,
      reason: "memory_protocol_error",
    };
  }

  async #reloadConfigActivation(plan) {
    if (plan.kind !== "input_boolean_reload") {
      throw new BrokerError("unsupported_activation", "configuration activation is not supported");
    }
    await this.#requestJson(`${this.haUrl}/services/input_boolean/reload`, {
      method: "POST",
      body: {},
    });
  }

  async #readEntitySnapshot(entityId) {
    const response = await this.#requestJson(
      `${this.haUrl}/states/${encodeURIComponent(entityId)}`,
      { method: "GET", allowNotFound: true },
    );
    if (response === null) return null;
    if (
      !isPlainObject(response) ||
      response.entity_id !== entityId ||
      typeof response.state !== "string" ||
      response.state.length > 255 ||
      !isPlainObject(response.attributes)
    ) {
      throw new BrokerError("ha_protocol_error", "Home Assistant returned an invalid state response");
    }
    return response;
  }

  async #verifyStateExpectations(expectations) {
    const states = expectations?.states;
    if (!isPlainObject(states) || Object.keys(states).length < 1) {
      throw new BrokerError("memory_protocol_error", "state expectation contract is unavailable");
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let matched = true;
      for (const [subject, expected] of Object.entries(states)) {
        if (!/^entity:input_boolean\.[a-z][a-z0-9_]*$/u.test(subject) || !isPlainObject(expected)) {
          throw new BrokerError("memory_protocol_error", "state expectation contract is invalid");
        }
        const entityId = subject.slice("entity:".length);
        const actual = await this.#readEntitySnapshot(entityId);
        if (expected.exists === false) {
          if (actual !== null) matched = false;
          continue;
        }
        if (actual === null) {
          matched = false;
          continue;
        }
        if (own(expected, "state") && actual.state !== expected.state) matched = false;
        for (const [attribute, expectedValue] of Object.entries(expected.attributes ?? {})) {
          if (stableStringify(actual.attributes[attribute] ?? null) !== stableStringify(expectedValue)) {
            matched = false;
          }
        }
      }
      if (matched) return;
      if (attempt < 4) await this.sleep(200);
    }
    throw new BrokerError("fresh_verification_failed", "fresh Home Assistant state did not match");
  }

  async #rollbackConfigActivation({
    proposal,
    backupDirectory,
    current,
    plan,
    reloadRequired,
  }) {
    let rollbackChange = null;
    try {
      rollbackChange = await this.#beginSemanticChange(plan, { rollback: true });
    } catch {
      rollbackChange = null;
    }
    await this.#restoreConfigTarget(proposal, backupDirectory, current);
    const restored = await this.#readConfigTarget(
      await this.#resolveConfigTarget(proposal.payload.path),
    );
    if (restored.digest !== current.digest) {
      throw new BrokerError("rollback_failed", "configuration rollback digest did not match");
    }
    await this.#checkConfiguration();
    if (reloadRequired) await this.#reloadConfigActivation(plan);
    await this.#verifyStateExpectations(plan.rollback_expectations);
    const memory = rollbackChange === null
      ? { status: "unavailable", matched: false, reason: "memory_begin_failed" }
      : await this.#verifySemanticChange(rollbackChange);
    return {
      status: memory.status === "verified" ? "verified" : "api_verified_memory_unavailable",
      memory,
    };
  }

  async #executeConfigPatch(proposal) {
    const target = await this.#resolveConfigTarget(proposal.payload.path);
    const current = await this.#readConfigTarget(target);
    if (current.digest !== proposal.payload.expected_sha256) {
      throw new BrokerError("precondition_failed", "config target changed after proposal creation");
    }
    const activationPlan = await this.#prepareConfigActivation(proposal.payload, current);
    if (activationPlan === null) {
      throw new BrokerError(
        "unsupported_activation",
        "configuration replacement has no supported reload and fresh verification contract",
      );
    }
    this.#assertActivationPlan(proposal, activationPlan);
    const replacementDigest = sha256Digest(proposal.payload.content);
    if (replacementDigest === current.digest) {
      await this.#checkConfiguration();
      return {
        status: "succeeded",
        operation: "config_patch",
        target: proposal.payload.path,
        changed: false,
        current_sha256: current.digest,
        config_check: "passed",
        reload: "not_required",
        semantic_memory: "not_required",
      };
    }
    const backupDirectory = await this.#createBackup(proposal, current);
    const beforeWrite = await this.#readConfigTarget(target);
    if (beforeWrite.digest !== current.digest) {
      throw new BrokerError("precondition_failed", "config target changed while preparing its backup");
    }
    await this.#verifyStateExpectations(activationPlan.rollback_expectations);
    let desiredChange;
    try {
      desiredChange = await this.#beginSemanticChange(activationPlan);
    } catch {
      throw new BrokerError(
        "memory_begin_failed",
        "semantic memory could not commit the pre-change expectation contract",
      );
    }
    const afterMemoryWait = await this.#readConfigTarget(target);
    const refreshedPlan = await this.#prepareConfigActivation(proposal.payload, afterMemoryWait);
    if (afterMemoryWait.digest !== current.digest) {
      await this.#verifySemanticChange(desiredChange);
      throw new BrokerError("precondition_failed", "config target changed before replacement");
    }
    try {
      this.#assertActivationPlan(proposal, refreshedPlan);
    } catch (error) {
      await this.#verifySemanticChange(desiredChange);
      throw error;
    }

    let candidateWritten = false;
    let reloadRequired = false;
    let desiredMemory = null;
    let failure = null;
    try {
      await atomicWrite(target, proposal.payload.content, current.mode);
      candidateWritten = true;
      const staged = await this.#readConfigTarget(target);
      if (staged.digest !== replacementDigest) {
        throw new BrokerError("write_verification_failed", "config replacement digest did not match");
      }
      await this.#checkConfiguration();
      reloadRequired = true;
      await this.#reloadConfigActivation(activationPlan);
      desiredMemory = await this.#verifySemanticChange(desiredChange);
      if (desiredMemory.status !== "verified" || desiredMemory.matched !== true) {
        throw new BrokerError(
          desiredMemory.status === "mismatch"
            ? "fresh_verification_failed"
            : "memory_verification_unavailable",
          "configuration postcondition was not verified by fresh Home Assistant API data",
        );
      }
    } catch (error) {
      failure = error;
    }

    if (failure === null) {
      const verified = await this.#readConfigTarget(target);
      if (verified.digest !== replacementDigest) {
        throw new BrokerError("config_verification_in_doubt", "config target changed after validation");
      }
      return {
        status: "succeeded",
        operation: "config_patch",
        target: proposal.payload.path,
        changed: true,
        previous_sha256: current.digest,
        current_sha256: verified.digest,
        config_check: "passed",
        backup_id: proposal.proposal_id,
        reload: activationPlan.reload_service,
        fresh_verification: "memory_verified",
        memory_change_id: desiredMemory.change_id,
      };
    }

    desiredMemory ??= await this.#verifySemanticChange(desiredChange);
    const failureCode = failure instanceof BrokerError ? failure.code : "internal_error";
    let observed;
    try {
      observed = await this.#readConfigTarget(target);
    } catch {
      throw new BrokerError("rollback_failed", "config target could not be observed after failure");
    }
    if (observed.digest !== current.digest && observed.digest !== replacementDigest) {
      throw new BrokerError("rollback_failed", "config target diverged before rollback");
    }
    let rollback = { status: "not_required", memory: null };
    if (candidateWritten || observed.digest === replacementDigest || reloadRequired) {
      try {
        rollback = await this.#rollbackConfigActivation({
          proposal,
          backupDirectory,
          current,
          plan: activationPlan,
          reloadRequired,
        });
      } catch {
        throw new BrokerError("rollback_failed", "configuration rollback was not fully verified");
      }
    } else {
      await this.#verifyStateExpectations(activationPlan.rollback_expectations);
    }
    return {
      status: "failed",
      operation: "config_patch",
      target: proposal.payload.path,
      reason: failureCode,
      changed: false,
      current_sha256: current.digest,
      config_check: failureCode === "config_check_failed" ? "failed" : "passed_or_not_reached",
      backup_id: proposal.proposal_id,
      reload: reloadRequired ? "rolled_back" : "not_performed",
      desired_memory: desiredMemory,
      rollback,
    };
  }

  async #checkConfiguration() {
    const response = await this.#requestJson(`${this.supervisorUrl}/core/check`, {
      method: "POST",
      body: {},
    });
    if (!isPlainObject(response) || response.result !== "ok") {
      throw new BrokerError("config_check_failed", "Home Assistant configuration check failed");
    }
  }

  async #readEntityState(entityId) {
    const response = await this.#requestJson(
      `${this.haUrl}/states/${encodeURIComponent(entityId)}`,
      { method: "GET" },
    );
    if (
      !isPlainObject(response) ||
      response.entity_id !== entityId ||
      typeof response.state !== "string" ||
      response.state.length > 255
    ) {
      throw new BrokerError("ha_protocol_error", "Home Assistant returned an invalid state response");
    }
    return response.state;
  }

  async #callService(domain, service, entityId) {
    await this.#requestJson(`${this.haUrl}/services/${domain}/${service}`, {
      method: "POST",
      body: { entity_id: entityId },
    });
  }

  async #verifyEntityState(entityId, expected) {
    let observed = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      observed = await this.#readEntityState(entityId);
      if (observed === expected) return observed;
      if (attempt < 4) await this.sleep(200);
    }
    throw new BrokerError("fresh_verification_failed", "entity did not reach the expected state");
  }

  async #executeServiceCall(proposal) {
    const payload = proposal.payload;
    const priorState = await this.#readEntityState(payload.entity_id);
    if (priorState !== payload.expected_state) {
      throw new BrokerError("precondition_failed", "entity state changed after proposal creation");
    }
    if (priorState === payload.verify_state) {
      return {
        status: "succeeded",
        operation: "service_call",
        service: `${payload.domain}.${payload.service}`,
        entity_id: payload.entity_id,
        previous_state: priorState,
        current_state: priorState,
        changed: false,
      };
    }
    try {
      await this.#callService(payload.domain, payload.service, payload.entity_id);
      const observed = await this.#verifyEntityState(payload.entity_id, payload.verify_state);
      return {
        status: "succeeded",
        operation: "service_call",
        service: `${payload.domain}.${payload.service}`,
        entity_id: payload.entity_id,
        previous_state: priorState,
        current_state: observed,
        changed: true,
      };
    } catch (error) {
      let observed;
      try {
        observed = await this.#readEntityState(payload.entity_id);
      } catch {
        throw new BrokerError(
          "execution_in_doubt",
          "service result could not be observed after an execution error",
        );
      }
      if (observed === priorState) throw error;
      const rollbackService = priorState === "on" ? "turn_on" : "turn_off";
      try {
        await this.#callService(payload.domain, rollbackService, payload.entity_id);
        await this.#verifyEntityState(payload.entity_id, priorState);
      } catch {
        throw new BrokerError("rollback_failed", "service verification failed and prior state was not restored");
      }
      throw error;
    }
  }

  async #executeDeviceTest(proposal) {
    const payload = proposal.payload;
    const priorState = await this.#readEntityState(payload.entity_id);
    if (priorState !== payload.expected_prior_state) {
      throw new BrokerError(
        "precondition_failed",
        "entity state changed after the device test was proposed",
      );
    }
    if (priorState === payload.test_state) {
      throw new BrokerError(
        "invalid_device_test",
        "device test target does not produce a transient state change",
      );
    }

    let testError = null;
    let testObservedState = null;
    try {
      await this.#callService(payload.domain, payload.service, payload.entity_id);
      testObservedState = await this.#verifyEntityState(
        payload.entity_id,
        payload.test_state,
      );
    } catch (error) {
      testError = error;
    }

    // A test-service transport error is ambiguous: Home Assistant may have
    // accepted the request before the response was lost. Always issue the
    // broker-derived prior-state service and verify it with a fresh read.
    let restoreRequestError = null;
    try {
      await this.#callService(
        payload.domain,
        payload.restore_service,
        payload.entity_id,
      );
    } catch (error) {
      restoreRequestError = error;
    }

    let restoredState;
    try {
      restoredState = await this.#verifyEntityState(
        payload.entity_id,
        priorState,
      );
    } catch (error) {
      if (error instanceof BrokerError && error.code === "fresh_verification_failed") {
        throw new BrokerError(
          "rollback_failed",
          "device test prior state was not restored",
        );
      }
      throw new BrokerError(
        "execution_in_doubt",
        "device test restore state could not be observed",
      );
    }

    const restore = {
      status: "verified",
      service: `${payload.domain}.${payload.restore_service}`,
      state: restoredState,
      request_status: restoreRequestError === null
        ? "accepted"
        : "error_but_state_verified",
    };
    if (testError !== null) {
      return {
        status: "failed",
        operation: "device_test",
        reason: testError instanceof BrokerError ? testError.code : "internal_error",
        entity_id: payload.entity_id,
        previous_state: priorState,
        test_state: payload.test_state,
        test_observed_state: testObservedState,
        current_state: restoredState,
        changed: false,
        restore,
      };
    }
    return {
      status: "succeeded",
      operation: "device_test",
      entity_id: payload.entity_id,
      previous_state: priorState,
      test_state: testObservedState,
      current_state: restoredState,
      changed: false,
      restore,
    };
  }

  async #requestJson(url, { method, body, allowNotFound = false } = {}) {
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${this.supervisorToken}`,
    };
    const options = {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await this.fetchImpl(url, options);
    } catch {
      throw new BrokerError("ha_transport_failed", "Home Assistant request failed");
    }
    if (!response || typeof response.status !== "number" || typeof response.text !== "function") {
      throw new BrokerError("ha_protocol_error", "Home Assistant returned an invalid response");
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_API_RESPONSE_BYTES) {
      throw new BrokerError("ha_protocol_error", "Home Assistant response exceeded the limit");
    }
    if (allowNotFound && response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw new BrokerError("ha_request_failed", `Home Assistant request failed with HTTP ${response.status}`);
    }
    if (raw === "") return null;
    try {
      return JSON.parse(raw);
    } catch {
      throw new BrokerError("ha_protocol_error", "Home Assistant returned invalid JSON");
    }
  }

  #handleSocket(socket, role) {
    socket.setEncoding("utf8");
    socket.setTimeout(10_000);
    let buffer = "";
    let handled = false;
    const fail = (code, message, id = null) => {
      if (socket.destroyed) return;
      socket.end(`${JSON.stringify({ id, ok: false, error: { code, message } })}\n`);
    };
    socket.on("timeout", () => fail("timeout", "broker request timed out"));
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_SOCKET_MESSAGE_BYTES) {
        handled = true;
        fail("request_too_large", "broker request exceeded the limit");
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      const line = buffer.slice(0, newline);
      if (buffer.slice(newline + 1).trim() !== "") {
        fail("invalid_request", "one request per connection is required");
        return;
      }
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch {
        fail("invalid_json", "broker request is invalid JSON");
        return;
      }
      const id = isPlainObject(envelope) && typeof envelope.id === "string"
        ? envelope.id.slice(0, 128)
        : null;
      try {
        const objectEnvelope = assertPlainObject(envelope, "request");
        assertOnlyKeys(objectEnvelope, new Set(["id", "action", "payload"]), "request");
        requireString(objectEnvelope.id, "id", {
          max: 128,
          pattern: /^[A-Za-z0-9._:@+-]+$/u,
        });
        const action = requireString(objectEnvelope.action, "action", {
          max: 32,
          pattern: /^[a-z_]+$/u,
        });
        if (!SOCKET_ACTIONS[role]?.has(action)) {
          throw new BrokerError("action_forbidden", "action is not available on this socket");
        }
        const payload = own(objectEnvelope, "payload")
          ? assertPlainObject(objectEnvelope.payload, "payload")
          : {};
        const result = await this.dispatch(action, payload);
        socket.end(`${JSON.stringify({ id: objectEnvelope.id, ok: true, result })}\n`);
      } catch (error) {
        const code = error instanceof BrokerError ? error.code : "internal_error";
        const message = error instanceof BrokerError ? error.message : "broker request failed";
        fail(code, message, id);
      }
    });
  }
}

export function sendBrokerRequest(
  action,
  payload = {},
  { socketPath = DEFAULT_SOCKET_PATH, timeoutMs = 10_000 } = {},
) {
  return new Promise((resolveRequest, rejectRequest) => {
    const id = opaqueId(12);
    const client = net.createConnection(socketPath);
    client.setEncoding("utf8");
    client.setTimeout(timeoutMs);
    let buffer = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      client.destroy();
      callback(value);
    };
    client.on("connect", () => {
      client.write(`${JSON.stringify({ id, action, payload })}\n`);
    });
    client.on("timeout", () => {
      finish(rejectRequest, new BrokerError("timeout", "change broker did not respond"));
    });
    client.on("error", () => {
      finish(rejectRequest, new BrokerError("broker_unavailable", "change broker is unavailable"));
    });
    client.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_SOCKET_MESSAGE_BYTES) {
        finish(rejectRequest, new BrokerError("response_too_large", "change broker response exceeded the limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let response;
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(rejectRequest, new BrokerError("invalid_response", "change broker returned invalid JSON"));
        return;
      }
      if (!isPlainObject(response) || response.id !== id || typeof response.ok !== "boolean") {
        finish(rejectRequest, new BrokerError("invalid_response", "change broker returned an invalid response"));
        return;
      }
      if (!response.ok) {
        const code = typeof response.error?.code === "string" ? response.error.code : "broker_error";
        const message = typeof response.error?.message === "string"
          ? response.error.message
          : "change broker rejected the request";
        finish(rejectRequest, new BrokerError(code, message));
        return;
      }
      finish(resolveRequest, response.result);
    });
  });
}

async function main() {
  const supervisorToken = consumeSupervisorCredentialFromInheritedFd();
  const broker = new ChangeBroker({ supervisorToken });
  const stop = async () => {
    await broker.close().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await broker.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof BrokerError ? error.code : "startup_failed";
    console.error(`${SERVER_NAME}: ${code}`);
    process.exit(78);
  });
}
