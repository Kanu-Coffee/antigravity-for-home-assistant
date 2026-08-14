import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { BrokerError, sendBrokerRequest } from "./ha-change-broker.mjs";
import {
  consumePairing,
  hasPairingBootstrap,
  isPaired,
} from "./telegram-pairing.mjs";
import {
  acknowledgeUpdate,
  clearConversation,
  getConversation,
  loadBridgeState,
  loadSealedUpdates,
  registerSealedUpdateBatch,
  setConversation,
} from "./telegram-state.mjs";

const OPTIONS_PATH = "/data/options.json";
const DEFAULT_AGY_BIN = "/usr/local/libexec/ha-telegram-worker";
const TELEGRAM_HOME = "/data/antigravity-ha/telegram-home";
const TELEGRAM_WORKSPACE = "/usr/local/share/antigravity-ha/telegram-workspace";
const RESULT_SCHEMA_PATH = "/usr/local/share/antigravity-ha/telegram-result-schema.json";
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_LINE_BYTES = 256 * 1024;
const MAX_TELEGRAM_RESPONSE_BYTES = 256 * 1024;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const EXECUTION_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const EXECUTION_POLL_INTERVAL_MS = 250;
const APPROVAL_TTL_MS = 2 * 60 * 1000;
const MAX_QUEUED_PER_REQUESTER = 4;
const MAX_ACTIVE_RUNS = 2;
const MAX_TELEGRAM_CHUNKS = 8;
const AUTHORIZATION_RECHECK_MS = 2_000;
const TELEGRAM_PERMANENT_HOLD_MS = 60 * 60 * 1_000;
const ANTIGRAVITY_AUTH_REQUIRED_MARKER = Buffer.from(
  "Error: authentication required. Run 'antigravity-real' to log in, then retry.",
  "utf8",
);
const ANTIGRAVITY_HEADLESS_PERMISSION_MARKER = Buffer.from(
  'a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.',
  "utf8",
);
const TELEGRAM_WORKER_INTEGRITY_MARKER = Buffer.from(
  "ha-telegram-worker: isolated native configuration is unavailable",
  "utf8",
);
const WORKER_FAILURE_REASONS = Object.freeze([
  "authentication_required",
  "headless_read_denied",
  "runtime_integrity_failed",
  "worker_failed",
]);
const REQUEST_FAILURE_REASONS = Object.freeze([
  ...WORKER_FAILURE_REASONS,
  "request_failed",
  "timeout",
]);
const TELEGRAM_TRANSPORT_ERROR_CODES = Object.freeze([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ETIMEDOUT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const ACCESS_MODES = new Set(["read_only", "confirm_changes", "autonomous"]);
const pendingApprovals = new Map();
const chatQueues = new Map();
const activeChildren = new Map();
const backgroundUpdateTasks = new Set();
const inFlightUpdates = new Map();
const backgroundBatchFailures = new Map();
let activeRuns = 0;
const globalWaiters = [];

const METRIC_LABELS = Object.freeze({
  updatesDenied: Object.freeze([
    "expired",
    "invalid_request",
    "invalid_update",
    "policy",
    "queue_full",
    "requester_mismatch",
    "unauthorized",
  ]),
  jobsCompleted: Object.freeze(["cancelled", "error", "success", "timeout"]),
  approvalResults: Object.freeze([
    "autonomous",
    "cancelled",
    "confirmed",
    "denied",
    "expired",
    "policy_denied",
    "requested",
  ]),
  risks: Object.freeze(["high", "low"]),
  apiErrors: Object.freeze(["4xx", "5xx", "network", "other", "timeout"]),
  streamEventsIgnored: Object.freeze(["unknown_type"]),
});

function zeroRecord(labels) {
  return Object.fromEntries(labels.map((label) => [label, 0]));
}

const metricState = {
  updatesReceived: 0,
  updatesDenied: zeroRecord(METRIC_LABELS.updatesDenied),
  jobsCompleted: zeroRecord(METRIC_LABELS.jobsCompleted),
  approvals: Object.fromEntries(METRIC_LABELS.approvalResults.flatMap(
    (result) => METRIC_LABELS.risks.map((risk) => [`${result}:${risk}`, 0]),
  )),
  workerDuration: {
    count: 0,
    sum: 0,
    max: 0,
    buckets: { le_1: 0, le_5: 0, le_30: 0, le_300: 0, inf: 0 },
  },
  apiErrors: zeroRecord(METRIC_LABELS.apiErrors),
  streamEventsIgnored: zeroRecord(METRIC_LABELS.streamEventsIgnored),
};

const PROCESS_SALT = randomBytes(32);
let workerRuntimeStatus = "not_checked";

class BoundedByteMatcher {
  constructor(needle) {
    if (!Buffer.isBuffer(needle) || needle.length === 0) {
      throw new Error("bounded matcher needle must be non-empty bytes");
    }
    this.needle = Buffer.from(needle);
    this.tail = Buffer.alloc(0);
    this.matched = false;
  }

  push(chunk) {
    if (this.matched) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length === 0) return;
    if (bytes.indexOf(this.needle) !== -1) {
      this.matched = true;
      this.tail = Buffer.alloc(0);
      return;
    }
    const tailLimit = this.needle.length - 1;
    if (this.tail.length > 0 && tailLimit > 0) {
      const boundary = Buffer.concat([
        this.tail,
        bytes.subarray(0, Math.min(bytes.length, tailLimit)),
      ]);
      if (boundary.indexOf(this.needle) !== -1) {
        this.matched = true;
        this.tail = Buffer.alloc(0);
        return;
      }
    }
    if (tailLimit === 0) {
      this.tail = Buffer.alloc(0);
    } else if (bytes.length >= tailLimit) {
      this.tail = Buffer.from(bytes.subarray(bytes.length - tailLimit));
    } else {
      const combined = Buffer.concat([this.tail, bytes]);
      this.tail = Buffer.from(combined.subarray(Math.max(0, combined.length - tailLimit)));
    }
  }

  get bufferedBytes() {
    return this.tail.length;
  }
}

class AntigravityWorkerError extends Error {
  constructor(reasonClass) {
    if (!WORKER_FAILURE_REASONS.includes(reasonClass)) {
      throw new Error("Antigravity worker failure reason is not allowlisted");
    }
    const messages = {
      authentication_required: "Antigravity worker authentication is required",
      headless_read_denied: "Antigravity headless file read was denied",
      runtime_integrity_failed: "Antigravity worker runtime integrity check failed",
      worker_failed: "Antigravity worker exited unsuccessfully",
    };
    super(messages[reasonClass]);
    this.name = "AntigravityWorkerError";
    this.reasonClass = reasonClass;
  }
}

function safeError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 300);
}

class TelegramPollBackoff {
  constructor({ jitter = () => randomBytes(2).readUInt16BE(0) % 500 } = {}) {
    if (typeof jitter !== "function") throw new Error("Telegram backoff jitter must be callable");
    this.jitter = jitter;
    this.consecutiveFailures = 0;
  }

  reset() {
    this.consecutiveFailures = 0;
  }

  nextDelay(error) {
    this.consecutiveFailures += 1;
    const baseDelay = error?.status === 429 && Number.isSafeInteger(error.retryAfter)
      ? Math.min(Math.max(error.retryAfter, 1), 60) * 1_000
      : Math.min(30_000, 1_000 * (2 ** Math.min(this.consecutiveFailures, 5)));
    const jitter = this.jitter();
    if (!Number.isSafeInteger(jitter) || jitter < 0 || jitter >= 500) {
      throw new Error("Telegram backoff jitter is outside the bounded range");
    }
    return Math.min(60_000, baseDelay + jitter);
  }
}

function audit(event, fields = {}) {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([key]) => !["prompt", "output", "token", "body"].includes(key)),
  );
  console.log(`[Telegram Bridge] ${JSON.stringify({ event, ...safeFields })}`);
}

function incrementBounded(record, label) {
  if (!Object.hasOwn(record, label)) throw new Error("metric label is not allowlisted");
  record[label] += 1;
}

function recordDenial(reasonClass) {
  incrementBounded(metricState.updatesDenied, reasonClass);
}

