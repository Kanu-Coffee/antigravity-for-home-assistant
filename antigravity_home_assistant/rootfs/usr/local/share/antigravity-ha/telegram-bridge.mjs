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
  acknowledgeDeliveryChunk,
  applyNewSessionControl,
  bindSessionConversation,
  cleanupPendingApprovals,
  deleteTerminalTurn,
  deletePendingApproval,
  deletePendingApprovalsForSession,
  discardResponseDelivery,
  ensureSession,
  getPendingApproval,
  getControlEffect,
  getPendingDelivery,
  getSession,
  getTerminalTurn,
  listPendingApprovals,
  listPendingDeliveries,
  loadBridgeState,
  loadSealedUpdates,
  markDeliveryAttempting,
  markDeliveryAmbiguous,
  markDeliveryPending,
  markPendingApprovalApproved,
  queueResponseDelivery,
  recoverAttemptingDeliveries,
  registerSealedUpdateBatch,
  resetDeliveryForRetry,
  saveTerminalTurn,
  savePendingApproval,
  saveControlEffect,
  finalizeTerminalTurn,
} from "./telegram-state.mjs";

const OPTIONS_PATH = "/data/options.json";
const DEFAULT_AGY_BIN = "/usr/local/bin/antigravity";
const SHARED_ANTIGRAVITY_HOME = "/data/home";
const SHARED_ANTIGRAVITY_WORKSPACE = "/config";
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_LINE_BYTES = 256 * 1024;
const MAX_TELEGRAM_RESPONSE_BYTES = 256 * 1024;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const EXECUTION_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const EXECUTION_POLL_INTERVAL_MS = 250;
const APPROVAL_TTL_MS = 2 * 60 * 1000;
const DELIVERY_RETRY_LIMIT = 3;
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
const WORKER_FAILURE_REASONS = Object.freeze([
  "authentication_required",
  "conversation_mismatch",
  "headless_read_denied",
  "proposal_result_invalid",
  "stream_contract_failed",
  "terminal_missing",
  "terminal_response_invalid",
  "terminal_status_failed",
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

const TOOL_PERMISSIONS = new Set([
  "request-review",
  "proceed-in-sandbox",
  "always-proceed",
  "strict",
]);
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
      conversation_mismatch: "Antigravity resumed a different conversation",
      headless_read_denied: "Antigravity headless file read was denied",
      proposal_result_invalid: "Antigravity change proposal result was invalid",
      stream_contract_failed: "Antigravity stream contract validation failed",
      terminal_missing: "Antigravity terminal result was missing",
      terminal_response_invalid: "Antigravity terminal response was invalid",
      terminal_status_failed: "Antigravity terminal result did not succeed",
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
      return "Antigravity 로그인이 필요합니다. App 웹 터미널 또는 SSH에서 antigravity를 실행해 로그인한 뒤 다시 시도하세요.";
    case "headless_read_denied":
      return "현재 전역 Antigravity 권한 정책에서 비대화형 도구 실행이 승인되지 않았습니다. App의 전역 도구 권한을 확인하거나 해당 작업을 웹 터미널에서 승인하세요.";
    case "conversation_mismatch":
      return "저장된 대화와 Antigravity 세션이 일치하지 않습니다. /new 명령으로 새 대화를 시작한 뒤 다시 시도하세요.";
    case "proposal_result_invalid":
      return "Home Assistant 변경 제안 결과를 안전하게 확인하지 못해 중단했습니다. 변경은 실행되지 않았습니다.";
    case "stream_contract_failed":
    case "terminal_missing":
    case "terminal_response_invalid":
    case "terminal_status_failed":
      return "Antigravity의 최종 응답을 검증하지 못했습니다. /status에서 최근 런타임 상태를 확인하세요.";
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
    authentication_required: "공유 Antigravity 로그인 필요 (antigravity)",
    conversation_mismatch: "저장된 대화와 런타임 세션 불일치 (/new 필요)",
    headless_read_denied: "전역 권한 정책의 대화형 승인 필요",
    proposal_result_invalid: "최근 변경 제안 결과 검증 실패",
    stream_contract_failed: "최근 응답 스트림 형식 검증 실패",
    terminal_missing: "최근 요청의 최종 결과 누락",
    terminal_response_invalid: "최근 최종 응답 내용 검증 실패",
    terminal_status_failed: "최근 Antigravity 실행이 성공 상태로 끝나지 않음",
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
  const toolPermission = options.antigravity_tool_permission ?? "request-review";
  if (!TOOL_PERMISSIONS.has(toolPermission)) {
    throw new Error("antigravity_tool_permission is invalid");
  }
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
  return { enabled, botToken, toolPermission, allowedUsers, allowedChats };
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
    if (error && typeof error === "object" && typeof error.telegramMethod !== "string") {
      error.telegramMethod = method;
    }
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
      auditEvent("connected", {
        bot: opaqueId(bot.id),
        tool_permission: config.toolPermission,
      });
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

const activeDeliveries = new Map();

function responseDeliveryId(userId, chatId, updateId, stage = "assistant") {
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    throw new Error("Telegram response delivery requires a durable update id");
  }
  if (typeof stage !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(stage)) {
    throw new Error("Telegram response delivery stage is invalid");
  }
  return createHash("sha256")
    .update("antigravity-ha/telegram-response/v2\0")
    .update(String(userId))
    .update("\0")
    .update(String(chatId))
    .update("\0")
    .update(String(updateId))
    .update("\0")
    .update(stage)
    .digest("base64url");
}

async function drainResponseDelivery(delivery, botToken, {
  statePath,
  api = telegramApi,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  retryLimit = DELIVERY_RETRY_LIMIT,
  includeAmbiguous = false,
} = {}) {
  const stateOptions = statePath === undefined ? {} : { path: statePath };
  const deliveryId = delivery?.delivery_id;
  if (typeof deliveryId !== "string") throw new Error("Telegram delivery is invalid");
  const existingTask = activeDeliveries.get(deliveryId);
  if (existingTask) return existingTask;
  const task = (async () => {
    let current = getPendingDelivery(deliveryId, botToken, stateOptions);
    if (current === null) return { status: "delivered" };
    const currentSession = getSession(current.user_id, current.chat_id, stateOptions);
    if (currentSession?.generation !== current.generation) {
      discardResponseDelivery(deliveryId, stateOptions);
      audit("delivery_superseded", { delivery: opaqueId(deliveryId) });
      return { status: "superseded" };
    }
    if (current.status === "ambiguous" && !includeAmbiguous) {
      return { status: "ambiguous", next_chunk_index: current.next_chunk_index };
    }
    if (current.status === "attempting") {
      return { status: "ambiguous", next_chunk_index: current.next_chunk_index };
    }
    if (includeAmbiguous) {
      resetDeliveryForRetry(
        deliveryId,
        current.user_id,
        current.chat_id,
        current.generation,
        stateOptions,
      );
      current = getPendingDelivery(deliveryId, botToken, stateOptions);
    }
    while (current !== null) {
      const chunkIndex = current.next_chunk_index;
      if (current.attempt_count >= retryLimit) {
        return { status: "pending", next_chunk_index: chunkIndex };
      }
      markDeliveryAttempting(deliveryId, chunkIndex, stateOptions);
      try {
        await api(botToken, "sendMessage", {
          chat_id: current.chat_id,
          text: current.chunks[chunkIndex],
          reply_markup: chunkIndex === current.chunks.length - 1
            ? current.reply_markup ?? undefined
            : undefined,
        });
      } catch (error) {
        const errorClass = classifyApiError(error);
        if (["5xx", "network", "timeout"].includes(errorClass)) {
          markDeliveryAmbiguous(deliveryId, chunkIndex, stateOptions);
          audit("delivery_pending", {
            delivery: opaqueId(deliveryId),
            reason_class: "ambiguous_transport",
          });
          return { status: "ambiguous", next_chunk_index: chunkIndex };
        }
        const pending = markDeliveryPending(deliveryId, chunkIndex, stateOptions);
        const retryable = error?.status === 429;
        if (!retryable || pending.attempt_count >= retryLimit) {
          audit("delivery_pending", {
            delivery: opaqueId(deliveryId),
            reason_class: retryable ? "retry_exhausted" : "permanent_api_error",
          });
          return { status: "pending", next_chunk_index: chunkIndex };
        }
        const retryAfter = Number.isSafeInteger(error.retryAfter)
          ? Math.min(Math.max(error.retryAfter, 1), 60) * 1_000
          : Math.min(8_000, 1_000 * (2 ** (pending.attempt_count - 1)));
        await wait(retryAfter);
        current = getPendingDelivery(deliveryId, botToken, stateOptions);
        continue;
      }
      const acknowledged = acknowledgeDeliveryChunk(deliveryId, chunkIndex, stateOptions);
      if (acknowledged.completed) {
        audit("delivery_acknowledged", { delivery: opaqueId(deliveryId) });
        return { status: "delivered" };
      }
      current = getPendingDelivery(deliveryId, botToken, stateOptions);
    }
    return { status: "delivered" };
  })();
  activeDeliveries.set(deliveryId, task);
  try {
    return await task;
  } finally {
    if (activeDeliveries.get(deliveryId) === task) activeDeliveries.delete(deliveryId);
  }
}

async function drainPendingResponseDeliveries(config, options = {}) {
  const stateOptions = options.statePath === undefined ? {} : { path: options.statePath };
  const pending = listPendingDeliveries(config.botToken, stateOptions);
  const results = [];
  for (const delivery of pending) {
    const session = getSession(delivery.user_id, delivery.chat_id, stateOptions);
    if (session?.generation !== delivery.generation) {
      discardResponseDelivery(delivery.delivery_id, stateOptions);
      results.push({ status: "superseded" });
      continue;
    }
    if (delivery.status !== "pending") {
      results.push({
        status: delivery.status === "attempting" ? "ambiguous" : delivery.status,
        next_chunk_index: delivery.next_chunk_index,
      });
      continue;
    }
    results.push(await drainResponseDelivery(delivery, config.botToken, options));
  }
  return results;
}

function textDeliveryRecord({
  userId,
  chatId,
  updateId,
  generation,
  stage,
  text,
  replyMarkup = null,
}) {
  return {
    delivery_id: responseDeliveryId(userId, chatId, updateId, stage),
    update_id: updateId,
    user_id: userId,
    chat_id: chatId,
    generation,
    stage,
    chunks: chunkText(text),
    reply_markup: replyMarkup,
  };
}

function queueTextDelivery(config, delivery) {
  const stateOptions = delivery.statePath === undefined ? {} : { path: delivery.statePath };
  return queueResponseDelivery(textDeliveryRecord(delivery), config.botToken, stateOptions);
}

function buildAgyArgs(_mode = null, _sandboxEnabled = null, conversationId = null) {
  const args = [
    "--output-format",
    "stream-json",
    "--print-timeout",
    "5m",
  ];
  if (conversationId !== null) {
    if (typeof conversationId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(conversationId)) {
      throw new Error("stored Antigravity conversation id is invalid");
    }
    args.push("--conversation", conversationId);
  }
  // The Home Assistant App cannot grant Antigravity's nested namespace
  // sandbox without privileged container capabilities.  Every native channel
  // instead uses the AppArmor command-child boundary applied by the shared
  // launcher; never add a native sandbox override here.
  return args;
}

function streamFailure(reasonClass) {
  return new AntigravityWorkerError(reasonClass);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function proposalReceiptFromStepUpdate(stepUpdate) {
  if (!isPlainObject(stepUpdate) || stepUpdate.step_type !== "tool" ||
      !isPlainObject(stepUpdate.tool_info)) {
    return null;
  }
  const parameters = stepUpdate.tool_info.parameters;
  if (!isPlainObject(parameters) || parameters.ServerName !== "ha_change" ||
      parameters.ToolName !== "ha_change_propose") {
    return null;
  }
  if (stepUpdate.tool_name !== "call_mcp_tool" ||
      stepUpdate.tool_info.name !== "call_mcp_tool" ||
      JSON.stringify(Object.keys(parameters).sort()) !==
      JSON.stringify(["Arguments", "ServerName", "ToolName"]) ||
      !isPlainObject(parameters.Arguments) || !Number.isSafeInteger(stepUpdate.step_index) ||
      stepUpdate.step_index < 0 || !["ACTIVE", "DONE", "ERROR"].includes(stepUpdate.state)) {
    throw streamFailure("proposal_result_invalid");
  }
  if (stepUpdate.state !== "DONE") {
    return { proposalId: null, stepIndex: stepUpdate.step_index };
  }
  if (typeof stepUpdate.tool_info.output !== "string" ||
      Buffer.byteLength(stepUpdate.tool_info.output) > MAX_STREAM_LINE_BYTES) {
    throw streamFailure("proposal_result_invalid");
  }
  let output;
  try {
    output = JSON.parse(stepUpdate.tool_info.output);
  } catch {
    throw streamFailure("proposal_result_invalid");
  }
  if (!isPlainObject(output) || typeof output.proposal_id !== "string" ||
      !/^[A-Za-z0-9_-]{20,64}$/u.test(output.proposal_id)) {
    throw streamFailure("proposal_result_invalid");
  }
  return { proposalId: output.proposal_id, stepIndex: stepUpdate.step_index };
}

function decodeStreamUtf8(stdout) {
  if (typeof stdout === "string") return stdout;
  if (!Buffer.isBuffer(stdout) && !(stdout instanceof Uint8Array)) {
    throw streamFailure("stream_contract_failed");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    throw streamFailure("stream_contract_failed");
  }
}

function parseStreamResult(stream) {
  const stdout = decodeStreamUtf8(stream);
  let response = null;
  let resultEvents = 0;
  let initEvents = 0;
  let terminalSeen = false;
  let conversationId = null;
  const proposalIds = [];
  const proposalCallSteps = new Set();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_STREAM_LINE_BYTES) {
      throw streamFailure("stream_contract_failed");
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw streamFailure("stream_contract_failed");
    }
    if (terminalSeen) {
      throw streamFailure("stream_contract_failed");
    }
    if (typeof event?.event !== "string" || event.event.length === 0) {
      throw streamFailure("stream_contract_failed");
    }
    const knownEventType = /^(?:init|step_update|result)$/u.test(event.event);
    if (!knownEventType) {
      if (initEvents !== 1) {
        throw streamFailure("stream_contract_failed");
      }
      incrementBounded(metricState.streamEventsIgnored, "unknown_type");
      continue;
    }
    if (event?.event === "init") {
      initEvents += 1;
      if (initEvents !== 1) {
        throw streamFailure("stream_contract_failed");
      }
      const candidate = event.conversation_id ?? event.conversationId;
      if (typeof candidate !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(candidate)) {
        throw streamFailure("stream_contract_failed");
      }
      conversationId = candidate;
    }
    if (event?.event === "result") {
      if (initEvents !== 1) {
        throw streamFailure("stream_contract_failed");
      }
      if (typeof event.result !== "object" || event.result === null ||
          Array.isArray(event.result)) {
        throw streamFailure("stream_contract_failed");
      }
      if (event.result.status !== "SUCCESS") {
        throw streamFailure("terminal_status_failed");
      }
      if (event.result.conversation_id !== conversationId) {
        throw streamFailure("conversation_mismatch");
      }
      if (typeof event.result.response !== "string") {
        throw streamFailure("terminal_response_invalid");
      }
      terminalSeen = true;
      resultEvents += 1;
      response = event.result.response.replace(/\u0000/gu, "");
    } else if (event?.event === "step_update") {
      if (initEvents !== 1) throw streamFailure("stream_contract_failed");
      const receipt = proposalReceiptFromStepUpdate(event.step_update);
      if (receipt !== null) {
        proposalCallSteps.add(receipt.stepIndex);
        if (receipt.proposalId !== null) proposalIds.push(receipt.proposalId);
      }
    }
  }
  if (initEvents !== 1 || resultEvents !== 1 || response === null) {
    throw streamFailure("terminal_missing");
  }
  if (response.trim().length === 0 || Buffer.byteLength(response) > MAX_RESULT_BYTES) {
    throw streamFailure("terminal_response_invalid");
  }
  if (proposalIds.length > 1 || proposalIds.length !== proposalCallSteps.size) {
    throw streamFailure("proposal_result_invalid");
  }
  return {
    response,
    proposalIds,
    conversationId,
  };
}

