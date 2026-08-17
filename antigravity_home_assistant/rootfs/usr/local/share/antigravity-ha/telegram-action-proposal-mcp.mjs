import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import { isAbsolute, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_TELEGRAM_ACTION_PROPOSAL_SOCKET =
  "/run/antigravity-ha/telegram-action-proposal.sock";
export const MAX_MCP_LINE_BYTES = 256 * 1024;
export const MAX_REGISTER_MESSAGE_BYTES = 20 * 1024;
export const MAX_SHELL_SOURCE_BYTES = 16 * 1024;
export const MAX_PUBLIC_PREVIEW_BYTES = 12 * 1024;
export const MAX_ACTION_CHOICES = 31;
export const MIN_ACTION_TIMEOUT_MS = 100;
export const MAX_ACTION_TIMEOUT_MS = 120_000;

const SERVER_NAME = "antigravity-telegram-action-proposal";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TTL_SECONDS = 120;
const MAX_TTL_SECONDS = 300;
const MIN_TTL_SECONDS = 30;
const MAX_SUMMARY_BYTES = 500;
const MAX_PROMPT_BYTES = 1_024;
const MAX_LABEL_BYTES = 64;
const MAX_VALUE_DEPTH = 12;
const MAX_VALUE_NODES = 2_048;
export const TELEGRAM_ACTION_PROPOSAL_ID_PATTERN = /^ta_[A-Za-z0-9_-]{20,48}$/u;
const CHOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,24}$/u;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const RUN_NONCE_PATTERN = /^[A-Za-z0-9_-]{24,128}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const INVISIBLE_DIRECTIONAL_PATTERN =
  /[\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u;
const DISALLOWED_TEXT_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const ANSI_ESCAPE_PATTERN =
  /[\u001b\u009b](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[PX^_].*?\u001b\\|[@-_])/gu;

export const APPROVED_ACTION_CWD_ROOTS = Object.freeze([
  "/config",
  "/data/home/.gemini/config",
  "/data/home/.gemini/antigravity-cli/agents",
  "/data/home/.gemini/antigravity-cli/plugins",
  "/data/home/.gemini/antigravity-cli/skills",
]);

const SENSITIVE_PATH_PATTERNS = Object.freeze([
  /(?:^|[\s'"=./])secrets\.ya?ml(?:$|[\s/'";&|)])/iu,
  /(?:^|[\s'"=./])\.storage(?:$|[\s/'";&|)])/iu,
  /(?:^|[\s'"=])\/config\/secrets\.yaml(?:$|[\s/'"])/iu,
  /(?:^|[\s'"=])\/config\/\.storage(?:$|[\s/'"])/iu,
  /(?:^|[\s'"=])\/config\/(?:\.ssh|\.cloud|ssl|backups)(?:$|[\s/'"])/iu,
  /(?:^|[\s'"=])\/data\/(?:options\.json|antigravity|browser-auth|github-cli|ssh)(?:$|[\s/'"])/iu,
  /(?:^|[\s'"=])\/data\/home\/(?:\.ssh|\.aws|\.azure|\.kube)(?:$|[\s/'"])/iu,
  /(?:^|[\s'"=])\/data\/home\/(?:\.netrc|\.npmrc)(?:$|[\s'"])/iu,
  /(?:^|[\s'"=])\/data\/home\/\.config\/gcloud(?:$|[\s/'"])/iu,
  /(?:^|[\s'"=])\/data\/home\/\.gemini\/antigravity-cli\/(?:settings\.json|oauth[^\s/'"]*)(?:$|[\s/'"])/iu,
  /(?:^|[\s'"=])\/data\/home\/\.gemini\/config\/mcp_config\.json(?:$|[\s/'"])/iu,
  /(?:^|[\s'"=])\/run\/antigravity-ha(?:$|[\s/'"])/iu,
  /(?:^|[\s'"=])\/proc\/(?:self|[0-9]+)\/(?:environ|mem|fd)(?:$|[\s/'"])/iu,
]);

const SENSITIVE_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/iu,
  /\b(?:authorization|proxy-authorization)\s*:\s*[^\s]{4,}/iu,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:SUPERVISOR_TOKEN|TELEGRAM_BOT_TOKEN|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|AGY_OAUTH_TOKEN)\b/iu,
  /\b(?:password|passwd|client_secret|access_token|refresh_token|api[_-]?key)\s*(?:=|:)\s*["']?[^\s"']{4,}/iu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/iu,
  /\bAKIA[A-Z0-9]{16}\b/u,
  /\bAIza[A-Za-z0-9_-]{30,}\b/u,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/u,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]{1,128}:[^\s/@]{1,256}@/iu,
  /(?:^|[?&\s])(?:token|access_token|api[_-]?key)=[^\s&]{4,}/iu,
  /(?:^|\s)--(?:password|token|api[_-]?key)(?:=|\s+)\S{4,}/iu,
]);

const SENSITIVE_KEY_PATTERN =
  /(?:^|[_-])(?:authorization|password|passwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|cookie)(?:$|[_-])/iu;
const ENVIRONMENT_DUMP_PATTERN =
  /(?:^|[;&|()\n])\s*(?:(?:\/usr\/bin\/|\/bin\/)?(?:env|printenv)|set|export\s+-p)(?=$|[\s;&|()\n])/iu;
const VERBOSE_CREDENTIAL_CLIENT_PATTERN =
  /(?:^|[;&|()\n])\s*(?:curl|wget|ssh)\b[^\n;]*(?:\s-v\b|\s--verbose\b|\s--debug\b)/iu;

const terminalPayloadSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      minLength: 1,
      maxLength: MAX_SHELL_SOURCE_BYTES,
      description: "Complete shell command. Use either command or script, never both.",
    },
    script: {
      type: "string",
      minLength: 1,
      maxLength: MAX_SHELL_SOURCE_BYTES,
      description: "Complete inline shell script. File references are not substituted into the digest.",
    },
    cwd: {
      type: "string",
      minLength: 1,
      maxLength: 240,
      description: "Canonical /config or approved Antigravity customization path.",
    },
    timeout_ms: {
      type: "integer",
      minimum: MIN_ACTION_TIMEOUT_MS,
      maximum: MAX_ACTION_TIMEOUT_MS,
      default: 30_000,
    },
  },
  required: ["cwd"],
  additionalProperties: false,
};

const choiceSchema = {
  type: "object",
  properties: {
    choice_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,24}$" },
    label: { type: "string", minLength: 1, maxLength: MAX_LABEL_BYTES },
    ...terminalPayloadSchema.properties,
  },
  required: ["choice_id", "label", "cwd"],
  additionalProperties: false,
};

const questionChoiceSchema = {
  type: "object",
  properties: {
    choice_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,24}$" },
    label: { type: "string", minLength: 1, maxLength: MAX_LABEL_BYTES },
  },
  required: ["choice_id", "label"],
  additionalProperties: false,
};

const tools = Object.freeze([
  {
    name: "telegram_action_propose",
    title: "Propose a requester-bound Telegram action",
    description:
      "Register a bounded terminal command, mutually exclusive terminal choices, or a Telegram question. This tool never executes or approves an action. It returns an opaque proposal_id plus the final request digest and bounded public preview; the trusted Telegram bridge must select and execute a digest-bound action.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["terminal_command", "multi_choice_terminal", "question"],
        },
        summary: { type: "string", minLength: 1, maxLength: MAX_SUMMARY_BYTES },
        ttl_seconds: {
          type: "integer",
          minimum: MIN_TTL_SECONDS,
          maximum: MAX_TTL_SECONDS,
          default: DEFAULT_TTL_SECONDS,
        },
        payload: {
          oneOf: [
            terminalPayloadSchema,
            {
              type: "object",
              properties: {
                prompt: { type: "string", minLength: 1, maxLength: MAX_PROMPT_BYTES },
                choices: {
                  type: "array",
                  minItems: 1,
                  maxItems: MAX_ACTION_CHOICES,
                  items: choiceSchema,
                },
                cancel_label: { type: "string", minLength: 1, maxLength: MAX_LABEL_BYTES },
              },
              required: ["prompt", "choices"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                prompt: { type: "string", minLength: 1, maxLength: MAX_PROMPT_BYTES },
                choices: {
                  type: "array",
                  minItems: 1,
                  maxItems: MAX_ACTION_CHOICES,
                  items: questionChoiceSchema,
                },
                cancel_label: { type: "string", minLength: 1, maxLength: MAX_LABEL_BYTES },
              },
              required: ["prompt", "choices"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["operation", "summary", "payload"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
]);

export class TelegramActionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TelegramActionError";
    this.code = code;
  }
}

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(code, message) {
  throw new TelegramActionError(code, message);
}

function assertOnlyKeys(value, keys, label) {
  if (!isPlainObject(value)) fail("invalid_request", `${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) fail("invalid_request", `${label} contains an unsupported field`);
  }
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function requireString(value, label, { min = 1, max, pattern, singleLine = false } = {}) {
  if (typeof value !== "string" || utf8Bytes(value) < min || utf8Bytes(value) > max ||
      (pattern && !pattern.test(value)) || INVISIBLE_DIRECTIONAL_PATTERN.test(value) ||
      DISALLOWED_TEXT_CONTROL_PATTERN.test(value) ||
      (singleLine && /[\t\r\n\u2028\u2029]/u.test(value))) {
    fail("invalid_request", `${label} is invalid`);
  }
  return value;
}

function requireInteger(value, label, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("invalid_request", `${label} is invalid`);
  }
  return value;
}

function canonicalValue(value, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) {
    fail("payload_too_complex", "action payload is too complex");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      fail("invalid_request", "action payload contains an invalid number");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalValue(entry, state, depth + 1));
  }
  if (!isPlainObject(value)) fail("invalid_request", "action payload contains an invalid value");
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "__proto__" || key === "constructor" || key === "prototype" ||
        key.length < 1 || utf8Bytes(key) > 256 || INVISIBLE_DIRECTIONAL_PATTERN.test(key)) {
      fail("invalid_request", "action payload contains an invalid key");
    }
    output[key] = canonicalValue(value[key], state, depth + 1);
  }
  return output;
}

export function stableJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Digest(value) {
  const bytes = typeof value === "string" ? value : stableJson(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hasSensitiveText(value) {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value)) ||
    SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(value));
}

export function assertNoSensitiveValue(value, label = "payload", state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) {
    fail("payload_too_complex", `${label} is too complex`);
  }
  if (typeof value === "string") {
    if (hasSensitiveText(value)) fail("sensitive_value", `${label} contains protected data`);
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveValue(entry, `${label}[${index}]`, state, depth + 1));
    return;
  }
  if (!isPlainObject(value)) fail("invalid_request", `${label} contains an invalid value`);
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      fail("sensitive_value", `${label} contains a protected field`);
    }
    assertNoSensitiveValue(entry, `${label}.${key}`, state, depth + 1);
  }
}

function replacementPatterns() {
  return [
    [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/giu, "<redacted-private-key>"],
    [/\b(?:authorization|proxy-authorization)\s*:\s*[^\r\n]+/giu, "Authorization: <redacted>"],
    [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer <redacted>"],
    [/\b(?:SUPERVISOR_TOKEN|TELEGRAM_BOT_TOKEN|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|AGY_OAUTH_TOKEN)\b(?:\s*(?:=|:)\s*[^\s]+)?/giu, "<redacted-credential>"],
    [/\b(?:password|passwd|client_secret|access_token|refresh_token|api[_-]?key)\s*(?:=|:)\s*["']?[^\s"']+/giu, "<redacted-credential>"],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "<redacted-token>"],
    [/\bAKIA[A-Z0-9]{16}\b/gu, "<redacted-access-key>"],
    [/\bAIza[A-Za-z0-9_-]{30,}\b/gu, "<redacted-api-key>"],
    [/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/gu, "<redacted-token>"],
    [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]{1,128}:[^\s/@]{1,256}@/giu, "$1<redacted>@"],
    [/(^|[?&\s])(?:token|access_token|api[_-]?key)=[^\s&]{4,}/giu, "$1<redacted-credential>"],
    [/(^|\s)--(?:password|token|api[_-]?key)(?:=|\s+)\S{4,}/giu, "$1<redacted-credential>"],
  ];
}

export function redactText(value) {
  let output = String(value).replace(ANSI_ESCAPE_PATTERN, "");
  for (const [pattern, replacement] of replacementPatterns()) {
    output = output.replace(pattern, replacement);
  }
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    output = output.replace(new RegExp(pattern.source, `${pattern.flags.replace("u", "")}gu`), " <redacted-path>");
  }
  return output.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�");
}

export function redactValue(value, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) return "<redacted-complex-value>";
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, state, depth + 1));
  if (!isPlainObject(value)) return "<redacted-invalid-value>";
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "<redacted>"
      : redactValue(entry, state, depth + 1);
  }
  return output;
}

export function normalizeActionCwd(value) {
  const cwd = requireString(value, "cwd", { max: 240, singleLine: true });
  if (!isAbsolute(cwd) || normalize(cwd) !== cwd || resolve(cwd) !== cwd) {
    fail("invalid_cwd", "cwd must be a canonical absolute path");
  }
  const permitted = APPROVED_ACTION_CWD_ROOTS.some(
    (root) => cwd === root || cwd.startsWith(`${root}/`),
  );
  if (!permitted) fail("invalid_cwd", "cwd is outside the approved action roots");
  return cwd;
}

function assertShellSource(value) {
  requireString(value, "shell source", { max: MAX_SHELL_SOURCE_BYTES });
  assertNoSensitiveValue(value, "shell source");
  if (ENVIRONMENT_DUMP_PATTERN.test(value) || VERBOSE_CREDENTIAL_CLIENT_PATTERN.test(value)) {
    fail("sensitive_command", "shell source could expose process credentials");
  }
  return value;
}

export function normalizeTerminalInput(value) {
  assertOnlyKeys(value, new Set(["command", "script", "cwd", "timeout_ms"]), "terminal payload");
  const hasCommand = own(value, "command");
  const hasScript = own(value, "script");
  if (hasCommand === hasScript) {
    fail("invalid_request", "terminal payload requires exactly one command or script");
  }
  const shellSource = assertShellSource(hasCommand ? value.command : value.script);
  const timeoutMs = own(value, "timeout_ms")
    ? requireInteger(value.timeout_ms, "timeout_ms", {
      min: MIN_ACTION_TIMEOUT_MS,
      max: MAX_ACTION_TIMEOUT_MS,
    })
    : 30_000;
  return {
    kind: "terminal",
    source_kind: hasCommand ? "command" : "script",
    shell_source: shellSource,
    source_sha256: sha256Digest(shellSource),
    cwd: normalizeActionCwd(value.cwd),
    timeout_ms: timeoutMs,
  };
}

export function normalizeTerminalAction(value) {
  assertOnlyKeys(
    value,
    new Set(["kind", "source_kind", "shell_source", "source_sha256", "cwd", "timeout_ms"]),
    "terminal action",
  );
  if (value.kind !== "terminal" || !["command", "script"].includes(value.source_kind)) {
    fail("invalid_request", "terminal action kind is invalid");
  }
  const shellSource = assertShellSource(value.shell_source);
  const sourceDigest = requireString(value.source_sha256, "source_sha256", {
    max: 71,
    pattern: DIGEST_PATTERN,
    singleLine: true,
  });
  if (!safeDigestEqual(sourceDigest, sha256Digest(shellSource))) {
    fail("digest_mismatch", "shell source digest does not match");
  }
  return {
    kind: "terminal",
    source_kind: value.source_kind,
    shell_source: shellSource,
    source_sha256: sourceDigest,
    cwd: normalizeActionCwd(value.cwd),
    timeout_ms: requireInteger(value.timeout_ms, "timeout_ms", {
      min: MIN_ACTION_TIMEOUT_MS,
      max: MAX_ACTION_TIMEOUT_MS,
    }),
  };
}

function normalizeChoiceText(value, label, maxBytes) {
  const text = requireString(value, label, { max: maxBytes, singleLine: true });
  assertNoSensitiveValue(text, label);
  return text;
}

function normalizeChoiceList(value, mapper) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACTION_CHOICES) {
    fail("invalid_choices", `choices must contain 1..${MAX_ACTION_CHOICES} entries`);
  }
  const ids = new Set();
  const labels = new Set();
  return value.map((choice, index) => {
    const normalized = mapper(choice, index);
    if (ids.has(normalized.choice_id) || labels.has(normalized.label)) {
      fail("invalid_choices", "choice ids and labels must be unique");
    }
    ids.add(normalized.choice_id);
    labels.add(normalized.label);
    return normalized;
  });
}

export function normalizeQuestionSelection(value) {
  assertOnlyKeys(value, new Set(["kind", "choice_id", "label"]), "question selection");
  if (value.kind !== "question_selection") {
    fail("invalid_request", "question selection kind is invalid");
  }
  return {
    kind: "question_selection",
    choice_id: requireString(value.choice_id, "choice_id", {
      max: 24,
      pattern: CHOICE_ID_PATTERN,
      singleLine: true,
    }),
    label: normalizeChoiceText(value.label, "choice label", MAX_LABEL_BYTES),
  };
}

export function normalizeTelegramBinding(value) {
  assertOnlyKeys(
    value,
    new Set([
      "surface",
      "user_id",
      "chat_id",
      "session_generation",
      "update_id",
      "run_nonce",
      "conversation_id",
    ]),
    "Telegram binding",
  );
  if (value.surface !== "telegram") fail("invalid_binding", "Telegram surface binding is required");
  return {
    surface: "telegram",
    user_id: requireString(value.user_id, "user_id", {
      max: 20,
      pattern: /^[1-9][0-9]{0,19}$/u,
      singleLine: true,
    }),
    chat_id: requireString(value.chat_id, "chat_id", {
      max: 21,
      pattern: /^-?[1-9][0-9]{0,19}$/u,
      singleLine: true,
    }),
    session_generation: requireInteger(value.session_generation, "session_generation", {
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
    }),
    update_id: requireInteger(value.update_id, "update_id", {
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
    }),
    run_nonce: requireString(value.run_nonce, "run_nonce", {
      max: 128,
      pattern: RUN_NONCE_PATTERN,
      singleLine: true,
    }),
    conversation_id: value.conversation_id === null
      ? null
      : requireString(value.conversation_id, "conversation_id", {
        max: 256,
        pattern: CONVERSATION_ID_PATTERN,
        singleLine: true,
      }),
  };
}

export function telegramBindingFromEnvironment(environment = process.env) {
  const decimalInteger = (raw, label) => {
    if (typeof raw !== "string" || !/^[1-9][0-9]{0,15}$/u.test(raw)) {
      fail("invalid_binding", `${label} environment binding is invalid`);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      fail("invalid_binding", `${label} environment binding is invalid`);
    }
    return parsed;
  };
  return normalizeTelegramBinding({
    surface: environment.ANTIGRAVITY_HA_CHANNEL,
    user_id: environment.HA_TELEGRAM_USER_ID,
    chat_id: environment.HA_TELEGRAM_CHAT_ID,
    session_generation: decimalInteger(
      environment.HA_TELEGRAM_SESSION_GENERATION,
      "session_generation",
    ),
    update_id: decimalInteger(environment.HA_TELEGRAM_UPDATE_ID, "update_id"),
    run_nonce: environment.HA_TELEGRAM_RUN_NONCE,
    conversation_id: environment.HA_ANTIGRAVITY_CONVERSATION_ID === undefined ||
      environment.HA_ANTIGRAVITY_CONVERSATION_ID === ""
      ? null
      : environment.HA_ANTIGRAVITY_CONVERSATION_ID,
  });
}

export function executionDigestFor(binding, operation, selectionId, action) {
  return sha256Digest({
    format: "telegram-action-execution-v1",
    binding: normalizeTelegramBinding(binding),
    operation,
    selection_id: selectionId,
    action,
  });
}

export function safeDigestEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" ||
      !DIGEST_PATTERN.test(left) || !DIGEST_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function actionPreview(action) {
  return {
    source_kind: action.source_kind,
    cwd: action.cwd,
    timeout_ms: action.timeout_ms,
    source_sha256: action.source_sha256,
    // Informed consent requires the card to show every approved byte. Never
    // abbreviate a shell source and leave an unseen executable suffix behind;
    // the aggregate preview bound below rejects a proposal that cannot fit.
    source_preview: redactText(action.shell_source),
  };
}

export function normalizeActionProposal(value, bindingValue) {
  const binding = normalizeTelegramBinding(bindingValue);
  assertOnlyKeys(value, new Set(["operation", "summary", "payload", "ttl_seconds"]), "proposal");
  const operation = requireString(value.operation, "operation", {
    max: 32,
    pattern: /^(?:terminal_command|multi_choice_terminal|question)$/u,
    singleLine: true,
  });
  const summary = normalizeChoiceText(value.summary, "summary", MAX_SUMMARY_BYTES);
  const ttlSeconds = own(value, "ttl_seconds")
    ? requireInteger(value.ttl_seconds, "ttl_seconds", {
      min: MIN_TTL_SECONDS,
      max: MAX_TTL_SECONDS,
    })
    : DEFAULT_TTL_SECONDS;
  let payload;
  let preview;
  if (operation === "terminal_command") {
    const action = normalizeTerminalInput(value.payload);
    payload = {
      action,
      execution_digest: executionDigestFor(binding, operation, null, action),
    };
    preview = {
      format: "telegram-action-preview-v1",
      operation,
      summary,
      action: actionPreview(action),
    };
  } else if (operation === "multi_choice_terminal") {
    assertOnlyKeys(value.payload, new Set(["prompt", "choices", "cancel_label"]), "multi-choice payload");
    const prompt = normalizeChoiceText(value.payload.prompt, "prompt", MAX_PROMPT_BYTES);
    const cancelLabel = own(value.payload, "cancel_label")
      ? normalizeChoiceText(value.payload.cancel_label, "cancel_label", MAX_LABEL_BYTES)
      : "취소";
    const choices = normalizeChoiceList(value.payload.choices, (choice, index) => {
      assertOnlyKeys(
        choice,
        new Set(["choice_id", "label", "command", "script", "cwd", "timeout_ms"]),
        `choices[${index}]`,
      );
      const choiceId = requireString(choice.choice_id, `choices[${index}].choice_id`, {
        max: 24,
        pattern: CHOICE_ID_PATTERN,
        singleLine: true,
      });
      const label = normalizeChoiceText(choice.label, `choices[${index}].label`, MAX_LABEL_BYTES);
      const action = normalizeTerminalInput({
        ...(own(choice, "command") ? { command: choice.command } : {}),
        ...(own(choice, "script") ? { script: choice.script } : {}),
        cwd: choice.cwd,
        ...(own(choice, "timeout_ms") ? { timeout_ms: choice.timeout_ms } : {}),
      });
      return {
        choice_id: choiceId,
        label,
        action,
        execution_digest: executionDigestFor(binding, operation, choiceId, action),
      };
    });
    payload = { prompt, choices, cancel_label: cancelLabel };
    preview = {
      format: "telegram-action-preview-v1",
      operation,
      summary,
      prompt,
      choices: choices.map((choice) => ({
        choice_id: choice.choice_id,
        label: choice.label,
        action: actionPreview(choice.action),
      })),
      cancel_label: cancelLabel,
    };
  } else {
    assertOnlyKeys(value.payload, new Set(["prompt", "choices", "cancel_label"]), "question payload");
    const prompt = normalizeChoiceText(value.payload.prompt, "prompt", MAX_PROMPT_BYTES);
    const cancelLabel = own(value.payload, "cancel_label")
      ? normalizeChoiceText(value.payload.cancel_label, "cancel_label", MAX_LABEL_BYTES)
      : "취소";
    const choices = normalizeChoiceList(value.payload.choices, (choice, index) => {
      assertOnlyKeys(choice, new Set(["choice_id", "label"]), `choices[${index}]`);
      const action = normalizeQuestionSelection({
        kind: "question_selection",
        choice_id: requireString(choice.choice_id, `choices[${index}].choice_id`, {
          max: 24,
          pattern: CHOICE_ID_PATTERN,
          singleLine: true,
        }),
        label: normalizeChoiceText(choice.label, `choices[${index}].label`, MAX_LABEL_BYTES),
      });
      return {
        choice_id: action.choice_id,
        label: action.label,
        action,
        execution_digest: executionDigestFor(binding, operation, action.choice_id, action),
      };
    });
    payload = { prompt, choices, cancel_label: cancelLabel };
    preview = {
      format: "telegram-action-preview-v1",
      operation,
      summary,
      prompt,
      choices: choices.map(({ choice_id: choiceId, label }) => ({ choice_id: choiceId, label })),
      cancel_label: cancelLabel,
    };
  }
  const previewBytes = utf8Bytes(stableJson(preview));
  if (previewBytes > MAX_PUBLIC_PREVIEW_BYTES) {
    fail("preview_too_large", "public action preview exceeds the size limit");
  }
  const proposalCore = {
    format: "telegram-action-proposal-v1",
    binding,
    operation,
    summary,
    ttl_seconds: ttlSeconds,
    payload,
  };
  const proposal = {
    ...proposalCore,
    preview: redactValue(preview),
    request_digest: sha256Digest(proposalCore),
  };
  if (utf8Bytes(stableJson(proposal)) > MAX_REGISTER_MESSAGE_BYTES) {
    fail("proposal_too_large", "action proposal exceeds the size limit");
  }
  return proposal;
}

function rawProposalArgumentsFromRegistered(value) {
  if (value.operation === "terminal_command") {
    const action = value.payload?.action;
    return {
      operation: value.operation,
      summary: value.summary,
      ttl_seconds: value.ttl_seconds,
      payload: {
        [action?.source_kind]: action?.shell_source,
        cwd: action?.cwd,
        timeout_ms: action?.timeout_ms,
      },
    };
  }
  if (value.operation === "multi_choice_terminal") {
    return {
      operation: value.operation,
      summary: value.summary,
      ttl_seconds: value.ttl_seconds,
      payload: {
        prompt: value.payload?.prompt,
        choices: Array.isArray(value.payload?.choices)
          ? value.payload.choices.map((choice) => ({
            choice_id: choice?.choice_id,
            label: choice?.label,
            [choice?.action?.source_kind]: choice?.action?.shell_source,
            cwd: choice?.action?.cwd,
            timeout_ms: choice?.action?.timeout_ms,
          }))
          : value.payload?.choices,
        cancel_label: value.payload?.cancel_label,
      },
    };
  }
  return {
    operation: value.operation,
    summary: value.summary,
    ttl_seconds: value.ttl_seconds,
    payload: {
      prompt: value.payload?.prompt,
      choices: Array.isArray(value.payload?.choices)
        ? value.payload.choices.map((choice) => ({
          choice_id: choice?.choice_id,
          label: choice?.label,
        }))
        : value.payload?.choices,
      cancel_label: value.payload?.cancel_label,
    },
  };
}

export function validateRegisteredActionProposal(value) {
  assertOnlyKeys(
    value,
    new Set([
      "format",
      "binding",
      "operation",
      "summary",
      "ttl_seconds",
      "payload",
      "preview",
      "request_digest",
    ]),
    "registered proposal",
  );
  if (value.format !== "telegram-action-proposal-v1") {
    fail("invalid_request", "registered proposal format is invalid");
  }
  const regenerated = normalizeActionProposal(
    rawProposalArgumentsFromRegistered(value),
    value.binding,
  );
  if (stableJson(regenerated) !== stableJson(value)) {
    fail("digest_mismatch", "registered proposal does not match its canonical request");
  }
  return regenerated;
}

export function bindRegisteredActionProposalToConversation(value, liveConversationId) {
  const proposal = validateRegisteredActionProposal(value);
  const conversationId = requireString(liveConversationId, "live conversation_id", {
    max: 256,
    pattern: CONVERSATION_ID_PATTERN,
    singleLine: true,
  });
  if (proposal.binding.conversation_id !== null &&
      proposal.binding.conversation_id !== conversationId) {
    fail("binding_mismatch", "expected conversation does not match the live Telegram run");
  }
  return normalizeActionProposal(rawProposalArgumentsFromRegistered(proposal), {
    ...proposal.binding,
    conversation_id: conversationId,
  });
}

export function renderTelegramActionPreview(value) {
  const proposal = validateRegisteredActionProposal(value);
  const preview = proposal.preview;
  const quotedSource = (source, indentation = "") => String(source)
    .split(/\r?\n/u)
    .map((line) => `${indentation}│ ${line}`);
  const lines = [
    proposal.operation === "question"
      ? "📋 Telegram 선택 요청"
      : "⚡️ Telegram 작업 승인 요청",
    `작업: ${preview.summary}`,
  ];
  if (proposal.operation === "terminal_command") {
    lines.push(
      `경로: ${preview.action.cwd}`,
      `제한 시간: ${preview.action.timeout_ms}ms`,
      `${preview.action.source_kind === "script" ? "스크립트" : "명령"}:`,
      ...quotedSource(preview.action.source_preview),
      `원문 SHA-256: ${preview.action.source_sha256}`,
    );
  } else {
    lines.push(`질문: ${preview.prompt}`);
    for (const choice of preview.choices) {
      lines.push(`• ${choice.label}`);
      if (choice.action) {
        lines.push(
          `  경로: ${choice.action.cwd}`,
          `  제한 시간: ${choice.action.timeout_ms}ms`,
          `  원문 SHA-256: ${choice.action.source_sha256}`,
          ...quotedSource(choice.action.source_preview, "  "),
        );
      }
    }
  }
  const rendered = lines.join("\n");
  if (utf8Bytes(rendered) > MAX_PUBLIC_PREVIEW_BYTES) {
    fail("preview_too_large", "rendered action preview exceeds the size limit");
  }
  return rendered;
}

export function normalizeProposalSocketPath(value) {
  const socketPath = requireString(value, "proposal socket path", {
    max: 220,
    singleLine: true,
  });
  if (!isAbsolute(socketPath) || normalize(socketPath) !== socketPath) {
    fail("invalid_socket", "proposal socket path must be canonical and absolute");
  }
  return socketPath;
}

function socketRequestId() {
  return randomBytes(18).toString("base64url");
}

export function sendActionRegisterRequest(
  proposal,
  {
    socketPath = DEFAULT_TELEGRAM_ACTION_PROPOSAL_SOCKET,
    timeoutMs = 5_000,
    connect = net.createConnection,
  } = {},
) {
  const canonicalProposal = validateRegisteredActionProposal(proposal);
  const canonicalSocketPath = normalizeProposalSocketPath(socketPath);
  const requestId = socketRequestId();
  const envelope = { id: requestId, action: "register", payload: canonicalProposal };
  const encoded = `${stableJson(envelope)}\n`;
  if (utf8Bytes(encoded) > MAX_REGISTER_MESSAGE_BYTES) {
    fail("proposal_too_large", "action proposal exceeds the socket message limit");
  }
  return new Promise((resolveRequest, rejectRequest) => {
    let client;
    try {
      client = connect(canonicalSocketPath);
    } catch {
      rejectRequest(new TelegramActionError("proposal_unavailable", "action proposal service is unavailable"));
      return;
    }
    client.setEncoding("utf8");
    let responseBytes = 0;
    let buffer = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      client.destroy();
      callback(value);
    };
    const deadline = setTimeout(() => finish(
      rejectRequest,
      new TelegramActionError("proposal_timeout", "action proposal service did not respond"),
    ), timeoutMs);
    deadline.unref?.();
    client.once("connect", () => client.write(encoded));
    client.once("error", () => finish(
      rejectRequest,
      new TelegramActionError("proposal_unavailable", "action proposal service is unavailable"),
    ));
    client.once("end", () => finish(
      rejectRequest,
      new TelegramActionError("invalid_response", "action proposal service closed without a response"),
    ));
    client.once("close", () => {
      if (!settled) finish(
        rejectRequest,
        new TelegramActionError("invalid_response", "action proposal service closed without a response"),
      );
    });
    client.on("data", (chunk) => {
      responseBytes += utf8Bytes(chunk);
      if (responseBytes > 16 * 1024) {
        finish(
          rejectRequest,
          new TelegramActionError("invalid_response", "action proposal response exceeded the limit"),
        );
        return;
      }
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let response;
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(rejectRequest, new TelegramActionError("invalid_response", "action proposal service returned invalid JSON"));
        return;
      }
      if (buffer.slice(newline + 1).trim() !== "") {
        finish(rejectRequest, new TelegramActionError("invalid_response", "action proposal service returned trailing data"));
        return;
      }
      const exactKeys = (candidate, expected) => isPlainObject(candidate) &&
        stableJson(Object.keys(candidate).sort()) === stableJson([...expected].sort());
      const safeErrorCode = isPlainObject(response) && response.id === requestId &&
        response.ok === false && exactKeys(response, ["id", "ok", "error"]) &&
        exactKeys(response.error, ["code"]) &&
        typeof response.error.code === "string" &&
        /^[a-z][a-z0-9_]{0,63}$/u.test(response.error.code)
        ? response.error.code
        : null;
      if (safeErrorCode !== null) {
        finish(
          rejectRequest,
          new TelegramActionError(safeErrorCode, "action proposal service rejected the request"),
        );
        return;
      }
      let validResponse = false;
      try {
        const resultKeys = isPlainObject(response?.result)
          ? Object.keys(response.result).sort()
          : [];
        validResponse = exactKeys(response, ["id", "ok", "result"]) &&
          response.id === requestId && response.ok === true &&
          isPlainObject(response.result) &&
          stableJson(resultKeys) === stableJson(["preview", "proposal_id", "request_digest"]) &&
          typeof response.result.proposal_id === "string" &&
          TELEGRAM_ACTION_PROPOSAL_ID_PATTERN.test(response.result.proposal_id) &&
          typeof response.result.request_digest === "string" &&
          DIGEST_PATTERN.test(response.result.request_digest) &&
          (canonicalProposal.binding.conversation_id === null ||
            response.result.request_digest === canonicalProposal.request_digest) &&
          stableJson(response.result.preview) === stableJson(canonicalProposal.preview);
      } catch {
        validResponse = false;
      }
      if (!validResponse) {
        finish(rejectRequest, new TelegramActionError("invalid_response", "action proposal service returned an invalid response"));
        return;
      }
      finish(resolveRequest, {
        proposal_id: response.result.proposal_id,
        request_digest: response.result.request_digest,
        preview: response.result.preview,
      });
    });
  });
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function validJsonRpcId(value) {
  return value === null ||
    (typeof value === "string" && utf8Bytes(value) <= 128 &&
      !DISALLOWED_TEXT_CONTROL_PATTERN.test(value)) ||
    (Number.isSafeInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER);
}

export async function* boundedNdjsonLines(input, maxBytes = MAX_MCP_LINE_BYTES) {
  let chunks = [];
  let lineBytes = 0;
  let oversized = false;
  const emit = () => {
    if (oversized) return { oversized: true, line: null };
    let line = Buffer.concat(chunks, lineBytes);
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    return { oversized: false, line: line.toString("utf8") };
  };
  for await (const inputChunk of input) {
    const chunk = Buffer.isBuffer(inputChunk) ? inputChunk : Buffer.from(inputChunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (!oversized) {
        lineBytes += part.length;
        if (lineBytes > maxBytes) {
          oversized = true;
          chunks = [];
        } else if (part.length > 0) {
          chunks.push(Buffer.from(part));
        }
      }
      if (newline < 0) break;
      yield emit();
      chunks = [];
      lineBytes = 0;
      oversized = false;
      offset = newline + 1;
    }
  }
  if (oversized || lineBytes > 0) yield emit();
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(error) {
  const code = error instanceof TelegramActionError ? error.code : "proposal_error";
  return {
    content: [{ type: "text", text: `${code}: Telegram action proposal was not registered` }],
    structuredContent: { error: code },
    isError: true,
  };
}

export function createTelegramActionMcpHandler({
  binding,
  register = (proposal) => sendActionRegisterRequest(proposal),
} = {}) {
  const bound = normalizeTelegramBinding(binding);
  return async function handleRequest(message) {
    if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      throw new TelegramActionError("invalid_request", "Invalid Request");
    }
    if (Object.keys(message).some((key) => !["jsonrpc", "id", "method", "params"].includes(key)) ||
        utf8Bytes(message.method) > 128 ||
        (own(message, "id") && !validJsonRpcId(message.id))) {
      throw new TelegramActionError("invalid_request", "Invalid Request");
    }
    const id = own(message, "id") ? message.id : undefined;
    if (message.method === "notifications/initialized" || id === undefined) return null;
    if (message.method === "initialize") {
      const protocolVersion = typeof message.params?.protocolVersion === "string" &&
        message.params.protocolVersion !== ""
        ? message.params.protocolVersion
        : DEFAULT_PROTOCOL_VERSION;
      return jsonRpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "This server only registers requester-bound Telegram action proposals. It never executes, selects, or approves them and returns only an opaque proposal_id, final request digest, and bounded public preview.",
      });
    }
    if (message.method === "ping") return jsonRpcResult(id, {});
    if (message.method === "tools/list") return jsonRpcResult(id, { tools });
    if (message.method !== "tools/call") return jsonRpcError(id, -32601, "Method not found");
    if (!isPlainObject(message.params) ||
        Object.keys(message.params).some((key) => !["name", "arguments", "_meta"].includes(key)) ||
        message.params.name !== "telegram_action_propose" ||
        !isPlainObject(message.params.arguments)) {
      return jsonRpcError(id, -32602, "Invalid tool parameters");
    }
    try {
      if (own(message.params.arguments, "requester") || own(message.params.arguments, "binding")) {
        fail("binding_override_forbidden", "Telegram binding is supplied by the trusted wrapper");
      }
      const proposal = normalizeActionProposal(message.params.arguments, bound);
      const result = await register(proposal);
      if (!isPlainObject(result) || typeof result.proposal_id !== "string" ||
          !TELEGRAM_ACTION_PROPOSAL_ID_PATTERN.test(result.proposal_id) ||
          typeof result.request_digest !== "string" ||
          !DIGEST_PATTERN.test(result.request_digest) ||
          (proposal.binding.conversation_id !== null &&
            result.request_digest !== proposal.request_digest) ||
          stableJson(result.preview) !== stableJson(proposal.preview)) {
        fail("invalid_response", "proposal service returned an invalid identifier");
      }
      return jsonRpcResult(id, toolResult({
        proposal_id: result.proposal_id,
        request_digest: result.request_digest,
        preview: result.preview,
      }));
    } catch (error) {
      return jsonRpcResult(id, toolError(error));
    }
  };
}

export async function runTelegramActionMcpServer({
  input = process.stdin,
  output = process.stdout,
  environment = process.env,
} = {}) {
  const binding = telegramBindingFromEnvironment(environment);
  const socketPath = environment.HA_TELEGRAM_ACTION_PROPOSAL_SOCKET === undefined
    ? DEFAULT_TELEGRAM_ACTION_PROPOSAL_SOCKET
    : normalizeProposalSocketPath(environment.HA_TELEGRAM_ACTION_PROPOSAL_SOCKET);
  for (const key of Object.keys(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE|NODE_OPTIONS|NODE_PATH/iu.test(key)) {
      delete process.env[key];
    }
  }
  delete process.env.HA_TELEGRAM_USER_ID;
  delete process.env.HA_TELEGRAM_CHAT_ID;
  delete process.env.HA_TELEGRAM_SESSION_GENERATION;
  delete process.env.HA_TELEGRAM_UPDATE_ID;
  delete process.env.HA_TELEGRAM_RUN_NONCE;
  delete process.env.HA_ANTIGRAVITY_CONVERSATION_ID;
  const handleRequest = createTelegramActionMcpHandler({
    binding,
    register: (proposal) => sendActionRegisterRequest(proposal, { socketPath }),
  });
  for await (const frame of boundedNdjsonLines(input)) {
    if (frame.oversized) {
      output.write(`${JSON.stringify(jsonRpcError(null, -32700, "Request exceeded the size limit"))}\n`);
      continue;
    }
    const line = frame.line;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error"))}\n`);
      continue;
    }
    try {
      const response = await handleRequest(message);
      if (response !== null) output.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      const id = isPlainObject(message) && own(message, "id") ? message.id : null;
      const invalid = error instanceof TelegramActionError && error.code === "invalid_request";
      output.write(`${JSON.stringify(jsonRpcError(
        id,
        invalid ? -32600 : -32603,
        invalid ? error.message : "Internal error",
      ))}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTelegramActionMcpServer().catch(() => process.exit(1));
}