function recordApproval(resultClass, risk) {
  incrementBounded(metricState.approvals, `${resultClass}:${risk}`);
}

function recordWorkerDuration(seconds) {
  const duration = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  metricState.workerDuration.count += 1;
  metricState.workerDuration.sum += duration;
  metricState.workerDuration.max = Math.max(metricState.workerDuration.max, duration);
  metricState.workerDuration.buckets.inf += 1;
  for (const [bucket, limit] of [["le_1", 1], ["le_5", 5], ["le_30", 30], ["le_300", 300]]) {
    if (duration <= limit) metricState.workerDuration.buckets[bucket] += 1;
  }
}

function jobResultClass(error) {
  if (error instanceof RequestCancelledError) return "cancelled";
  if (/timed out/u.test(error instanceof Error ? error.message : "")) return "timeout";
  return "error";
}

function requestFailureReason(error) {
  let reasonClass = "request_failed";
  if (error instanceof AntigravityWorkerError &&
      WORKER_FAILURE_REASONS.includes(error.reasonClass)) {
    reasonClass = error.reasonClass;
  } else if (/timed out/u.test(error instanceof Error ? error.message : "")) {
    reasonClass = "timeout";
  }
  return REQUEST_FAILURE_REASONS.includes(reasonClass) ? reasonClass : "request_failed";
}

function renderRequestFailure(error) {
  switch (requestFailureReason(error)) {
    case "authentication_required":
      return "Telegram 전용 Antigravity 로그인이 필요합니다. App 웹 터미널 또는 SSH에서 ha-telegram-login을 실행한 뒤 다시 시도하세요.";
    case "headless_read_denied":
      return "Telegram AI의 허용되지 않은 파일 읽기가 차단되었습니다. 정상 질문에서 발생했다면 App을 최신 버전으로 업데이트하고 재시작하세요.";
    case "runtime_integrity_failed":
      return "Telegram 전용 AI 실행 환경의 무결성 검증에 실패했습니다. App을 재시작한 뒤 다시 시도하세요. 계속 실패하면 App 로그를 확인하세요.";
    default:
      return "요청을 완료하지 못했습니다. App 로그를 확인하세요.";
  }
}

function workerStatusSnapshot() {
  return workerRuntimeStatus;
}

function resetWorkerStatusForTest() {
  workerRuntimeStatus = "not_checked";
}

function renderWorkerStatus() {
  const descriptions = {
    not_checked: "아직 확인되지 않음",
    ready: "최근 요청 정상",
    authentication_required: "Telegram 전용 로그인 필요 (ha-telegram-login)",
    headless_read_denied: "파일 읽기 권한 차단",
    runtime_integrity_failed: "격리 실행 환경 무결성 오류",
    worker_failed: "최근 요청 실패",
  };
  return descriptions[workerRuntimeStatus] ?? descriptions.worker_failed;
}

function telegramTransportErrorCode(error) {
  const code = [error?.code, error?.cause?.code]
    .find((candidate) => TELEGRAM_TRANSPORT_ERROR_CODES.includes(candidate));
  return code ?? "unknown";
}

function classifyApiError(error) {
  if (error?.name === "AbortError") return "timeout";
  if (Number.isInteger(error?.status)) {
    if (error.status >= 400 && error.status < 500) return "4xx";
    if (error.status >= 500 && error.status < 600) return "5xx";
  }
  if (error instanceof TypeError || telegramTransportErrorCode(error) !== "unknown") {
    return "network";
  }
  return "other";
}

function isTransientTelegramApiError(error) {
  const errorClass = classifyApiError(error);
  return error?.status === 429 || ["5xx", "network", "timeout"].includes(errorClass);
}

function isPermanentTelegramApiError(error) {
  return Number.isInteger(error?.status) &&
    error.status >= 400 && error.status < 500 && error.status !== 429;
}

async function holdTelegramFailClosed({
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  while (true) await wait(TELEGRAM_PERMANENT_HOLD_MS);
}

function queuedJobCount() {
  let queued = globalWaiters.length;
  for (const entry of chatQueues.values()) queued += Math.max(0, entry.queued - 1);
  return queued;
}

function metricsSnapshot() {
  return {
    updates_received_total: metricState.updatesReceived,
    updates_denied_total: { ...metricState.updatesDenied },
    jobs_active: activeRuns,
    jobs_queued: queuedJobCount(),
    jobs_completed_total: { ...metricState.jobsCompleted },
    approvals_total: { ...metricState.approvals },
    worker_duration_seconds: {
      count: metricState.workerDuration.count,
      sum: Number(metricState.workerDuration.sum.toFixed(6)),
      max: Number(metricState.workerDuration.max.toFixed(6)),
      buckets: { ...metricState.workerDuration.buckets },
    },
    telegram_api_errors_total: { ...metricState.apiErrors },
    stream_events_ignored_total: { ...metricState.streamEventsIgnored },
  };
}

function resetMetricsForTest() {
  metricState.updatesReceived = 0;
  Object.assign(metricState.updatesDenied, zeroRecord(METRIC_LABELS.updatesDenied));
  Object.assign(metricState.jobsCompleted, zeroRecord(METRIC_LABELS.jobsCompleted));
  Object.assign(metricState.approvals, Object.fromEntries(METRIC_LABELS.approvalResults.flatMap(
    (result) => METRIC_LABELS.risks.map((risk) => [`${result}:${risk}`, 0]),
  )));
  metricState.workerDuration = {
    count: 0,
    sum: 0,
    max: 0,
    buckets: { le_1: 0, le_5: 0, le_30: 0, le_300: 0, inf: 0 },
  };
  Object.assign(metricState.apiErrors, zeroRecord(METRIC_LABELS.apiErrors));
  Object.assign(
    metricState.streamEventsIgnored,
    zeroRecord(METRIC_LABELS.streamEventsIgnored),
  );
}

function resetUpdateRuntimeForTest() {
  inFlightUpdates.clear();
  backgroundBatchFailures.clear();
}

function opaqueId(value) {
  return createHash("sha256").update(PROCESS_SALT).update(String(value)).digest("hex").slice(0, 12);
}

function readOptions(path = OPTIONS_PATH) {
  if (!existsSync(path)) throw new Error("options file is missing");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("options file must contain an object");
  }
  return value;
}

function normalizeIds(value, key, { signed }) {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  const result = new Set();
  for (const item of value) {
    const id = String(item).trim();
    const pattern = signed ? /^-?[1-9]\d{0,19}$/ : /^[1-9]\d{0,19}$/;
    if (!pattern.test(id)) throw new Error(`${key} contains an invalid Telegram id`);
    result.add(id);
  }
  return result;
}

function loadRuntimeConfig(options) {
  const enabled = options.telegram_enabled === true;
  const botToken = typeof options.telegram_bot_token === "string" ? options.telegram_bot_token.trim() : "";
  const accessMode = options.telegram_access_mode ?? "confirm_changes";
  if (!ACCESS_MODES.has(accessMode)) throw new Error("telegram_access_mode is invalid");
  const allowedUsers = normalizeIds(
    options.telegram_allowed_user_ids,
    "telegram_allowed_user_ids",
    { signed: false },
  );
  const allowedChats = normalizeIds(
    options.telegram_allowed_chat_ids,
    "telegram_allowed_chat_ids",
    { signed: true },
  );
  if (enabled && !/^[1-9]\d{5,15}:[A-Za-z0-9_-]{30,128}$/.test(botToken)) {
    throw new Error("telegram_bot_token is missing or malformed");
  }
  return { enabled, botToken, accessMode, allowedUsers, allowedChats };
}

function isForwardedMessage(messageLike) {
  return [
    "forward_origin",
    "forward_date",
    "forward_from",
    "forward_from_chat",
    "forward_sender_name",
  ].some((key) => Object.hasOwn(messageLike ?? {}, key));
}

function pairingTokenFromMessage(messageLike) {
  if (messageLike?.chat?.type !== "private" || isForwardedMessage(messageLike)) {
    return null;
  }
  const text = typeof messageLike?.text === "string" ? messageLike.text.trim() : "";
  return /^\/start\s+([A-Za-z0-9_-]{20,128})$/u.exec(text)?.[1] ?? null;
}