function parseInitEventLine(line, expectedConversationId = null) {
  const decoded = decodeStreamUtf8(line);
  let event;
  try {
    event = JSON.parse(decoded);
  } catch {
    throw streamFailure("stream_contract_failed");
  }
  if (event?.event !== "init") {
    throw streamFailure("stream_contract_failed");
  }
  const conversationId = event.conversation_id ?? event.conversationId;
  if (typeof conversationId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(conversationId)) {
    throw streamFailure("stream_contract_failed");
  }
  if (expectedConversationId !== null && conversationId !== expectedConversationId) {
    throw streamFailure("conversation_mismatch");
  }
  return conversationId;
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
  mode = null,
  sandboxEnabled = null,
  binary = DEFAULT_AGY_BIN,
  prefixArgs = [],
  timeoutMs = RUN_TIMEOUT_MS,
  hardKillGraceMs = 10_000,
  cwd = SHARED_ANTIGRAVITY_WORKSPACE,
  runId = randomBytes(8).toString("hex"),
  requester = null,
  conversationId = null,
  onConversation = null,
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
      HOME: SHARED_ANTIGRAVITY_HOME,
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
      childEnvironment.ANTIGRAVITY_HA_CHANNEL = "telegram";
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
    let initProbe = Buffer.alloc(0);
    let initConversationId = null;
    let initError = null;
    const authRequiredMatcher = new BoundedByteMatcher(ANTIGRAVITY_AUTH_REQUIRED_MARKER);
    const headlessPermissionMatcher = new BoundedByteMatcher(
      ANTIGRAVITY_HEADLESS_PERMISSION_MARKER,
    );
    child.stderr.on("data", (chunk) => {
      authRequiredMatcher.push(chunk);
      headlessPermissionMatcher.push(chunk);
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
      if (initConversationId === null && initError === null) {
        initProbe = Buffer.concat([initProbe, bytes]);
        while (initConversationId === null && initError === null) {
          const newline = initProbe.indexOf(0x0a);
          if (newline < 0) break;
          const line = initProbe.subarray(0, newline);
          initProbe = initProbe.subarray(newline + 1);
          if (line.toString("utf8").trim().length === 0) continue;
          try {
            initConversationId = parseInitEventLine(line, conversationId);
            if (onConversation !== null) {
              if (typeof onConversation !== "function") {
                throw new Error("conversation binding callback is invalid");
              }
              const callbackResult = onConversation(initConversationId);
              if (callbackResult && typeof callbackResult.then === "function") {
                throw new Error("conversation binding callback must be synchronous");
              }
            }
          } catch (error) {
            initError = error;
            terminateChildWithGrace(child, hardKillGraceMs);
            break;
          }
        }
      }
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
    if (initError !== null) {
      workerRuntimeStatus = requestFailureReason(initError);
      throw initError;
    }
    if (oversized) {
      workerRuntimeStatus = "stream_contract_failed";
      throw streamFailure("stream_contract_failed");
    }
    if (timedOut) {
      workerRuntimeStatus = "worker_failed";
      throw new Error("Antigravity request timed out");
    }
    if (code !== 0) {
      const reasonClass = code === 1 && authRequiredMatcher.matched
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
      workerRuntimeStatus = requestFailureReason(error);
      throw error;
    }
    if (initConversationId === null) {
      initConversationId = parsed.conversationId;
      if (conversationId !== null && initConversationId !== conversationId) {
        workerRuntimeStatus = "conversation_mismatch";
        throw streamFailure("conversation_mismatch");
      }
      if (onConversation !== null) onConversation(initConversationId);
    }
    if (parsed.conversationId !== initConversationId) {
      workerRuntimeStatus = "conversation_mismatch";
      throw streamFailure("conversation_mismatch");
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

class ApprovalSessionChangedError extends Error {
  constructor() {
    super("Telegram approval no longer matches the active session");
    this.name = "ApprovalSessionChangedError";
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

function cancelRequesterWork(userId, chatId, {
  hardKillGraceMs = 10_000,
  botToken = null,
  statePath,
} = {}) {
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
        approval.requester.chat_id === String(chatId) &&
        (approval.approvedUpdateId === null || approval.approvedUpdateId === undefined)) {
      deleteApprovalRecord(approvalId, approval, { botToken, statePath });
      recordApproval("cancelled", approval.proposal.risk);
      result.approvals_cancelled += 1;
    }
  }
  if (botToken !== null) {
    const stateOptions = statePath === undefined ? {} : { path: statePath };
    const session = getSession(userId, chatId, stateOptions);
    if (session !== null) {
      result.approvals_cancelled += deletePendingApprovalsForSession(
        userId,
        chatId,
        session.generation,
        botToken,
        { ...stateOptions, includeApproved: false },
      );
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

function deleteApprovalRecord(id, request, { botToken = null, statePath } = {}) {
  if (request?.timer) clearTimeout(request.timer);
  pendingApprovals.delete(id);
  if (botToken !== null) {
    const stateOptions = statePath === undefined ? {} : { path: statePath };
    deletePendingApproval(id, stateOptions);
  }
}

function approvalFromDurable(record) {
  if (record === null) return null;
  return {
    requester: {
      surface: "telegram",
      user_id: record.user_id,
      chat_id: record.chat_id,
    },
    proposal: {
      proposal_id: record.proposal_id,
      preview_digest: record.preview_digest,
      risk: record.risk,
    },
    idempotencyKey: record.idempotency_key,
    expiresAt: record.expires_at,
    generation: record.generation,
    conversationId: record.conversation_id,
    approvedUpdateId: record.approved_update_id,
    timer: null,
  };
}

function assertApprovalRunBinding(id, request, botToken, stateOptions) {
  const session = getSession(
    request.requester.user_id,
    request.requester.chat_id,
    stateOptions,
  );
  const durable = getPendingApproval(id, botToken, stateOptions);
  if (!session || !durable ||
      session.generation !== request.generation ||
      session.conversation_id !== request.conversationId ||
      durable.user_id !== request.requester.user_id ||
      durable.chat_id !== request.requester.chat_id ||
      durable.generation !== request.generation ||
      durable.conversation_id !== request.conversationId ||
      durable.proposal_id !== request.proposal.proposal_id ||
      durable.preview_digest !== request.proposal.preview_digest ||
      durable.idempotency_key !== request.idempotencyKey ||
      durable.approved_update_id !== request.approvedUpdateId) {
    throw new ApprovalSessionChangedError();
  }
  return session;
}

function cancelApprovedRequestBeforeExecution(id, request, config, {
  statePath,
  acknowledgeInput,
} = {}) {
  deleteApprovalRecord(id, request, {
    botToken: config.botToken,
    statePath,
  });
  recordApproval("cancelled", request.proposal.risk);
  audit("approval_cancelled_before_execution", {
    chat: opaqueId(request.requester.chat_id),
    user: opaqueId(request.requester.user_id),
    risk: request.proposal.risk,
  });
  if (typeof acknowledgeInput === "function") acknowledgeInput();
}

function createApproval({ requester, proposal, idempotencyKey, session }, {
  botToken,
  statePath,
} = {}) {
  if (!session || session.conversation_id === null ||
      session.user_id !== requester.user_id || session.chat_id !== requester.chat_id ||
      !Number.isSafeInteger(session.generation) || session.generation < 1 ||
      typeof botToken !== "string") {
    throw new Error("approval requires a durable bound Telegram session");
  }
  const stateOptions = statePath === undefined ? {} : { path: statePath };
  const existingApprovals = [...pendingApprovals].filter(([, existing]) =>
    existing.requester.chat_id === requester.chat_id &&
    existing.requester.user_id === requester.user_id,
  );
  if (existingApprovals.some(([, existing]) => existing.approvedUpdateId !== null) ||
      listPendingApprovals(botToken, stateOptions).some((existing) =>
        existing.user_id === requester.user_id && existing.chat_id === requester.chat_id &&
        existing.generation === session.generation && existing.approved_update_id !== null)) {
    throw new Error("approved Telegram change is still in progress");
  }
  for (const [existingId, existing] of existingApprovals) {
    deleteApprovalRecord(existingId, existing, { botToken, statePath });
    recordApproval("cancelled", existing.proposal.risk);
  }
  deletePendingApprovalsForSession(
    requester.user_id,
    requester.chat_id,
    session.generation,
    botToken,
    { ...stateOptions, includeApproved: false },
  );
  const id = randomBytes(16).toString("base64url");
  const expiresAt = Date.now() + APPROVAL_TTL_MS;
  const timer = setTimeout(() => {
    const expired = pendingApprovals.get(id);
    if (expired) {
      deleteApprovalRecord(id, expired, { botToken, statePath });
      recordApproval("expired", proposal.risk);
    }
  }, APPROVAL_TTL_MS);
  timer.unref();
  pendingApprovals.set(id, {
    requester: { ...requester },
    proposal: { ...proposal },
    idempotencyKey,
    expiresAt,
    generation: session.generation,
    conversationId: session.conversation_id,
    approvedUpdateId: null,
    timer,
  });
  try {
    savePendingApproval({
      approval_id: id,
      user_id: requester.user_id,
      chat_id: requester.chat_id,
      generation: session.generation,
      conversation_id: session.conversation_id,
      proposal_id: proposal.proposal_id,
      preview_digest: proposal.preview_digest,
      risk: proposal.risk,
      idempotency_key: idempotencyKey,
      expires_at: expiresAt,
      approved_update_id: null,
    }, botToken, stateOptions);
  } catch (error) {
    deleteApprovalRecord(id, pendingApprovals.get(id), { botToken, statePath });
    throw error;
  }
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

async function sendExecutionResult(botToken, chatId, result, durable) {
  try {
    if (!durable || !Number.isSafeInteger(durable.updateId) || durable.updateId < 0 ||
        !Number.isSafeInteger(durable.generation) || durable.generation < 1 ||
        typeof durable.userId !== "string") {
      throw new Error("execution result requires a durable Telegram delivery binding");
    }
    const queued = queueTextDelivery({ botToken }, {
      userId: durable.userId,
      chatId,
      updateId: durable.updateId,
      generation: durable.generation,
      stage: durable.stage ?? "execution",
      text: renderExecutionResult(result),
      statePath: durable.statePath,
    });
    durable.onQueued?.(queued);
    return await drainResponseDelivery(queued, botToken, {
      statePath: durable.statePath,
      api: durable.api ?? telegramApi,
    });
  } catch {
    throw new ExecutionResultDeliveryError();
  }
}

function proposalDisposition(toolPermission, risk) {
  if (!TOOL_PERMISSIONS.has(toolPermission) || !["low", "high"].includes(risk)) {
    throw new Error("proposal disposition input is invalid");
  }
  // Antigravity's native permission prompt is not a resumable headless
  // protocol and therefore cannot be translated into a Telegram callback.
  // Shared runtime permissions must let the model reach ha_change_propose;
  // this broker boundary is where a durable Telegram approval can safely
  // bind preview digest, requester, session, and exactly-once execution.
  if (toolPermission === "always-proceed" && risk === "low") return "autonomous_policy";
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

async function processPrompt(config, message, ticket = null, {
  statePath,
  runPrompt = runAntigravityPrompt,
  executionLookup = lookupExecution,
  proposalInspect = inspectProposal,
  proposalExecute = executeProposal,
  approvalCreate = createApproval,
  terminalLoad = getTerminalTurn,
  terminalSave = saveTerminalTurn,
  terminalFinalize = finalizeTerminalTurn,
  terminalDelete = deleteTerminalTurn,
  api = telegramApi,
  acknowledgeInput = null,
} = {}) {
  const chatId = String(message.chat.id);
  const userId = String(message.from.id);
  const requester = { surface: "telegram", user_id: userId, chat_id: chatId };
  const prompt = message.text.trim();
  const correlation = opaqueId(`${userId}:${chatId}:${message.updateId ?? "local"}`);
  const idempotencyKey = `tg:${userId}:${chatId}:${message.updateId ?? randomBytes(8).toString("hex")}`;
  const stateOptions = statePath === undefined ? {} : { path: statePath };
  audit("request_accepted", {
    chat: opaqueId(chatId),
    user: opaqueId(userId),
    correlation,
    bytes: Buffer.byteLength(prompt),
  });
  const session = ensureSession(userId, chatId, stateOptions);
  audit("session_ready", {
    chat: opaqueId(chatId),
    generation: session.generation,
    conversation_reused: session.conversation_id !== null,
  });
  const deliveryId = responseDeliveryId(userId, chatId, message.updateId, "assistant");
  const terminalId = responseDeliveryId(userId, chatId, message.updateId, "terminal");
  const turnDeliveries = listPendingDeliveries(config.botToken, stateOptions)
    .filter((candidate) => candidate.update_id === message.updateId &&
      candidate.user_id === userId && candidate.chat_id === chatId &&
      candidate.generation === session.generation)
    .sort((left, right) => (left.stage === "assistant" ? -1 : 0) -
      (right.stage === "assistant" ? -1 : 0));
  if (turnDeliveries.length > 0) {
    // An atomic finalize may have committed the outbox before the process died.
    // Never retain or replay a terminal journal once any delivery for that turn exists.
    terminalDelete(terminalId, stateOptions);
    if (typeof acknowledgeInput === "function") acknowledgeInput();
    audit("delivery_recovered", { delivery: opaqueId(deliveryId) });
    const results = [];
    for (const turnDelivery of turnDeliveries) {
      results.push(await drainResponseDelivery(turnDelivery, config.botToken, {
        statePath,
        api,
      }));
    }
    return results;
  }
  const cancellationSignal = ticket?.cancellationController.signal ?? null;
  let boundSession = session;
  let workerResult;
  const terminal = terminalLoad(terminalId, config.botToken, stateOptions);
  const recoveredTerminal = terminal !== null;
  if (recoveredTerminal) {
    if (terminal.update_id !== message.updateId || terminal.user_id !== userId ||
        terminal.chat_id !== chatId || terminal.generation !== session.generation ||
        terminal.conversation_id !== session.conversation_id) {
      throw new Error("stale Telegram terminal turn replay binding");
    }
    workerResult = {
      response: terminal.response,
      proposalIds: terminal.proposal_id === null ? [] : [terminal.proposal_id],
      conversationId: terminal.conversation_id,
    };
    audit("terminal_recovered", {
      chat: opaqueId(chatId),
      generation: session.generation,
      has_proposal: terminal.proposal_id !== null,
    });
  } else {
    setJobPhase(ticket, "planning");
    assertJobActive(ticket);
    await api(config.botToken, "sendChatAction", {
      chat_id: chatId,
      action: "typing",
    }).catch(() => {});
    assertJobActive(ticket);
    workerResult = await runPrompt(prompt, {
      runId: `${requesterKey(userId, chatId)}:${randomBytes(8).toString("hex")}`,
      requester,
      conversationId: session.conversation_id,
      onConversation: (conversationId) => {
        boundSession = bindSessionConversation(
          userId,
          chatId,
          session.generation,
          conversationId,
          stateOptions,
        );
        audit("session_bound", {
          chat: opaqueId(chatId),
          generation: boundSession.generation,
          conversation_reused: session.conversation_id !== null,
        });
      },
      signal: cancellationSignal,
    });
    assertJobActive(ticket);
    if (boundSession.conversation_id === null) {
      boundSession = bindSessionConversation(
        userId,
        chatId,
        session.generation,
        workerResult.conversationId,
        stateOptions,
      );
    }
    if (workerResult.conversationId !== boundSession.conversation_id) {
      throw new Error("Antigravity result did not match the durable session binding");
    }
    terminalSave({
      turn_id: terminalId,
      update_id: message.updateId,
      user_id: userId,
      chat_id: chatId,
      generation: boundSession.generation,
      conversation_id: boundSession.conversation_id,
      response: workerResult.response,
      proposal_id: workerResult.proposalIds[0] ?? null,
    }, config.botToken, stateOptions);
    audit("terminal_journaled", {
      chat: opaqueId(chatId),
      generation: boundSession.generation,
      has_proposal: workerResult.proposalIds.length > 0,
    });
  }
  audit("terminal_valid", { chat: opaqueId(chatId), generation: boundSession.generation });
  const assistantDelivery = {
    userId,
    chatId,
    updateId: message.updateId,
    generation: boundSession.generation,
    stage: "assistant",
    text: workerResult.response,
  };
  if (workerResult.proposalIds.length === 0) {
    const [queued] = terminalFinalize(
      terminalId,
      [textDeliveryRecord(assistantDelivery)],
      config.botToken,
      stateOptions,
    );
    audit("delivery_queued", {
      delivery: opaqueId(deliveryId),
      chunks: queued.chunks.length,
    });
    if (typeof acknowledgeInput === "function") acknowledgeInput();
    await drainResponseDelivery(queued, config.botToken, { statePath, api });
    return;
  }

  if (recoveredTerminal) {
    setJobPhase(ticket, "recovery_lookup");
    const recoveredExecution = await executionLookup(requester, idempotencyKey, {
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
      const [queued, executionDelivery] = terminalFinalize(
        terminalId,
        [
          textDeliveryRecord(assistantDelivery),
          textDeliveryRecord({
            userId,
            chatId,
            updateId: message.updateId,
            generation: boundSession.generation,
            stage: "execution",
            text: renderExecutionResult(recoveredExecution),
          }),
        ],
        config.botToken,
        stateOptions,
      );
      if (typeof acknowledgeInput === "function") acknowledgeInput();
      await drainResponseDelivery(queued, config.botToken, { statePath, api });
      await drainResponseDelivery(executionDelivery, config.botToken, { statePath, api });
      return;
    }
  }

  const proposal = await proposalInspect(workerResult.proposalIds[0], requester);
  assertJobActive(ticket);
  const disposition = proposalDisposition(config.toolPermission, proposal.risk);

  if (disposition === "autonomous_policy") {
    recordApproval("autonomous", proposal.risk);
    const result = await proposalExecute(proposal, requester, "autonomous_policy", idempotencyKey, {
      assertActive: () => assertJobActive(ticket),
      setPhase: (phase) => setJobPhase(ticket, phase),
      signal: cancellationSignal,
    });
    const [queued, executionDelivery] = terminalFinalize(
      terminalId,
      [
        textDeliveryRecord(assistantDelivery),
        textDeliveryRecord({
          userId,
          chatId,
          updateId: message.updateId,
          generation: boundSession.generation,
          stage: "execution",
          text: renderExecutionResult(result),
        }),
      ],
      config.botToken,
      stateOptions,
    );
    if (typeof acknowledgeInput === "function") acknowledgeInput();
    await drainResponseDelivery(queued, config.botToken, { statePath, api });
    await drainResponseDelivery(executionDelivery, config.botToken, { statePath, api });
    return;
  }

  setJobPhase(ticket, "proposal");
  const approval = approvalCreate({
    requester,
    proposal,
    idempotencyKey,
    session: boundSession,
  }, { botToken: config.botToken, statePath });
  const [queued, approvalDelivery] = terminalFinalize(
    terminalId,
    [
      textDeliveryRecord(assistantDelivery),
      textDeliveryRecord({
        userId,
        chatId,
        updateId: message.updateId,
        generation: boundSession.generation,
        stage: "approval",
        text: `${renderProposal(proposal)}\n\n이 변경을 실행할까요?`,
        replyMarkup: {
          inline_keyboard: [[
            { text: "실행", callback_data: `v2a:${approval.id}` },
            { text: "취소", callback_data: `v2d:${approval.id}` },
          ]],
        },
      }),
    ],
    config.botToken,
    stateOptions,
  );
  if (typeof acknowledgeInput === "function") acknowledgeInput();
  await drainResponseDelivery(queued, config.botToken, { statePath, api });
  await drainResponseDelivery(approvalDelivery, config.botToken, { statePath, api });
}

async function handleCallback(config, callback, {
  statePath,
  api = telegramApi,
  afterApprovalTransition = () => {},
  acknowledgeInput = null,
} = {}) {
  const callbackId = callback.id;
  const match = /^(v2a|v2d):([A-Za-z0-9_-]{16,64})$/.exec(callback.data ?? "");
  const stateOptions = statePath === undefined ? {} : { path: statePath };
  let request = match ? pendingApprovals.get(match[2]) : undefined;
  if (!request && match) {
    request = approvalFromDurable(
      getPendingApproval(match[2], config.botToken, stateOptions),
    ) ?? undefined;
  }
  const chatId = String(callback.message?.chat?.id ?? "");
  const userId = String(callback.from?.id ?? "");
  if (match && (!Number.isSafeInteger(callback.updateId) || callback.updateId < 0)) {
    recordDenial("invalid_request");
    await api(config.botToken, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "내구성 전달 식별자가 없는 승인 요청입니다.",
      show_alert: true,
    });
    return;
  }
  const durableApprovalUpdateId = request?.approvedUpdateId ?? callback.updateId;
  const callbackIdempotencyKey = Number.isSafeInteger(durableApprovalUpdateId)
    ? `tgcb:${userId}:${chatId}:${durableApprovalUpdateId}`
    : request?.idempotencyKey ?? null;
  if (!request && match?.[1] === "v2a" && callbackIdempotencyKey !== null) {
    const requester = { surface: "telegram", user_id: userId, chat_id: chatId };
    const recoveredExecution = await lookupExecution(requester, callbackIdempotencyKey)
      .catch((error) => {
        if (error instanceof BrokerError && error.code === "execution_not_found") return null;
        throw error;
      });
    if (recoveredExecution !== null) {
      await api(config.botToken, "answerCallbackQuery", {
        callback_query_id: callbackId,
        text: "기존 실행 결과를 확인했습니다.",
      });
      const recoveredSession = ensureSession(userId, chatId, stateOptions);
      const durable = {
        userId,
        updateId: durableApprovalUpdateId,
        generation: recoveredSession.generation,
        statePath,
        api,
        onQueued: () => {
          if (typeof acknowledgeInput === "function") acknowledgeInput();
        },
      };
      await sendExecutionResult(config.botToken, chatId, recoveredExecution, durable);
      return;
    }
  }
  if (!request || (request.approvedUpdateId === null && request.expiresAt < Date.now())) {
    if (!request) recordDenial(match ? "expired" : "invalid_request");
    if (request?.approvedUpdateId === null && request?.expiresAt < Date.now()) {
      deleteApprovalRecord(match[2], request, {
        botToken: config.botToken,
        statePath,
      });
      recordDenial("expired");
      recordApproval("expired", request.proposal.risk);
    }
    await api(config.botToken, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "승인 요청이 만료되었거나 요청자와 일치하지 않습니다.",
      show_alert: true,
    });
    return;
  }
  const currentSession = getSession(userId, chatId, stateOptions);
  const staleSession = (
    currentSession?.generation !== request.generation ||
    currentSession?.conversation_id !== request.conversationId
  );
  if (request.requester.chat_id !== chatId || request.requester.user_id !== userId ||
      staleSession) {
    if (staleSession && request.requester.chat_id === chatId &&
        request.requester.user_id === userId) {
      deleteApprovalRecord(match[2], request, {
        botToken: config.botToken,
        statePath,
      });
    }
    recordDenial("requester_mismatch");
    recordApproval("denied", request.proposal.risk);
    await api(config.botToken, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "승인 요청이 만료되었거나 요청자와 일치하지 않습니다.",
      show_alert: true,
    });
    return;
  }
  if (request.approvedUpdateId !== null &&
      request.approvedUpdateId !== callback.updateId) {
    await api(config.botToken, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "이미 처리 중인 승인 요청입니다.",
    });
    if (typeof acknowledgeInput === "function") acknowledgeInput();
    return;
  }
  if (match[1] === "v2d") {
    deleteApprovalRecord(match[2], request, {
      botToken: config.botToken,
      statePath,
    });
    recordApproval("cancelled", request.proposal.risk);
    await api(config.botToken, "answerCallbackQuery", { callback_query_id: callbackId, text: "취소했습니다." });
    return;
  }
  const approvedRecord = markPendingApprovalApproved(
    match[2],
    durableApprovalUpdateId,
    config.botToken,
    stateOptions,
  );
  if (request.timer) clearTimeout(request.timer);
  request = {
    ...request,
    approvedUpdateId: approvedRecord.approved_update_id,
    timer: null,
  };
  pendingApprovals.set(match[2], request);
  afterApprovalTransition({
    approvalId: match[2],
    updateId: request.approvedUpdateId,
  });
  recordApproval("confirmed", request.proposal.risk);
  audit("approval_consumed", {
    chat: opaqueId(chatId),
    user: opaqueId(userId),
    risk: request.proposal.risk,
  });
  const approvedRun = enqueueRequester(userId, chatId, async (ticket) => {
    let completion = "success";
    let executionSession = currentSession;
    try {
      assertJobActive(ticket);
      // The callback is authenticated before it enters the per-requester queue,
      // but /new can be queued ahead of it. Revalidate the encrypted approval
      // and session binding at the execution boundary so an old button can
      // never authorize work in a replacement Antigravity conversation.
      executionSession = assertApprovalRunBinding(
        match[2],
        request,
        config.botToken,
        stateOptions,
      );
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
      const durable = {
        userId,
        updateId: durableApprovalUpdateId,
        generation: executionSession.generation,
        statePath,
        api,
        onQueued: () => {
          deleteApprovalRecord(match[2], request, {
            botToken: config.botToken,
            statePath,
          });
          if (typeof acknowledgeInput === "function") acknowledgeInput();
        },
      };
      await sendExecutionResult(config.botToken, chatId, result, durable);
    } catch (error) {
      completion = ticket.cancelled ? "cancelled" : jobResultClass(error);
      if (error instanceof RequestCancelledError || ticket.cancelled) {
        cancelApprovedRequestBeforeExecution(match[2], request, config, {
          statePath,
          acknowledgeInput,
        });
        return;
      }
      if (error instanceof ApprovalSessionChangedError) {
        completion = "cancelled";
        deleteApprovalRecord(match[2], request, {
          botToken: config.botToken,
          statePath,
        });
        recordApproval("denied", request.proposal.risk);
        audit("approval_session_changed", {
          chat: opaqueId(chatId),
          user: opaqueId(userId),
          risk: request.proposal.risk,
        });
        const activeSession = ensureSession(userId, chatId, stateOptions);
        const staleDelivery = queueTextDelivery(config, {
          userId,
          chatId,
          updateId: durableApprovalUpdateId,
          generation: activeSession.generation,
          stage: "approval_stale",
          text: "대화 또는 승인 상태가 변경되어 이전 승인 요청을 실행하지 않았습니다.",
          statePath,
        });
        if (typeof acknowledgeInput === "function") acknowledgeInput();
        await drainResponseDelivery(staleDelivery, config.botToken, { statePath, api });
        return;
      }
      if (error instanceof ExecutionResultDeliveryError) throw error;
      audit("approved_run_failed", { chat: opaqueId(chatId), error: safeError(error) });
      const failureDelivery = queueTextDelivery(config, {
        userId,
        chatId,
        updateId: durableApprovalUpdateId,
        generation: request.generation,
        stage: "error",
        text: "승인된 작업을 완료하지 못했습니다. App 로그를 확인하세요.",
        statePath,
      });
      deleteApprovalRecord(match[2], request, {
        botToken: config.botToken,
        statePath,
      });
      if (typeof acknowledgeInput === "function") acknowledgeInput();
      await drainResponseDelivery(failureDelivery, config.botToken, { statePath, api });
    } finally {
      incrementBounded(metricState.jobsCompleted, completion);
    }
  });
  const settledApprovedRun = approvedRun.catch((error) => {
    // A queued ticket is rejected by enqueueRequester before its task callback
    // starts. Clean up the durable approved record here as well; otherwise a
    // /cancel issued while another turn is running can leave the requester
    // permanently blocked by an approval that will never execute. Attach this
    // observer before calling Telegram so cleanup also happens if the callback
    // acknowledgement itself encounters a transport error.
    if (error instanceof RequestCancelledError) {
      cancelApprovedRequestBeforeExecution(match[2], request, config, {
        statePath,
        acknowledgeInput,
      });
      return;
    }
    throw error;
  });
  void settledApprovedRun.catch(() => {});
  await api(config.botToken, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text: "승인했습니다.",
  });
  await settledApprovedRun;
}

async function handleMessage(config, message, {
  statePath,
  api = telegramApi,
  send = sendMessage,
} = {}) {
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
      await send(
        config.botToken,
        chatId,
        "Telegram 사용자 인증이 완료되었습니다. Telegram은 웹 터미널/SSH와 같은 Antigravity 로그인, 전역 플러그인, 에이전트와 규칙을 사용합니다. 로그인이 필요하면 App 웹 터미널에서 antigravity를 실행하세요. /help로 사용법을 확인할 수 있습니다.",
      );
      return;
    }
  }
  if (!authorized) {
    recordDenial("unauthorized");
    audit("authorization_denied", { chat: opaqueId(chatId), user: opaqueId(message.from?.id ?? "") });
    await send(config.botToken, chatId, "이 봇을 사용할 권한이 없습니다.");
    return;
  }
  if (startCommand || text === "/help") {
    await send(config.botToken, chatId,
      `Antigravity for Home Assistant\n전역 도구 권한: ${config.toolPermission}\n/new 명시적으로 새 대화 시작\n/status 연결, 공유 AI 런타임과 전달 상태 확인\n/retry 전송 결과가 불명확한 응답 재전송\n/cancel 현재 작업 취소\nTelegram은 웹 터미널/SSH와 같은 로그인, 전역 플러그인, 에이전트, 규칙과 /config 작업공간을 사용합니다.`);
    return;
  }
  if (text === "/status") {
    const key = requesterKey(userId, chatId);
    const stateOptions = statePath === undefined ? {} : { path: statePath };
    const session = getSession(userId, chatId, stateOptions);
    const pending = listPendingDeliveries(config.botToken, stateOptions)
      .filter((delivery) => delivery.user_id === userId && delivery.chat_id === chatId &&
        delivery.generation === session?.generation);
    await send(config.botToken, chatId,
      `Telegram transport: 연결 정상\n공유 AI 런타임 최근 상태: ${renderWorkerStatus()}\n전역 도구 권한: ${config.toolPermission}\n대화 세대/바인딩: ${session?.generation ?? 0}/${session?.conversation_id ? "유지 중" : "다음 요청에서 생성"}\n전달 대기/불명확: ${pending.filter((item) => item.status === "pending").length}/${pending.filter((item) => item.status === "ambiguous").length}\n활성/대기 작업: ${chatQueues.get(key)?.queued ?? 0}`);
    return;
  }
  if (text === "/retry") {
    const stateOptions = statePath === undefined ? {} : { path: statePath };
    const session = getSession(userId, chatId, stateOptions);
    const pending = listPendingDeliveries(config.botToken, stateOptions)
      .filter((delivery) => delivery.user_id === userId && delivery.chat_id === chatId &&
        delivery.generation === session?.generation);
    if (pending.length === 0) {
      await send(config.botToken, chatId, "재전송할 응답이 없습니다.");
      return;
    }
    for (const delivery of pending) {
      await drainResponseDelivery(delivery, config.botToken, {
        statePath,
        api,
        includeAmbiguous: true,
      });
    }
    return;
  }
  if (text === "/cancel") {
    const stateOptions = statePath === undefined ? {} : { path: statePath };
    const existing = getControlEffect(
      message.updateId,
      userId,
      chatId,
      "cancel",
      stateOptions,
    );
    if (existing !== null) {
      await send(config.botToken, chatId, existing.result);
      return;
    }
    const cancellation = cancelRequesterWork(userId, chatId, {
      botToken: config.botToken,
      statePath,
    });
    const result = renderCancellationResult(cancellation);
    saveControlEffect({
      update_id: message.updateId,
      user_id: userId,
      chat_id: chatId,
      command: "cancel",
      result,
    }, stateOptions);
    await send(config.botToken, chatId, result);
    return;
  }
  if (text === "/new") {
    const stateOptions = statePath === undefined ? {} : { path: statePath };
    const result = "새 대화를 시작했습니다. 다음 요청부터 새 Antigravity 세션을 사용합니다.";
    const existing = getControlEffect(
      message.updateId,
      userId,
      chatId,
      "new",
      stateOptions,
    );
    if (existing !== null) {
      await send(config.botToken, chatId, existing.result);
      return;
    }
    cancelRequesterWork(userId, chatId, { botToken: config.botToken, statePath });
    await enqueueRequester(userId, chatId, async () => {
      const applied = applyNewSessionControl({
        update_id: message.updateId,
        user_id: userId,
        chat_id: chatId,
        command: "new",
        result,
      }, config.botToken, stateOptions);
      audit("session_reset", {
        chat: opaqueId(chatId),
        generation: applied.session.generation,
      });
      await send(config.botToken, chatId, result);
    });
    return;
  }
  if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
    recordDenial("invalid_request");
    await send(config.botToken, chatId, `요청은 UTF-8 ${MAX_PROMPT_BYTES}바이트 이하여야 합니다.`);
    return;
  }
  await enqueueRequester(userId, chatId, async (ticket) => {
    let completion = "success";
    try {
      const stateOptions = statePath === undefined ? {} : { path: statePath };
      await processPrompt(config, { ...message, text, updateId: message.updateId }, ticket, {
        statePath,
        api,
        acknowledgeInput: () => acknowledgeUpdate(message.updateId, stateOptions),
      });
    } catch (error) {
      completion = ticket.cancelled ? "cancelled" : jobResultClass(error);
      if (error instanceof RequestCancelledError || ticket.cancelled) return;
      if (error instanceof ExecutionResultDeliveryError) throw error;
      audit("request_failed", {
        chat: opaqueId(chatId),
        reason_class: requestFailureReason(error),
      });
      await send(config.botToken, chatId, renderRequestFailure(error));
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
  statePath,
  messageHandler = handleMessage,
  callbackHandler = handleCallback,
  authorization = isAuthorized,
  api = telegramApi,
} = {}) {
  const stateOptions = statePath === undefined ? {} : { path: statePath };
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
      await callbackHandler(config, normalized.value, {
        statePath,
        api,
        acknowledgeInput: () => acknowledgeUpdate(normalized.updateId, stateOptions),
      });
      return;
    }
    if (normalized?.kind === "message") {
      await messageHandler(config, normalized.value, { statePath, api });
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
      statePath,
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
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
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
      await drainPendingResponseDeliveries(config, { statePath, api });
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
      // Let immediately-settled background handlers publish their failure before
      // the next poll iteration checks the failure ledger.
      await new Promise((resolve) => setImmediate(resolve));
      pollBackoff.reset();
    } catch (error) {
      audit("poll_failed", { error: safeError(error) });
      const authenticationSurface = ["getUpdates", "getMe", "deleteWebhook"]
        .includes(error?.telegramMethod);
      if (((error?.status === 401 || error?.status === 403) && authenticationSurface) ||
          error?.code === "ETELEGRAMSPOOL") {
        throw error;
      }
      await wait(pollBackoff.nextDelay(error));
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
  const recoveredAttempts = recoverAttemptingDeliveries();
  const approvalCleanup = cleanupPendingApprovals(config.botToken);
  if (recoveredAttempts > 0 || Object.values(approvalCleanup).some((count) => count > 0)) {
    audit("durable_state_recovered", {
      delivery_attempts_ambiguous: recoveredAttempts,
      approvals_expired: approvalCleanup.expired,
      approvals_stale: approvalCleanup.stale,
      approvals_duplicate: approvalCleanup.duplicate,
    });
  }
  await waitForTelegramAuthorization(config);
  await connectTelegram(config);
  const metricsTimer = setInterval(() => audit("metrics", metricsSnapshot()), 60_000);
  metricsTimer.unref();
  await pollUpdateBatches(config);
}

export {
  ANTIGRAVITY_AUTH_REQUIRED_MARKER,
  ANTIGRAVITY_HEADLESS_PERMISSION_MARKER,
  TOOL_PERMISSIONS,
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
  drainPendingResponseDeliveries,
  drainResponseDelivery,
  enqueueRequester,
  holdTelegramFailClosed,
  handleCallback,
  handleMessage,
  inspectProposal,
  isAuthorized,
  loadRuntimeConfig,
  lookupExecution,
  metricsSnapshot,
  normalizeUpdate,
  normalizeIds,
  pairingTokenFromMessage,
  parseStreamResult,
  processPrompt,
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
  responseDeliveryId,
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