function isAuthorized(config, messageLike, { pairingLookup = isPaired } = {}) {
  const userId = String(messageLike?.from?.id ?? "");
  const chat = messageLike?.chat ?? messageLike?.message?.chat;
  const chatId = String(chat?.id ?? "");
  const staticAuthorized = config.allowedUsers.size > 0 &&
    config.allowedChats.size > 0 &&
    config.allowedUsers.has(userId) &&
    config.allowedChats.has(chatId);
  if (staticAuthorized) return true;
  if (chat?.type !== "private") return false;
  try {
    return pairingLookup(userId, chatId, { chatType: chat.type });
  } catch {
    return false;
  }
}

function hasStaticAuthorization(config) {
  return config.allowedUsers.size > 0 && config.allowedChats.size > 0;
}

async function waitForTelegramAuthorization(config, {
  pairingBootstrap = hasPairingBootstrap,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (hasStaticAuthorization(config)) return "static";
  if (pairingBootstrap()) return "local_pairing";
  audit("waiting_for_authorization", {
    reason: "static_allowlists_or_local_pairing_required",
  });
  while (!pairingBootstrap()) {
    await wait(AUTHORIZATION_RECHECK_MS);
  }
  audit("authorization_ready", { method: "local_pairing" });
  return "local_pairing";
}

function chunkText(text, maxLen = 4096) {
  const normalized = String(text || "응답이 없습니다.").replace(/\u0000/g, "");
  const codePoints = Array.from(normalized);
  if (codePoints.length <= maxLen) return [normalized];
  const chunks = [];
  let offset = 0;
  while (offset < codePoints.length) {
    let end = Math.min(offset + maxLen, codePoints.length);
    if (end < codePoints.length) {
      const window = codePoints.slice(offset, end).join("");
      const newline = window.lastIndexOf("\n");
      if (newline >= Math.floor(maxLen / 2)) end = offset + Array.from(window.slice(0, newline)).length;
    }
    chunks.push(codePoints.slice(offset, end).join(""));
    offset = end;
    if (codePoints[offset] === "\n") offset += 1;
    if (chunks.length > MAX_TELEGRAM_CHUNKS) {
      throw new Error("Telegram response exceeds the safe message limit");
    }
  }
  return chunks;
}

async function boundedJsonResponse(response) {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TELEGRAM_RESPONSE_BYTES) {
    throw new Error("Telegram response exceeded the safe size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_TELEGRAM_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Telegram response exceeded the safe size limit");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    return null;
  }
}

async function telegramApi(botToken, method, body = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await boundedJsonResponse(response);
    if (!response.ok || !payload?.ok) {
      const error = new Error(`Telegram ${method} failed with HTTP ${response.status}`);
      error.status = response.status;
      const retryAfter = payload?.parameters?.retry_after;
      if (Number.isSafeInteger(retryAfter)) error.retryAfter = Math.min(Math.max(retryAfter, 1), 60);
      throw error;
    }
    return payload.result;
  } catch (error) {
    incrementBounded(metricState.apiErrors, classifyApiError(error));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function connectTelegram(config, {
  api = telegramApi,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  backoff = new TelegramPollBackoff(),
  auditEvent = audit,
  hold = holdTelegramFailClosed,
} = {}) {
  while (true) {
    try {
      await api(config.botToken, "deleteWebhook", { drop_pending_updates: false }, 15_000);
      const bot = await api(config.botToken, "getMe", {}, 15_000);
      backoff.reset();
      auditEvent("connected", { bot: opaqueId(bot.id), mode: config.accessMode });
      return bot;
    } catch (error) {
      if (isPermanentTelegramApiError(error)) {
        auditEvent("connect_blocked", {
          reason_class: "4xx",
          status: error.status,
        });
        await hold();
        throw error;
      }
      if (!isTransientTelegramApiError(error)) throw error;
      const errorClass = classifyApiError(error);
      const retryDelay = backoff.nextDelay(error);
      const fields = {
        reason_class: errorClass,
        retry_in_seconds: Math.ceil(retryDelay / 1_000),
      };
      if (errorClass === "network") {
        fields.transport_code = telegramTransportErrorCode(error);
      }
      auditEvent("connect_retry", fields);
      await wait(retryDelay);
    }
  }
}

async function sendMessage(botToken, chatId, text, extra = {}) {
  const chunks = chunkText(text);
  for (let index = 0; index < chunks.length; index += 1) {
    await telegramApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: chunks[index],
      reply_markup: index === chunks.length - 1 ? extra.reply_markup : undefined,
    });
  }
}

function buildAgyArgs(_mode = "plan", sandboxEnabled = true, conversationId = null) {
  const args = [
    "--output-format",
    "stream-json",
    "--print-timeout",
    "5m",
    "--json-schema",
    RESULT_SCHEMA_PATH,
    "--agent",
    "ha-telegram",
    "--mode",
    "plan",
    "--disable-slash-commands",
  ];
  if (conversationId !== null) {
    if (typeof conversationId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(conversationId)) {
      throw new Error("stored Antigravity conversation id is invalid");
    }
    args.push("--conversation", conversationId);
  }
  if (sandboxEnabled) args.push("--sandbox");
  return args;
}

function extractString(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => extractString(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  for (const key of ["response", "result", "output", "text", "content", "message"]) {
    if (Object.hasOwn(value, key)) {
      const found = extractString(value[key], depth + 1);
      if (found) return found;
    }
  }
  return "";
}

function parseTerminalResponse(value) {
  if (typeof value !== "string") {
    throw new Error("Antigravity terminal response was not JSON text");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Antigravity terminal response contained invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      JSON.stringify(Object.keys(parsed).sort()) !==
        JSON.stringify(["proposal_ids", "response"])) {
    throw new Error("Antigravity terminal response did not match the managed schema");
  }
  if (typeof parsed.response !== "string" || !Array.isArray(parsed.proposal_ids)) {
    throw new Error("Antigravity terminal response did not match the managed schema");
  }
  return parsed;
}

function decodeStreamUtf8(stdout) {
  if (typeof stdout === "string") return stdout;
  if (!Buffer.isBuffer(stdout) && !(stdout instanceof Uint8Array)) {
    throw new Error("Antigravity stream must be UTF-8 bytes");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    throw new Error("Antigravity stream contained invalid UTF-8");
  }
}

function parseStreamResult(stream) {
  const stdout = decodeStreamUtf8(stream);
  let result = null;
  let resultEvents = 0;
  let initEvents = 0;
  let terminalSeen = false;
  let conversationId = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_STREAM_LINE_BYTES) {
      throw new Error("Antigravity stream line exceeded the safe limit");
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("Antigravity stream contained invalid JSON");
    }
    if (terminalSeen) {
      throw new Error("Antigravity stream contained an event after the terminal result");
    }
    if (typeof event?.event !== "string" || event.event.length === 0) {
      throw new Error("Antigravity stream contained a missing or malformed event discriminator");
    }
    const knownEventType = /^(?:init|step_update|result)$/u.test(event.event);
    if (!knownEventType) {
      if (initEvents !== 1) {
        throw new Error("Antigravity unknown event arrived before init");
      }
      incrementBounded(metricState.streamEventsIgnored, "unknown_type");
      continue;
    }
    if (event?.event === "init") {
      initEvents += 1;
      if (initEvents !== 1) {
        throw new Error("Antigravity stream contained an invalid init sequence");
      }
      const candidate = event.conversation_id ?? event.conversationId;
      if (typeof candidate !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(candidate)) {
        throw new Error("Antigravity init event contained an invalid conversation identifier");
      }
      conversationId = candidate;
    }
    if (event?.event === "result") {
      if (initEvents !== 1) {
        throw new Error("Antigravity terminal result arrived outside a valid init sequence");
      }
      if (typeof event.result !== "object" || event.result === null ||
          Array.isArray(event.result) || event.result.status !== "SUCCESS") {
        throw new Error("Antigravity terminal result did not report success");
      }
      if (event.result.conversation_id !== conversationId) {
        throw new Error("Antigravity terminal result changed the conversation identifier");
      }
      terminalSeen = true;
      resultEvents += 1;
      result = parseTerminalResponse(event.result.response);
    } else if (event?.event === "step_update" && initEvents !== 1) {
      throw new Error("Antigravity progress event arrived before init");
    }
  }
  if (initEvents !== 1 || resultEvents !== 1 || !result) {
    throw new Error("Antigravity returned no unique structured terminal result event");
  }
  if (Buffer.byteLength(result.response) > MAX_RESULT_BYTES) {
    throw new Error("Antigravity terminal response exceeded the safe limit");
  }
  if (result.proposal_ids.length > 1 ||
      result.proposal_ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(id))) {
    throw new Error("Antigravity terminal result contained invalid proposal identifiers");
  }
  return {
    response: result.response.replace(/\u0000/g, ""),
    proposalIds: [...result.proposal_ids],
    conversationId,
  };
}

function throwIfSignalCancelled(signal) {
  if (signal?.aborted === true) throw new RequestCancelledError();
}

function awaitWithCancellation(promise, signal) {
  if (signal === null || signal === undefined) return promise;
  throwIfSignalCancelled(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, new RequestCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function acquireRunSlot(signal = null) {
  throwIfSignalCancelled(signal);
  if (activeRuns < MAX_ACTIVE_RUNS) {
    activeRuns += 1;
    return;
  }
  await new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      signal,
      settled: false,
      onAbort: null,
    };
    waiter.onAbort = () => {
      if (waiter.settled) return;
      waiter.settled = true;
      const index = globalWaiters.indexOf(waiter);
      if (index !== -1) globalWaiters.splice(index, 1);
      reject(new RequestCancelledError());
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    globalWaiters.push(waiter);
    if (signal?.aborted === true) waiter.onAbort();
  });
}

function releaseRunSlot() {
  activeRuns -= 1;
  while (globalWaiters.length > 0) {
    const next = globalWaiters.shift();
    if (next.settled || next.signal?.aborted === true) {
      next.onAbort();
      continue;
    }
    next.settled = true;
    next.signal?.removeEventListener("abort", next.onAbort);
    activeRuns += 1;
    next.resolve();
    break;
  }
}

async function runAntigravityPrompt(prompt, {
  mode = "plan",
  sandboxEnabled = true,
  binary = DEFAULT_AGY_BIN,
  prefixArgs = [],
  timeoutMs = RUN_TIMEOUT_MS,
  hardKillGraceMs = 10_000,
  cwd = TELEGRAM_WORKSPACE,
  runId = randomBytes(8).toString("hex"),
  requester = null,
  conversationId = null,
  signal = null,
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prompt must not be empty");
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
    throw new Error(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  }
  await acquireRunSlot(signal);
  const startedAt = process.hrtime.bigint();
  let child = null;
  const abortWorker = () => {
    if (child !== null) terminateChildWithGrace(child, hardKillGraceMs);
  };
  try {
    throwIfSignalCancelled(signal);
    signal?.addEventListener("abort", abortWorker, { once: true });
    throwIfSignalCancelled(signal);
    const args = [...prefixArgs, ...buildAgyArgs(mode, sandboxEnabled, conversationId)];
    const childEnvironment = {
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      HOME: TELEGRAM_HOME,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TERM: "dumb",
      NO_COLOR: "1",
    };
    if (requester !== null) {
      const userId = String(requester.user_id ?? "");
      const chatId = String(requester.chat_id ?? "");
      if (!/^[1-9]\d{0,19}$/.test(userId) || !/^-?[1-9]\d{0,19}$/.test(chatId)) {
        throw new Error("requester binding is invalid");
      }
      childEnvironment.HA_TELEGRAM_USER_ID = userId;
      childEnvironment.HA_TELEGRAM_CHAT_ID = chatId;
    }
    throwIfSignalCancelled(signal);
    child = spawn(binary, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnvironment,
      detached: true,
    });
    activeChildren.set(runId, child);
    if (signal?.aborted === true) abortWorker();
    const stdoutChunks = [];
    let oversized = false;
    let stdoutBytes = 0;
    let currentLineBytes = 0;
    const authRequiredMatcher = new BoundedByteMatcher(ANTIGRAVITY_AUTH_REQUIRED_MARKER);
    const headlessPermissionMatcher = new BoundedByteMatcher(
      ANTIGRAVITY_HEADLESS_PERMISSION_MARKER,
    );
    const runtimeIntegrityMatcher = new BoundedByteMatcher(TELEGRAM_WORKER_INTEGRITY_MARKER);
    child.stderr.on("data", (chunk) => {
      authRequiredMatcher.push(chunk);
      headlessPermissionMatcher.push(chunk);
      runtimeIntegrityMatcher.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      if (oversized) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      for (const byte of bytes) {
        if (byte === 0x0a) currentLineBytes = 0;
        else currentLineBytes += 1;
        if (currentLineBytes > MAX_STREAM_LINE_BYTES) break;
      }
      if (stdoutBytes > MAX_STREAM_BYTES || currentLineBytes > MAX_STREAM_LINE_BYTES) {
        oversized = true;
        terminateChildWithGrace(child, hardKillGraceMs);
        return;
      }
      stdoutChunks.push(bytes);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildWithGrace(child, hardKillGraceMs);
    }, timeoutMs);
    child.stdin.end(`${prompt}\n`);
    let closeResult;
    try {
      try {
        closeResult = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
        });
      } catch {
        workerRuntimeStatus = "worker_failed";
        throw new AntigravityWorkerError("worker_failed");
      }
    } finally {
      clearTimeout(timer);
    }
    const { code } = closeResult;
    activeChildren.delete(runId);
    throwIfSignalCancelled(signal);
    if (oversized) {
      workerRuntimeStatus = "worker_failed";
      throw new Error("Antigravity output exceeded the safe limit");
    }
    if (timedOut) {
      workerRuntimeStatus = "worker_failed";
      throw new Error("Antigravity request timed out");
    }
    if (code !== 0) {
      const reasonClass = code === 70 && runtimeIntegrityMatcher.matched
        ? "runtime_integrity_failed"
        : code === 1 && authRequiredMatcher.matched
          ? "authentication_required"
          : "worker_failed";
      workerRuntimeStatus = reasonClass;
      throw new AntigravityWorkerError(reasonClass);
    }
    if (stdoutBytes === 0) {
      const reasonClass = headlessPermissionMatcher.matched
        ? "headless_read_denied"
        : "worker_failed";
      workerRuntimeStatus = reasonClass;
      throw new AntigravityWorkerError(reasonClass);
    }
    let parsed;
    try {
      parsed = parseStreamResult(Buffer.concat(stdoutChunks, stdoutBytes));
    } catch (error) {
      workerRuntimeStatus = "worker_failed";
      throw error;
    }
    workerRuntimeStatus = "ready";
    return parsed;
  } finally {
    signal?.removeEventListener("abort", abortWorker);
    activeChildren.delete(runId);
    releaseRunSlot();
    recordWorkerDuration(Number(process.hrtime.bigint() - startedAt) / 1_000_000_000);
  }
}

function terminateChild(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (Number.isSafeInteger(child.pid) && child.pid > 1) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

const childKillTimers = new WeakMap();

function terminateChildWithGrace(child, graceMs = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  terminateChild(child, "SIGTERM");
  if (!childKillTimers.has(child)) {
    const timer = setTimeout(() => {
      childKillTimers.delete(child);
      terminateChild(child, "SIGKILL");
    }, graceMs);
    timer.unref();
    childKillTimers.set(child, timer);
    child.once("close", () => {
      const pendingTimer = childKillTimers.get(child);
      if (pendingTimer) clearTimeout(pendingTimer);
      childKillTimers.delete(child);
    });
  }
  return true;
}

function requesterKey(userId, chatId) {
  return `${String(userId)}:${String(chatId)}`;
}

class RequestCancelledError extends Error {
  constructor() {
    super("Telegram request was cancelled");
    this.name = "RequestCancelledError";
  }
}

class ExecutionResultDeliveryError extends Error {
  constructor() {
    super("durable execution result could not be delivered");
    this.name = "ExecutionResultDeliveryError";
  }
}

function assertJobActive(ticket) {
  if (ticket?.cancelled === true) throw new RequestCancelledError();
}

function setJobPhase(ticket, phase) {
  if (ticket) ticket.phase = phase;
}

function enqueueRequester(userId, chatId, task) {
  const key = requesterKey(userId, chatId);
  const entry = chatQueues.get(key) ?? {
    tail: Promise.resolve(),
    queued: 0,
    tickets: new Set(),
  };
  if (entry.queued >= MAX_QUEUED_PER_REQUESTER + 1) {
    recordDenial("queue_full");
    throw new Error("이 사용자/채팅의 작업 대기열이 가득 찼습니다.");
  }
  const ticket = {
    cancelled: false,
    phase: "queued",
    cancellationController: new AbortController(),
  };
  entry.tickets.add(ticket);
  entry.queued += 1;
  const run = entry.tail.then(() => {
    assertJobActive(ticket);
    setJobPhase(ticket, "planning");
    return task(ticket);
  });
  entry.tail = run.then(() => undefined, () => undefined).finally(() => {
    setJobPhase(ticket, "completed");
    entry.tickets.delete(ticket);
    entry.queued -= 1;
    if (entry.queued === 0) chatQueues.delete(key);
  });
  chatQueues.set(key, entry);
  return run;
}

function cancelRequesterWork(userId, chatId, { hardKillGraceMs = 10_000 } = {}) {
  const key = requesterKey(userId, chatId);
  const result = {
    queued_cancelled: 0,
    running_cancel_requested: 0,
    approvals_cancelled: 0,
    durable_in_progress: 0,
    workers_terminated: 0,
  };
  const entry = chatQueues.get(key);
  if (entry) {
    for (const ticket of entry.tickets) {
      if (ticket.cancelled) continue;
      if (ticket.phase === "durable_running") {
        result.durable_in_progress += 1;
        continue;
      }
      ticket.cancelled = true;
      ticket.cancellationController.abort();
      if (ticket.phase === "queued") result.queued_cancelled += 1;
      else if (ticket.phase === "proposal") continue;
      else result.running_cancel_requested += 1;
    }
  }
  for (const [runId, child] of activeChildren) {
    if (runId.startsWith(`${key}:`)) {
      if (terminateChildWithGrace(child, hardKillGraceMs)) {
        result.workers_terminated += 1;
      }
    }
  }
  for (const [approvalId, approval] of pendingApprovals) {
    if (approval.requester.user_id === String(userId) &&
        approval.requester.chat_id === String(chatId)) {
      clearTimeout(approval.timer);
      pendingApprovals.delete(approvalId);
      recordApproval("cancelled", approval.proposal.risk);
      result.approvals_cancelled += 1;
    }
  }
  return result;
}

function renderCancellationResult(result) {
  const messages = [];
  if (result.queued_cancelled > 0) messages.push(`대기 작업 ${result.queued_cancelled}개를 취소했습니다.`);
  if (result.running_cancel_requested > 0) {
    messages.push(
      `실행 중 조회/계획 작업 ${result.running_cancel_requested}개에 취소를 요청했습니다. 기존 broker 변경이 확인되면 그 결과는 계속 전달합니다.`,
    );
  }
  if (result.approvals_cancelled > 0) {
    messages.push(`승인 대기 제안 ${result.approvals_cancelled}개를 취소했습니다.`);
  }
  if (result.durable_in_progress > 0) {
    messages.push(
      `broker에 이미 접수된 변경 ${result.durable_in_progress}개는 취소할 수 없습니다. 완료 상태를 계속 확인해 결과를 전달합니다.`,
    );
  }
  if (messages.length === 0) return "취소할 실행 중 작업이 없습니다.";
  return messages.join("\n");
}

function createApproval({ requester, proposal, idempotencyKey }) {
  for (const [existingId, existing] of pendingApprovals) {
    if (existing.requester.chat_id === requester.chat_id &&
        existing.requester.user_id === requester.user_id) {
      clearTimeout(existing.timer);
      pendingApprovals.delete(existingId);
      recordApproval("cancelled", existing.proposal.risk);
    }
  }
  const id = randomBytes(16).toString("base64url");
  const expiresAt = Date.now() + APPROVAL_TTL_MS;
  const timer = setTimeout(() => {
    if (pendingApprovals.delete(id)) recordApproval("expired", proposal.risk);
  }, APPROVAL_TTL_MS);
  timer.unref();
  pendingApprovals.set(id, {
    requester: { ...requester },
    proposal: { ...proposal },
    idempotencyKey,
    expiresAt,
    timer,
  });
  recordApproval("requested", proposal.risk);
  return { id, expiresAt };
}

function renderProposal(proposal) {
  return [
    `변경 유형: ${proposal.operation}`,
    `위험도: ${proposal.risk}`,
    "검증된 미리보기:",
    JSON.stringify(proposal.preview, null, 2),
  ].join("\n");
}

function renderExecutionResult(result) {
  const safe = {
    status: result?.status ?? "unknown",
    operation: result?.operation ?? "unknown",
    changed: typeof result?.changed === "boolean" || result?.changed === null
      ? result.changed
      : "unknown",
    replayed: result?.replayed === true,
  };
  for (const key of [
    "reason",
    "config_check",
    "reload",
    "fresh_verification",
    "previous_state",
    "test_state",
    "current_state",
  ]) {
    if (typeof result?.[key] === "string" && result[key].length <= 128) safe[key] = result[key];
  }
  if (typeof result?.desired_memory?.status === "string") {
    safe.desired_memory = result.desired_memory.status.slice(0, 80);
  }
  if (typeof result?.rollback?.status === "string") {
    safe.rollback = result.rollback.status.slice(0, 80);
  }
  if (typeof result?.restore?.status === "string") {
    safe.restore = result.restore.status.slice(0, 80);
  }
  return `Broker 실행 결과:\n${JSON.stringify(safe, null, 2)}`;
}

async function sendExecutionResult(botToken, chatId, result) {
  try {
    await sendMessage(botToken, chatId, renderExecutionResult(result));
  } catch {
    throw new ExecutionResultDeliveryError();
  }
}

function proposalDisposition(accessMode, risk) {
  if (!ACCESS_MODES.has(accessMode) || !["low", "high"].includes(risk)) {
    throw new Error("proposal disposition input is invalid");
  }
  if (accessMode === "read_only") return "read_only";
  if (accessMode === "autonomous" && risk === "low") return "autonomous_policy";
  return "human_confirmation";
}

async function inspectProposal(proposalId, requester) {
  const proposal = await sendBrokerRequest("inspect", {
    proposal_id: proposalId,
    requester,
  });
  const expiresAt = Date.parse(proposal?.expires_at ?? "");
  if (proposal?.proposal_id !== proposalId ||
      !["config_patch", "service_call", "device_test"].includes(proposal?.operation) ||
      proposal?.requester?.user_id !== requester.user_id ||
      proposal?.requester?.chat_id !== requester.chat_id ||
      !["low", "high"].includes(proposal?.risk) ||
      !proposal?.preview || typeof proposal.preview !== "object" || Array.isArray(proposal.preview) ||
      !/^sha256:[a-f0-9]{64}$/.test(proposal?.preview_digest ?? "") ||
      !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("change broker returned an invalid proposal binding");
  }
  return proposal;
}

function terminalExecutionResult(state, replayed = false) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("change broker returned an invalid execution state");
  }
  if (state.status === "completed") {
    if (!state.result || typeof state.result !== "object" || Array.isArray(state.result)) {
      throw new Error("change broker returned an invalid durable execution result");
    }
    return { ...state.result, replayed: replayed || state.replayed === true };
  }
  if (state.status === "in_doubt") {
    return {
      status: "in_doubt",
      operation: typeof state.operation === "string" ? state.operation : "unknown",
      reason: typeof state.reason === "string"
        ? state.reason
        : "previous_attempt_not_proven_complete",
      changed: null,
      replayed: replayed || state.replayed === true,
    };
  }
  if (!["accepted", "running"].includes(state.status)) {
    throw new Error("change broker returned an invalid execution state");
  }
  return null;
}

async function waitForExecution(requester, idempotencyKey, {
  initialState = null,
  replayed = false,
  brokerRequest = sendBrokerRequest,
  pollIntervalMs = EXECUTION_POLL_INTERVAL_MS,
  waitTimeoutMs = EXECUTION_WAIT_TIMEOUT_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const deadline = Date.now() + waitTimeoutMs;
  let state = initialState;
  while (true) {
    if (state !== null) {
      const terminal = terminalExecutionResult(state, replayed);
      if (terminal) return terminal;
    }
    if (Date.now() >= deadline) {
      return {
        status: "in_doubt",
        operation: typeof state?.operation === "string" ? state.operation : "unknown",
        reason: "durable_result_wait_timeout",
        changed: null,
        replayed,
      };
    }
    await sleep(pollIntervalMs);
    try {
      state = await brokerRequest("execute_status", {
        requester,
        idempotency_key: idempotencyKey,
      });
    } catch (error) {
      if (error instanceof BrokerError && ["timeout", "broker_unavailable"].includes(error.code)) {
        continue;
      }
      throw error;
    }
  }
}

async function lookupExecution(requester, idempotencyKey, options = {}) {
  const brokerRequest = options.brokerRequest ?? sendBrokerRequest;
  const sleep = options.sleep ?? ((milliseconds) => new Promise(
    (resolve) => setTimeout(resolve, milliseconds),
  ));
  const assertActive = options.assertActive ?? (() => {});
  const signal = options.signal ?? null;
  const assertLookupActive = () => {
    assertActive();
    throwIfSignalCancelled(signal);
  };
  const deadline = Date.now() + (options.waitTimeoutMs ?? EXECUTION_WAIT_TIMEOUT_MS);
  let state;
  while (state === undefined) {
    assertLookupActive();
    try {
      state = await awaitWithCancellation(
        brokerRequest("execute_status", {
          requester,
          idempotency_key: idempotencyKey,
        }),
        signal,
      );
    } catch (error) {
      if (error instanceof BrokerError && error.code === "execution_not_found") {
        assertLookupActive();
        return null;
      }
      if (!(error instanceof BrokerError) ||
          !["timeout", "broker_unavailable"].includes(error.code) || Date.now() >= deadline) {
        throw error;
      }
      assertLookupActive();
      await awaitWithCancellation(
        sleep(options.pollIntervalMs ?? EXECUTION_POLL_INTERVAL_MS),
        signal,
      );
    }
  }
  terminalExecutionResult(state, state?.replayed === true);
  options.onExecutionFound?.(state);
  return waitForExecution(requester, idempotencyKey, { ...options, initialState: state });
}

async function executeProposal(
  proposal,
  requester,
  authorization,
  idempotencyKey,
  options = {},
) {
  const brokerRequest = options.brokerRequest ?? sendBrokerRequest;
  const assertActive = options.assertActive ?? (() => {});
  const updatePhase = options.setPhase ?? (() => {});
  updatePhase("authorizing");
  assertActive();
  const authorized = await brokerRequest("authorize", {
    proposal_id: proposal.proposal_id,
    requester,
    preview_digest: proposal.preview_digest,
    authorization,
  });
  assertActive();
  const executionPayload = {
    proposal_id: proposal.proposal_id,
    requester,
    preview_digest: proposal.preview_digest,
    capability: authorized.capability,
    idempotency_key: idempotencyKey,
  };
  let started;
  let lastError = null;
  updatePhase("durable_running");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      started = await brokerRequest("execute", executionPayload);
      break;
    } catch (error) {
      lastError = error;
      if (!(error instanceof BrokerError) || !["timeout", "broker_unavailable"].includes(error.code)) {
        throw error;
      }
      if (attempt === 0) await (options.sleep ?? ((milliseconds) => new Promise(
        (resolve) => setTimeout(resolve, milliseconds),
      )))(options.pollIntervalMs ?? EXECUTION_POLL_INTERVAL_MS);
    }
  }
  if (!started) {
    const recovered = await lookupExecution(requester, idempotencyKey, options).catch((error) => {
      if (error instanceof BrokerError && error.code === "execution_not_found") return null;
      throw error;
    });
    if (recovered) return recovered;
    throw lastError ?? new Error("change broker execution could not be started");
  }
  return waitForExecution(requester, idempotencyKey, {
    ...options,
    brokerRequest,
    initialState: started,
    replayed: started.replayed === true,
  });
}

async function processPrompt(config, message, ticket = null) {
  const chatId = String(message.chat.id);
  const userId = String(message.from.id);
  const requester = { surface: "telegram", user_id: userId, chat_id: chatId };
  const prompt = message.text.trim();
  const correlation = opaqueId(`${userId}:${chatId}:${message.updateId ?? "local"}`);
  const idempotencyKey = `tg:${userId}:${chatId}:${message.updateId ?? randomBytes(8).toString("hex")}`;
  audit("request_accepted", {
    chat: opaqueId(chatId),
    user: opaqueId(userId),
    correlation,
    bytes: Buffer.byteLength(prompt),
  });
  setJobPhase(ticket, "recovery_lookup");
  const cancellationSignal = ticket?.cancellationController.signal ?? null;
  const recoveredExecution = await lookupExecution(requester, idempotencyKey, {
    signal: cancellationSignal,
    assertActive: () => assertJobActive(ticket),
    onExecutionFound: () => {
      setJobPhase(ticket, "durable_running");
      if (ticket) ticket.cancelled = false;
    },
  });
  if (recoveredExecution !== null) {
    audit("execution_result_recovered", {
      chat: opaqueId(chatId),
      user: opaqueId(userId),
      status: recoveredExecution.status,
    });
    await sendExecutionResult(config.botToken, chatId, recoveredExecution);
    return;
  }
  setJobPhase(ticket, "planning");
  assertJobActive(ticket);
  await telegramApi(config.botToken, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  assertJobActive(ticket);

  const conversationId = getConversation(userId, chatId);
  const workerResult = await runAntigravityPrompt(prompt, {
    mode: "plan",
    runId: `${requesterKey(userId, chatId)}:${randomBytes(8).toString("hex")}`,
    requester,
    conversationId,
    signal: cancellationSignal,
  });
  assertJobActive(ticket);
  const nextConversationId = workerResult.conversationId ?? conversationId;
  if (nextConversationId) setConversation(userId, chatId, nextConversationId);
  if (workerResult.response) await sendMessage(config.botToken, chatId, workerResult.response);
  assertJobActive(ticket);
  if (workerResult.proposalIds.length === 0) return;

  const proposal = await inspectProposal(workerResult.proposalIds[0], requester);
  assertJobActive(ticket);
  const disposition = proposalDisposition(config.accessMode, proposal.risk);
  if (disposition === "read_only") {
    recordDenial("policy");
    recordApproval("policy_denied", proposal.risk);
    await sendMessage(
      config.botToken,
      chatId,
      `${renderProposal(proposal)}\n\n읽기 전용 모드이므로 이 제안은 실행되지 않습니다.`,
    );
    return;
  }

  if (disposition === "autonomous_policy") {
    recordApproval("autonomous", proposal.risk);
    const result = await executeProposal(proposal, requester, "autonomous_policy", idempotencyKey, {
      assertActive: () => assertJobActive(ticket),
      setPhase: (phase) => setJobPhase(ticket, phase),
      signal: cancellationSignal,
    });
    await sendExecutionResult(config.botToken, chatId, result);
    return;
  }

  setJobPhase(ticket, "proposal");
  const approval = createApproval({ requester, proposal, idempotencyKey });
  await sendMessage(config.botToken, chatId, `${renderProposal(proposal)}\n\n이 변경을 실행할까요?`, {
    reply_markup: {
      inline_keyboard: [[
        { text: "실행", callback_data: `v2a:${approval.id}` },
        { text: "취소", callback_data: `v2d:${approval.id}` },
      ]],
    },
  });
}

async function handleCallback(config, callback) {
  const callbackId = callback.id;
  const match = /^(v2a|v2d):([A-Za-z0-9_-]{16,64})$/.exec(callback.data ?? "");
  const request = match ? pendingApprovals.get(match[2]) : undefined;
  const chatId = String(callback.message?.chat?.id ?? "");
  const userId = String(callback.from?.id ?? "");
  const callbackIdempotencyKey = Number.isSafeInteger(callback.updateId)
    ? `tgcb:${userId}:${chatId}:${callback.updateId}`
    : request?.idempotencyKey ?? null;
  if (!request && match?.[1] === "v2a" && callbackIdempotencyKey !== null) {
    const requester = { surface: "telegram", user_id: userId, chat_id: chatId };
    const recoveredExecution = await lookupExecution(requester, callbackIdempotencyKey);
    if (recoveredExecution !== null) {
      await telegramApi(config.botToken, "answerCallbackQuery", {
        callback_query_id: callbackId,
        text: "기존 실행 결과를 확인했습니다.",
      });
      await sendExecutionResult(config.botToken, chatId, recoveredExecution);
      return;
    }
  }
  if (!request || request.expiresAt < Date.now()) {
    if (!request) recordDenial(match ? "expired" : "invalid_request");
    if (request?.expiresAt < Date.now()) {
      clearTimeout(request.timer);
      pendingApprovals.delete(match[2]);
      recordDenial("expired");
      recordApproval("expired", request.proposal.risk);
    }
    await telegramApi(config.botToken, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "승인 요청이 만료되었거나 요청자와 일치하지 않습니다.",
      show_alert: true,
    });
    return;
  }
  if (request.requester.chat_id !== chatId || request.requester.user_id !== userId) {
    recordDenial("requester_mismatch");
    recordApproval("denied", request.proposal.risk);
    await telegramApi(config.botToken, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "승인 요청이 만료되었거나 요청자와 일치하지 않습니다.",
      show_alert: true,
    });
    return;
  }
  clearTimeout(request.timer);
  pendingApprovals.delete(match[2]);
  if (match[1] === "v2d") {
    recordApproval("cancelled", request.proposal.risk);
    await telegramApi(config.botToken, "answerCallbackQuery", { callback_query_id: callbackId, text: "취소했습니다." });
    return;
  }
  recordApproval("confirmed", request.proposal.risk);
  audit("approval_consumed", {
    chat: opaqueId(chatId),
    user: opaqueId(userId),
    risk: request.proposal.risk,
  });
  const approvedRun = enqueueRequester(userId, chatId, async (ticket) => {
    let completion = "success";
    try {
      assertJobActive(ticket);
      setJobPhase(ticket, "authorizing");
      const current = await inspectProposal(request.proposal.proposal_id, request.requester);
      assertJobActive(ticket);
      if (current.preview_digest !== request.proposal.preview_digest) {
        throw new Error("approved proposal preview changed");
      }
      const result = await executeProposal(
        current,
        request.requester,
        "human_confirmed",
        callbackIdempotencyKey ?? request.idempotencyKey,
        {
          assertActive: () => assertJobActive(ticket),
          setPhase: (phase) => setJobPhase(ticket, phase),
          signal: ticket.cancellationController.signal,
        },
      );
      await sendExecutionResult(config.botToken, chatId, result);
    } catch (error) {
      completion = ticket.cancelled ? "cancelled" : jobResultClass(error);
      if (error instanceof RequestCancelledError || ticket.cancelled) return;
      if (error instanceof ExecutionResultDeliveryError) throw error;
      audit("approved_run_failed", { chat: opaqueId(chatId), error: safeError(error) });
      await sendMessage(config.botToken, chatId, "승인된 작업을 완료하지 못했습니다. App 로그를 확인하세요.");
    } finally {
      incrementBounded(metricState.jobsCompleted, completion);
    }
  });
  void approvedRun.catch(() => {});
  await telegramApi(config.botToken, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text: "승인했습니다.",
  });
  await approvedRun;
}

async function handleMessage(config, message) {
  const chatId = String(message.chat?.id ?? "");
  const userId = String(message.from?.id ?? "");
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) return;
  const startCommand = text === "/start" || text.startsWith("/start ");
  const pairingToken = pairingTokenFromMessage(message);
  const authorized = isAuthorized(config, message);
  if (!authorized && pairingToken) {
    let paired = null;
    try {
      paired = consumePairing(pairingToken, userId, chatId, { chatType: message.chat.type });
    } catch {
      paired = null;
    }
    if (paired) {
      audit("pairing_completed", { chat: opaqueId(chatId), user: opaqueId(userId) });
      await sendMessage(
        config.botToken,
        chatId,
        "Telegram 사용자 인증이 완료되었습니다. Bot pairing은 별도 Antigravity OAuth 로그인이 아닙니다. AI 로그인이 필요하면 App 웹 터미널 또는 SSH에서 ha-telegram-login을 실행하세요. /help로 사용법을 확인할 수 있습니다.",
      );
      return;
    }
  }
  if (!authorized) {
    recordDenial("unauthorized");
    audit("authorization_denied", { chat: opaqueId(chatId), user: opaqueId(message.from?.id ?? "") });
    await sendMessage(config.botToken, chatId, "이 봇을 사용할 권한이 없습니다.");
    return;
  }
  if (startCommand || text === "/help") {
    await sendMessage(config.botToken, chatId,
      `Antigravity for Home Assistant\n모드: ${config.accessMode}\n/new 새 대화\n/status Telegram 연결과 최근 AI worker 상태 확인\n/cancel 현재 작업 취소\nBot pairing과 Telegram 전용 Antigravity OAuth는 별도입니다. 변경은 broker 정책과 현재 모드에 따라 별도 승인됩니다.`);
    return;
  }
  if (text === "/status") {
    const key = requesterKey(userId, chatId);
    await sendMessage(config.botToken, chatId,
      `Telegram transport: 연결 정상\nAI worker 최근 상태: ${renderWorkerStatus()}\n접근 모드: ${config.accessMode}\n활성/대기 작업: ${chatQueues.get(key)?.queued ?? 0}`);
    return;
  }
  if (text === "/cancel") {
    const cancellation = cancelRequesterWork(userId, chatId);
    await sendMessage(config.botToken, chatId, renderCancellationResult(cancellation));
    return;
  }
  if (text === "/new") {
    clearConversation(userId, chatId);
    await sendMessage(config.botToken, chatId, "대화 바인딩을 초기화했습니다. 다음 요청은 새 대화로 처리됩니다.");
    return;
  }
  if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
    recordDenial("invalid_request");
    await sendMessage(config.botToken, chatId, `요청은 UTF-8 ${MAX_PROMPT_BYTES}바이트 이하여야 합니다.`);
    return;
  }
  await enqueueRequester(userId, chatId, async (ticket) => {
    let completion = "success";
    try {
      await processPrompt(config, { ...message, text, updateId: message.updateId }, ticket);
    } catch (error) {
      completion = ticket.cancelled ? "cancelled" : jobResultClass(error);
      if (error instanceof RequestCancelledError || ticket.cancelled) return;
      if (error instanceof ExecutionResultDeliveryError) throw error;
      audit("request_failed", {
        chat: opaqueId(chatId),
        reason_class: requestFailureReason(error),
      });
      await sendMessage(config.botToken, chatId, renderRequestFailure(error));
    } finally {
      incrementBounded(metricState.jobsCompleted, completion);
    }
  });
}

function normalizeUpdate(update) {
  if (!update || typeof update !== "object" || Array.isArray(update) ||
      !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    throw new Error("Telegram update envelope is invalid");
  }
  if (update.message) {
    const fromId = String(update.message.from?.id ?? "");
    const chatId = String(update.message.chat?.id ?? "");
    if (!/^[1-9]\d{0,19}$/.test(fromId) || !/^-?[1-9]\d{0,19}$/.test(chatId)) return null;
    if (!Number.isSafeInteger(update.message.message_id) || update.message.message_id <= 0 ||
        typeof update.message.text !== "string") return null;
    const chatType = String(update.message.chat.type ?? "unknown");
    if (!/^[a-z_]{1,32}$/u.test(chatType)) return null;
    const text = update.message.text.normalize("NFC").replace(/\r\n?/g, "\n");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return null;
    if (isForwardedMessage(update.message) &&
        /^\/start\s+[A-Za-z0-9_-]{20,128}$/u.test(text.trim())) {
      return null;
    }
    return {
      updateId: update.update_id,
      kind: "message",
      value: {
        updateId: update.update_id,
        message_id: update.message.message_id,
        from: { id: fromId },
        chat: { id: chatId, type: chatType },
        text,
      },
    };
  }
  if (update.callback_query) {
    const fromId = String(update.callback_query.from?.id ?? "");
    const chatId = String(update.callback_query.message?.chat?.id ?? "");
    const data = update.callback_query.data;
    const chatType = String(update.callback_query.message?.chat?.type ?? "unknown");
    if (!/^[1-9]\d{0,19}$/.test(fromId) || !/^-?[1-9]\d{0,19}$/.test(chatId) ||
        typeof update.callback_query.id !== "string" || update.callback_query.id.length < 1 ||
        update.callback_query.id.length > 128 ||
        typeof data !== "string" || Buffer.byteLength(data) > 128) {
      return null;
    }
    if (!/^[a-z_]{1,32}$/u.test(chatType)) return null;
    return {
      updateId: update.update_id,
      kind: "callback_query",
      value: {
        updateId: update.update_id,
        id: update.callback_query.id,
        from: { id: fromId },
        message: {
          chat: {
            id: chatId,
            type: chatType,
          },
        },
        data,
      },
    };
  }
  return null;
}

function trackBackgroundUpdate(task, normalized) {
  backgroundUpdateTasks.add(task);
  void task.then(
    () => undefined,
    (error) => {
      if (error instanceof RequestCancelledError) return;
      audit("update_task_failed", {
        kind: normalized?.kind ?? "unknown",
        error: safeError(error),
      });
    },
  ).finally(() => backgroundUpdateTasks.delete(task));
  return task;
}

function dispatchNormalizedUpdate(config, normalized, {
  messageHandler = handleMessage,
  callbackHandler = handleCallback,
  authorization = isAuthorized,
  api = telegramApi,
} = {}) {
  const task = (async () => {
    if (normalized?.kind === "callback_query") {
      if (!authorization(config, normalized.value)) {
        recordDenial("unauthorized");
        await api(config.botToken, "answerCallbackQuery", {
          callback_query_id: normalized.value.id,
          text: "권한이 없습니다.",
          show_alert: true,
        });
        return;
      }
      await callbackHandler(config, normalized.value);
      return;
    }
    if (normalized?.kind === "message") {
      await messageHandler(config, normalized.value);
    }
  })();
  return trackBackgroundUpdate(task, normalized);
}

async function dispatchUpdateBatch(config, updates, {
  statePath,
  messageHandler = handleMessage,
  callbackHandler = handleCallback,
  authorization = isAuthorized,
  api = telegramApi,
} = {}) {
  if (!Array.isArray(updates)) throw new Error("Telegram update batch is invalid");
  metricState.updatesReceived += updates.length;
  if (updates.length === 0) return loadBridgeState(statePath).transport_offset;
  const records = updates.map((update) => {
    if (!update || typeof update !== "object" || Array.isArray(update) ||
        !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      throw new Error("Telegram update envelope is invalid");
    }
    return {
      update_id: update.update_id,
      normalized: normalizeUpdate(update),
    };
  });
  const stateOptions = statePath === undefined ? {} : { path: statePath };
  const registration = registerSealedUpdateBatch(records, config.botToken, stateOptions);
  for (const record of records) {
    if (record.normalized === null) recordDenial("invalid_update");
  }
  dispatchRegisteredUpdates(config, registration.updates, {
    statePath,
    messageHandler,
    callbackHandler,
    authorization,
    api,
  });
  return registration.transport_offset;
}

function dispatchRegisteredUpdates(config, normalizedUpdates, {
  statePath,
  messageHandler = handleMessage,
  callbackHandler = handleCallback,
  authorization = isAuthorized,
  api = telegramApi,
} = {}) {
  const stateOptions = statePath === undefined ? {} : { path: statePath };
  const storageKey = statePath ?? "<default>";
  for (const normalized of normalizedUpdates) {
    const updateId = normalized.updateId;
    const key = `${storageKey}:${updateId}`;
    const existing = inFlightUpdates.get(key);
    if (existing) continue;
    const dispatched = dispatchNormalizedUpdate(config, normalized, {
      messageHandler,
      callbackHandler,
      authorization,
      api,
    });
    let tracked;
    tracked = dispatched
      .then(() => acknowledgeUpdate(updateId, stateOptions))
      .finally(() => {
        if (inFlightUpdates.get(key) === tracked) inFlightUpdates.delete(key);
      });
    inFlightUpdates.set(key, tracked);
    void tracked.catch((error) => {
      const previous = backgroundBatchFailures.get(storageKey);
      if (!previous || updateId < previous.updateId) {
        backgroundBatchFailures.set(storageKey, { updateId, error });
      }
    });
  }
}

function replaySealedUpdateSpool(config, options = {}) {
  const stateOptions = options.statePath === undefined ? {} : { path: options.statePath };
  const normalizedUpdates = loadSealedUpdates(config.botToken, stateOptions);
  dispatchRegisteredUpdates(config, normalizedUpdates, options);
  return normalizedUpdates.length;
}

async function pollUpdateBatches(config, {
  statePath,
  messageHandler = handleMessage,
  callbackHandler = handleCallback,
  authorization = isAuthorized,
  api = telegramApi,
  shouldContinue = () => true,
} = {}) {
  let offset = loadBridgeState(statePath).transport_offset;
  const pollBackoff = new TelegramPollBackoff();
  const storageKey = statePath ?? "<default>";
  while (shouldContinue()) {
    try {
      const backgroundFailure = backgroundBatchFailures.get(storageKey);
      if (backgroundFailure) {
        backgroundBatchFailures.delete(storageKey);
        throw backgroundFailure.error;
      }
      replaySealedUpdateSpool(config, {
        statePath,
        messageHandler,
        callbackHandler,
        authorization,
        api,
      });
      const updates = await api(config.botToken, "getUpdates", {
        offset,
        limit: 100,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      }, 45_000);
      offset = await dispatchUpdateBatch(config, updates, {
        statePath,
        messageHandler,
        callbackHandler,
        authorization,
        api,
      });
      pollBackoff.reset();
    } catch (error) {
      audit("poll_failed", { error: safeError(error) });
      if (error?.status === 401 || error?.status === 403 || error?.code === "ETELEGRAMSPOOL") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, pollBackoff.nextDelay(error)));
      offset = loadBridgeState(statePath).transport_offset;
    }
  }
  return offset;
}

async function main() {
  const config = loadRuntimeConfig(readOptions());
  if (!config.enabled) {
    audit("disabled");
    return;
  }
  await waitForTelegramAuthorization(config);
  const brokerHealth = await sendBrokerRequest("health", {});
  if (brokerHealth?.status !== "ready") throw new Error("change broker is not ready");
  await connectTelegram(config);
  const metricsTimer = setInterval(() => audit("metrics", metricsSnapshot()), 60_000);
  metricsTimer.unref();
  await pollUpdateBatches(config);
}

export {
  ACCESS_MODES,
  ANTIGRAVITY_AUTH_REQUIRED_MARKER,
  ANTIGRAVITY_HEADLESS_PERMISSION_MARKER,
  TELEGRAM_WORKER_INTEGRITY_MARKER,
  AntigravityWorkerError,
  BoundedByteMatcher,
  TelegramPollBackoff,
  buildAgyArgs,
  cancelRequesterWork,
  chunkText,
  connectTelegram,
  createApproval,
  dispatchNormalizedUpdate,
  dispatchRegisteredUpdates,
  dispatchUpdateBatch,
  enqueueRequester,
  extractString,
  holdTelegramFailClosed,
  inspectProposal,
  isAuthorized,
  loadRuntimeConfig,
  lookupExecution,
  metricsSnapshot,
  normalizeUpdate,
  normalizeIds,
  pairingTokenFromMessage,
  parseStreamResult,
  pollUpdateBatches,
  proposalDisposition,
  requesterKey,
  resetMetricsForTest,
  resetUpdateRuntimeForTest,
  resetWorkerStatusForTest,
  replaySealedUpdateSpool,
  renderCancellationResult,
  renderRequestFailure,
  renderWorkerStatus,
  requestFailureReason,
  runAntigravityPrompt,
  safeError,
  terminalExecutionResult,
  telegramTransportErrorCode,
  waitForExecution,
  waitForTelegramAuthorization,
  workerStatusSnapshot,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    audit("fatal", { error: safeError(error) });
    process.exitCode = 1;
  });
}
