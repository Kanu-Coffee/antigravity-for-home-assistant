import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  HA_READ_MAX_REQUEST_BYTES,
  HA_READ_MAX_RESPONSE_BYTES,
  HA_READ_PROTOCOL_VERSION,
  HA_READ_SOCKET_PATH,
  HaReadError,
  haReadResponseLimit,
} from "./ha-read-client.mjs";
import {
  fetchHomeAssistantBrokerRead,
  fetchHomeAssistantSnapshot,
  HomeAssistantUnavailableError,
} from "./ha-memory-ha-client.mjs";
import { consumeSupervisorCredentialFromInheritedFd } from "./supervisor-credential-fd.mjs";

const CORE_API_URL = "http://supervisor/core/api";
const SUPERVISOR_API_URL = "http://supervisor";
const UPSTREAM_TIMEOUT_MS = 10_000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 500;
const MAX_LOG_LINE_BYTES = 4096;
const DEFAULT_HISTORY_HOURS = 24;
const MAX_HISTORY_HOURS = 168;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 500;
const DEFAULT_TRACE_LIMIT = 20;
const MAX_TRACE_LIMIT = 50;
const STORAGE_USAGE_CATEGORY_IDS = Object.freeze([
  "system",
  "apps_data",
  "apps_config",
  "media",
  "share",
  "backup",
  "ssl",
  "homeassistant",
]);
const STORAGE_USAGE_CATEGORY_ALIASES = new Map([
  ...STORAGE_USAGE_CATEGORY_IDS.map((id) => [id, id]),
  // Supervisor API v1 retains the pre-App terminology. Normalize it without
  // exposing any upstream label or recursive directory name.
  ["addons_data", "apps_data"],
  ["addons_config", "apps_config"],
]);
const ACTIONS = new Set([
  "app_logs",
  "config",
  "core_info",
  "core_logs",
  "history",
  "memory_snapshot",
  "registry",
  "services",
  "state",
  "states",
  "storage_usage",
  "supervisor_info",
  "traces",
]);
const SAFE_STATE_ATTRIBUTES = new Set([
  "device_class",
  "friendly_name",
  "icon",
  "state_class",
  "unit_of_measurement",
]);
const REDACTED_SENSITIVE_STATE = "[REDACTED_SENSITIVE_STATE]";
const SENSITIVE_STATE_SUBJECT =
  /(?:^|[._-])(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)(?:[._-]|$)/iu;
const SENSITIVE_STATE_VALUE =
  /(?:\bBearer\s+\S+|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw new HaReadError("invalid_request", `${label} must be an object`);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new HaReadError("invalid_request", `${label} contains an unsupported field`);
  }
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HaReadError("invalid_request", `${label} is outside the allowed range`);
  }
  return value;
}

function optionalToken(value, label, pattern, maximum = 255) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) {
    throw new HaReadError("invalid_request", `${label} is invalid`);
  }
  return value;
}

function stateValueIsSensitive(value, supervisorToken) {
  return (
    typeof value === "string" &&
    ((supervisorToken && value.includes(supervisorToken)) ||
      SENSITIVE_STATE_VALUE.test(value))
  );
}

function projectState(value, supervisorToken) {
  if (!isPlainObject(value) || typeof value.entity_id !== "string" || typeof value.state !== "string") {
    throw new HaReadError("upstream_invalid", "Home Assistant returned an invalid state");
  }
  const attributes = isPlainObject(value.attributes)
    ? Object.fromEntries(
        Object.entries(value.attributes)
          .filter(([key, item]) =>
            SAFE_STATE_ATTRIBUTES.has(key) &&
            (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null))
          .map(([key, item]) => [
            key,
            SENSITIVE_STATE_SUBJECT.test(key) || stateValueIsSensitive(item, supervisorToken)
              ? REDACTED_SENSITIVE_STATE
              : item,
          ]),
      )
    : {};
  const state =
    SENSITIVE_STATE_SUBJECT.test(value.entity_id) ||
    stateValueIsSensitive(value.state, supervisorToken)
      ? REDACTED_SENSITIVE_STATE
      : value.state;
  return {
    entity_id: value.entity_id,
    state,
    attributes,
    last_changed: typeof value.last_changed === "string" ? value.last_changed : null,
    last_updated: typeof value.last_updated === "string" ? value.last_updated : null,
  };
}

function pick(value, keys) {
  if (!isPlainObject(value)) throw new HaReadError("upstream_invalid", "upstream result is invalid");
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

function byteCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HaReadError("upstream_invalid", `${label} is invalid`);
  }
  return value;
}

function compatibleByteCount(value, currentKey, legacyKey, label) {
  if (!isPlainObject(value)) {
    throw new HaReadError("upstream_invalid", "storage usage result is invalid");
  }
  const current = value[currentKey];
  const legacy = value[legacyKey];
  if (current !== undefined && legacy !== undefined && current !== legacy) {
    throw new HaReadError("upstream_invalid", `${label} is ambiguous`);
  }
  return byteCount(current ?? legacy, label);
}

function projectStorageUsage(value) {
  if (!isPlainObject(value) || !Array.isArray(value.children)) {
    throw new HaReadError("upstream_invalid", "storage usage result is invalid");
  }
  const totalBytes = compatibleByteCount(
    value,
    "total_bytes",
    "total_space",
    "total storage bytes",
  );
  const usedBytes = compatibleByteCount(
    value,
    "used_bytes",
    "used_space",
    "used storage bytes",
  );
  if (usedBytes > totalBytes) {
    throw new HaReadError("upstream_invalid", "used storage bytes exceed total storage bytes");
  }

  const projected = new Map();
  for (const child of value.children) {
    if (!isPlainObject(child) || typeof child.id !== "string") continue;
    const id = STORAGE_USAGE_CATEGORY_ALIASES.get(child.id);
    if (id === undefined) continue;
    if (projected.has(id)) {
      throw new HaReadError("upstream_invalid", "storage usage category is duplicated");
    }
    const categoryBytes = compatibleByteCount(
      child,
      "used_bytes",
      "used_space",
      `${id} storage bytes`,
    );
    if (categoryBytes > totalBytes) {
      throw new HaReadError("upstream_invalid", `${id} storage bytes exceed total storage bytes`);
    }
    projected.set(id, categoryBytes);
  }

  return {
    total_bytes: totalBytes,
    used_bytes: usedBytes,
    available_bytes: totalBytes - usedBytes,
    categories: STORAGE_USAGE_CATEGORY_IDS
      .filter((id) => projected.has(id))
      .map((id) => ({ id, used_bytes: projected.get(id) })),
  };
}

const SENSITIVE_LOG_LINE = "[REDACTED_SENSITIVE_LOG_LINE]";
const SENSITIVE_LOG_KEY =
  /(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|credential|password|proxy[_-]?authorization|secret|set-cookie|token)[\\'"`\s]{0,8}[=:]/iu;
const SENSITIVE_LOG_VALUE =
  /(?:\bBearer\s+\S+|\bBasic\s+[A-Za-z0-9+/=]+|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/iu;
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/iu;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/iu;
const SENSITIVE_KEY_WITHOUT_VALUE =
  /(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|credential|password|proxy[_-]?authorization|secret|set-cookie|token)[\\'"`\s]{0,8}[=:]\s*$/iu;

function redactLogLine(line, supervisorToken) {
  if (
    line.includes(supervisorToken) ||
    SENSITIVE_LOG_KEY.test(line) ||
    SENSITIVE_LOG_VALUE.test(line)
  ) {
    return SENSITIVE_LOG_LINE;
  }
  const bytes = Buffer.from(line);
  if (bytes.length <= MAX_LOG_LINE_BYTES) return line;
  return `${bytes.subarray(0, MAX_LOG_LINE_BYTES).toString("utf8")}…[truncated]`;
}

function redactLogLines(lines, supervisorToken) {
  let privateKeyBlock = false;
  let redactContinuation = false;
  return lines.map((line) => {
    const startsPrivateKey = PRIVATE_KEY_BEGIN.test(line);
    const endsPrivateKey = PRIVATE_KEY_END.test(line);
    const redactThisLine = privateKeyBlock || startsPrivateKey || redactContinuation;
    privateKeyBlock = (privateKeyBlock || startsPrivateKey) && !endsPrivateKey;
    redactContinuation = !redactThisLine && SENSITIVE_KEY_WITHOUT_VALUE.test(line);
    if (redactThisLine) return SENSITIVE_LOG_LINE;
    return redactLogLine(line, supervisorToken);
  });
}

function sanitizedText(value, supervisorToken, maximum = 1000) {
  if (typeof value !== "string") return null;
  return redactLogLine(value, supervisorToken).slice(0, maximum);
}

function projectRegistryEntry(kind, value) {
  if (!isPlainObject(value)) {
    throw new HaReadError("upstream_invalid", "Home Assistant returned an invalid registry entry");
  }
  if (kind === "area") {
    if (typeof value.area_id !== "string" || typeof value.name !== "string") {
      throw new HaReadError("upstream_invalid", "Home Assistant returned an invalid area entry");
    }
    return pick(value, ["area_id", "floor_id", "icon", "name"]);
  }
  if (kind === "device") {
    if (typeof value.id !== "string") {
      throw new HaReadError("upstream_invalid", "Home Assistant returned an invalid device entry");
    }
    return pick(value, [
      "area_id",
      "disabled_by",
      "entry_type",
      "id",
      "manufacturer",
      "model",
      "name",
      "name_by_user",
      "via_device_id",
    ]);
  }
  if (typeof value.entity_id !== "string") {
    throw new HaReadError("upstream_invalid", "Home Assistant returned an invalid entity entry");
  }
  return pick(value, [
    "area_id",
    "device_id",
    "disabled_by",
    "entity_category",
    "entity_id",
    "hidden_by",
    "name",
    "original_name",
    "platform",
  ]);
}

function registrySearchText(kind, value) {
  const fields = kind === "area"
    ? [value.area_id, value.name]
    : kind === "device"
      ? [value.id, value.name_by_user, value.name, value.manufacturer, value.model]
      : [value.entity_id, value.name, value.original_name, value.platform];
  return fields.filter((item) => typeof item === "string").join(" ").toLowerCase();
}

function projectHistory(value, entityId, limit, supervisorToken) {
  if (!Array.isArray(value) || value.some((series) => !Array.isArray(series))) {
    throw new HaReadError("upstream_invalid", "Home Assistant returned invalid history data");
  }
  const rows = value.flat();
  const selected = rows.slice(-limit).map((item) => {
    if (!isPlainObject(item) || typeof item.state !== "string") {
      throw new HaReadError("upstream_invalid", "Home Assistant returned an invalid history state");
    }
    const projectedEntityId =
      typeof item.entity_id === "string" ? item.entity_id : entityId;
    const attributes = isPlainObject(item.attributes)
      ? Object.fromEntries(
          Object.entries(item.attributes)
            .filter(([key, attribute]) =>
              SAFE_STATE_ATTRIBUTES.has(key) &&
              (typeof attribute === "string" || typeof attribute === "number" ||
                typeof attribute === "boolean" || attribute === null))
            .map(([key, attribute]) => [
              key,
              SENSITIVE_STATE_SUBJECT.test(key) ||
              stateValueIsSensitive(attribute, supervisorToken)
                ? REDACTED_SENSITIVE_STATE
                : attribute,
            ]),
        )
      : {};
    return {
      entity_id: projectedEntityId,
      state:
        SENSITIVE_STATE_SUBJECT.test(projectedEntityId) ||
        stateValueIsSensitive(item.state, supervisorToken)
          ? REDACTED_SENSITIVE_STATE
          : item.state,
      attributes,
      last_changed: typeof item.last_changed === "string" ? item.last_changed : null,
      last_updated: typeof item.last_updated === "string" ? item.last_updated : null,
    };
  });
  return { entity_id: entityId, states: selected, truncated: rows.length > limit };
}

function projectTraceSummary(value, supervisorToken) {
  if (!isPlainObject(value) || typeof value.run_id !== "string") {
    throw new HaReadError("upstream_invalid", "Home Assistant returned an invalid trace summary");
  }
  const timestamp = isPlainObject(value.timestamp)
    ? {
        start: typeof value.timestamp.start === "string" ? value.timestamp.start : null,
        finish: typeof value.timestamp.finish === "string" ? value.timestamp.finish : null,
      }
    : { start: null, finish: null };
  return {
    domain: typeof value.domain === "string" ? value.domain : null,
    item_id: typeof value.item_id === "string" ? value.item_id : null,
    run_id: value.run_id,
    state: typeof value.state === "string" ? value.state : null,
    script_execution: typeof value.script_execution === "string" ? value.script_execution : null,
    last_step: typeof value.last_step === "string" ? value.last_step : null,
    timestamp,
    error: sanitizedText(value.error, supervisorToken),
  };
}

function projectTraceDetail(value, supervisorToken) {
  const summary = projectTraceSummary(value, supervisorToken);
  const trace = isPlainObject(value.trace) ? value.trace : {};
  const steps = Object.entries(trace).slice(0, 100).map(([path, entries]) => ({
    path: String(path).slice(0, 255),
    events: Array.isArray(entries) ? Math.min(entries.length, 1000) : 0,
    error: Array.isArray(entries) && entries.some((entry) => isPlainObject(entry) && entry.error),
  }));
  return { ...summary, steps, steps_truncated: Object.keys(trace).length > steps.length };
}

async function readBoundedBody(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > HA_READ_MAX_RESPONSE_BYTES) {
      throw new HaReadError("upstream_too_large", "upstream response exceeded the size limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class HaReadBroker {
  constructor({
    socketPath = HA_READ_SOCKET_PATH,
    supervisorToken,
    fetchImpl = globalThis.fetch,
    requiredUid = typeof process.getuid === "function" ? process.getuid() : 0,
    upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
    memorySnapshotFetcher = fetchHomeAssistantSnapshot,
    webSocketReader = fetchHomeAssistantBrokerRead,
    now = () => Date.now(),
  } = {}) {
    this.socketPath = socketPath;
    this.supervisorToken = supervisorToken;
    this.fetchImpl = fetchImpl;
    this.requiredUid = requiredUid;
    this.upstreamTimeoutMs = upstreamTimeoutMs;
    this.memorySnapshotFetcher = memorySnapshotFetcher;
    this.webSocketReader = webSocketReader;
    this.now = now;
    this.server = null;
  }

  async #fetch(path, { supervisor = false, accept = "application/json" } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.upstreamTimeoutMs);
    timer.unref();
    try {
      const response = await this.fetchImpl(
        `${supervisor ? SUPERVISOR_API_URL : CORE_API_URL}${path}`,
        {
          method: "GET",
          headers: {
            Accept: accept,
            Authorization: `Bearer ${this.supervisorToken}`,
          },
          redirect: "error",
          signal: controller.signal,
        },
      );
      if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
        throw new HaReadError("upstream_rejected", "Home Assistant rejected the read request");
      }
      return await readBoundedBody(response);
    } catch (error) {
      if (error instanceof HaReadError) throw error;
      throw new HaReadError("upstream_unavailable", "Home Assistant read endpoint is unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  async #json(path, options) {
    const body = await this.#fetch(path, options);
    try {
      return JSON.parse(body);
    } catch {
      throw new HaReadError("upstream_invalid", "Home Assistant returned invalid JSON");
    }
  }

  async #supervisorData(path) {
    const envelope = await this.#json(path, { supervisor: true });
    if (!isPlainObject(envelope) || envelope.result !== "ok" || !isPlainObject(envelope.data)) {
      throw new HaReadError("upstream_invalid", "Supervisor returned an invalid result");
    }
    return envelope.data;
  }

  async #webSocket(command) {
    try {
      return await this.webSocketReader(command, {
        url: "ws://supervisor/core/websocket",
        token: this.supervisorToken,
        timeoutMs: this.upstreamTimeoutMs,
      });
    } catch (error) {
      if (error instanceof HomeAssistantUnavailableError) {
        throw new HaReadError(error.code, "Home Assistant WebSocket read failed");
      }
      throw new HaReadError("upstream_unavailable", "Home Assistant WebSocket read failed");
    }
  }

  async dispatch(action, payload = {}) {
    if (!ACTIONS.has(action)) throw new HaReadError("unsupported_action", "read action is unsupported");
    switch (action) {
      case "config": {
        assertOnlyKeys(payload, new Set(), "config payload");
        const value = await this.#json("/config");
        return pick(value, [
          "config_dir",
          "currency",
          "location_name",
          "safe_mode",
          "state",
          "time_zone",
          "unit_system",
          "version",
        ]);
      }
      case "state": {
        assertOnlyKeys(payload, new Set(["entity_id"]), "state payload");
        const entityId = optionalToken(
          payload.entity_id,
          "entity_id",
          /^[a-z0-9_]+\.[a-z0-9_]+$/u,
        );
        if (!entityId) throw new HaReadError("invalid_request", "entity_id is required");
        return projectState(
          await this.#json(`/states/${encodeURIComponent(entityId)}`),
          this.supervisorToken,
        );
      }
      case "states": {
        assertOnlyKeys(payload, new Set(["domain", "query", "limit"]), "states payload");
        const domain = optionalToken(payload.domain, "domain", /^[a-z][a-z0-9_]*$/u, 64);
        const query = optionalToken(payload.query, "query", /^[a-z0-9_.-]+$/u, 80);
        const limit = boundedInteger(payload.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT, "limit");
        const value = await this.#json("/states");
        if (!Array.isArray(value)) throw new HaReadError("upstream_invalid", "state list is invalid");
        return value
          .filter((item) => isPlainObject(item) && typeof item.entity_id === "string")
          .filter((item) => !domain || item.entity_id.startsWith(`${domain}.`))
          .filter((item) => !query || item.entity_id.includes(query))
          .slice(0, limit)
          .map((item) => projectState(item, this.supervisorToken));
      }
      case "services": {
        assertOnlyKeys(payload, new Set(["domain", "limit"]), "services payload");
        const domain = optionalToken(payload.domain, "domain", /^[a-z][a-z0-9_]*$/u, 64);
        const limit = boundedInteger(payload.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT, "limit");
        const value = await this.#json("/services");
        if (!Array.isArray(value)) throw new HaReadError("upstream_invalid", "service list is invalid");
        return value
          .filter((item) => isPlainObject(item) && typeof item.domain === "string" && isPlainObject(item.services))
          .filter((item) => !domain || item.domain === domain)
          .flatMap((item) => Object.keys(item.services).sort().map((service) => ({ domain: item.domain, service })))
          .slice(0, limit);
      }
      case "registry": {
        assertOnlyKeys(payload, new Set(["kind", "query", "limit"]), "registry payload");
        const kind = optionalToken(payload.kind, "kind", /^(?:area|device|entity)$/u, 16);
        if (!kind) throw new HaReadError("invalid_request", "registry kind is required");
        const query = optionalToken(payload.query, "query", /^[A-Za-z0-9_. -]+$/u, 80)?.toLowerCase();
        const limit = boundedInteger(payload.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT, "limit");
        const commandType = {
          area: "config/area_registry/list",
          device: "config/device_registry/list",
          entity: "config/entity_registry/list",
        }[kind];
        const value = await this.#webSocket({ type: commandType });
        if (!Array.isArray(value)) {
          throw new HaReadError("upstream_invalid", "Home Assistant registry result is invalid");
        }
        const filtered = value
          .filter((entry) => !query || registrySearchText(kind, entry).includes(query));
        return {
          kind,
          entries: filtered.slice(0, limit).map((entry) => projectRegistryEntry(kind, entry)),
          truncated: filtered.length > limit,
        };
      }
      case "history": {
        assertOnlyKeys(payload, new Set(["entity_id", "hours", "limit"]), "history payload");
        const entityId = optionalToken(payload.entity_id, "entity_id", /^[a-z0-9_]+\.[a-z0-9_]+$/u);
        if (!entityId) throw new HaReadError("invalid_request", "entity_id is required");
        const hours = boundedInteger(
          payload.hours,
          DEFAULT_HISTORY_HOURS,
          1,
          MAX_HISTORY_HOURS,
          "hours",
        );
        const limit = boundedInteger(
          payload.limit,
          DEFAULT_HISTORY_LIMIT,
          1,
          MAX_HISTORY_LIMIT,
          "limit",
        );
        const end = new Date(this.now());
        const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
        const query = new URLSearchParams({
          end_time: end.toISOString(),
          filter_entity_id: entityId,
        });
        query.append("minimal_response", "");
        const value = await this.#json(
          `/history/period/${encodeURIComponent(start.toISOString())}?${query.toString()}`,
        );
        return projectHistory(value, entityId, limit, this.supervisorToken);
      }
      case "traces": {
        assertOnlyKeys(
          payload,
          new Set(["domain", "item_id", "run_id", "limit"]),
          "trace payload",
        );
        const domain = optionalToken(payload.domain, "domain", /^(?:automation|script)$/u, 16);
        if (!domain) throw new HaReadError("invalid_request", "trace domain is required");
        const itemId = optionalToken(payload.item_id, "item_id", /^[a-z0-9_-]+$/u, 255);
        const runId = optionalToken(payload.run_id, "run_id", /^[A-Za-z0-9_-]+$/u, 128);
        const limit = boundedInteger(payload.limit, DEFAULT_TRACE_LIMIT, 1, MAX_TRACE_LIMIT, "limit");
        if (runId && !itemId) {
          throw new HaReadError("invalid_request", "item_id is required when run_id is supplied");
        }
        if (runId) {
          const value = await this.#webSocket({
            type: "trace/get",
            domain,
            item_id: itemId,
            run_id: runId,
          });
          return projectTraceDetail(value, this.supervisorToken);
        }
        const command = { type: "trace/list", domain };
        if (itemId) command.item_id = itemId;
        const value = await this.#webSocket(command);
        if (!Array.isArray(value)) {
          throw new HaReadError("upstream_invalid", "Home Assistant trace list is invalid");
        }
        return {
          traces: value.slice(-limit).map((trace) => projectTraceSummary(trace, this.supervisorToken)),
          truncated: value.length > limit,
        };
      }
      case "core_info": {
        assertOnlyKeys(payload, new Set(), "core info payload");
        return pick(await this.#supervisorData("/core/info"), [
          "arch",
          "boot",
          "healthy",
          "image",
          "machine",
          "port",
          "ssl",
          "state",
          "update_available",
          "version",
          "version_latest",
          "watchdog",
        ]);
      }
      case "supervisor_info": {
        assertOnlyKeys(payload, new Set(), "supervisor info payload");
        return pick(await this.#supervisorData("/supervisor/info"), [
          "arch",
          "channel",
          "healthy",
          "supported",
          "timezone",
          "update_available",
          "version",
          "version_latest",
        ]);
      }
      case "storage_usage": {
        assertOnlyKeys(payload, new Set(), "storage usage payload");
        return projectStorageUsage(
          await this.#supervisorData("/host/disks/default/usage"),
        );
      }
      case "core_logs": {
        assertOnlyKeys(payload, new Set(["lines"]), "log payload");
        const lines = boundedInteger(payload.lines, DEFAULT_LOG_LINES, 1, MAX_LOG_LINES, "lines");
        const body = await this.#fetch("/core/logs", {
          supervisor: true,
          accept: "text/x-log",
        });
        const allLines = body.split(/\r?\n/u);
        return {
          lines: redactLogLines(allLines, this.supervisorToken).slice(-lines),
          truncated: allLines.length > lines,
        };
      }
      case "app_logs": {
        assertOnlyKeys(payload, new Set(["lines"]), "App log payload");
        const lines = boundedInteger(payload.lines, DEFAULT_LOG_LINES, 1, MAX_LOG_LINES, "lines");
        const body = await this.#fetch("/addons/self/logs", {
          supervisor: true,
          accept: "text/x-log",
        });
        const allLines = body.split(/\r?\n/u);
        return {
          lines: redactLogLines(allLines, this.supervisorToken).slice(-lines),
          truncated: allLines.length > lines,
        };
      }
      case "memory_snapshot": {
        assertOnlyKeys(payload, new Set(), "memory snapshot payload");
        try {
          return await this.memorySnapshotFetcher({
            url: "ws://supervisor/core/websocket",
            token: this.supervisorToken,
            timeoutMs: 10_000,
          });
        } catch (error) {
          if (error instanceof HomeAssistantUnavailableError) {
            throw new HaReadError(error.code, "Home Assistant memory snapshot failed");
          }
          throw new HaReadError("ha_unavailable", "Home Assistant memory snapshot failed");
        }
      }
      default:
        throw new HaReadError("unsupported_action", "read action is unsupported");
    }
  }

  async start() {
    if (
      typeof this.supervisorToken !== "string" ||
      this.supervisorToken === "" ||
      /[\r\n]/u.test(this.supervisorToken) ||
      typeof this.fetchImpl !== "function" ||
      typeof this.webSocketReader !== "function" ||
      typeof this.now !== "function"
    ) {
      throw new HaReadError("credential_unavailable", "Supervisor credential is unavailable");
    }
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    const parent = await lstat(dirname(this.socketPath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== this.requiredUid || (parent.mode & 0o077) !== 0) {
      throw new HaReadError("unsafe_socket", "read broker socket directory is unsafe");
    }
    try {
      const existing = await lstat(this.socketPath);
      if (!existing.isSocket() || existing.isSymbolicLink()) {
        throw new HaReadError("unsafe_socket", "read broker socket path is unsafe");
      }
      await unlink(this.socketPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.server = net.createServer((socket) => this.#handleSocket(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600);
  }

  async close() {
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => server.close(resolve));
    await unlink(this.socketPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }

  #handleSocket(socket) {
    socket.setEncoding("utf8");
    let input = "";
    let bytes = 0;
    let handled = false;
    const fail = (error) => {
      const code = error instanceof HaReadError ? error.code : "read_failed";
      const response = `${JSON.stringify({ ok: false, error: code })}\n`;
      socket.end(response);
    };
    socket.on("data", (chunk) => {
      if (handled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > HA_READ_MAX_REQUEST_BYTES) {
        handled = true;
        fail(new HaReadError("request_too_large", "read request exceeds the size limit"));
        return;
      }
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      socket.pause();
      if (input.slice(newline + 1).trim() !== "") {
        fail(new HaReadError("invalid_request", "only one request is accepted"));
        return;
      }
      let request;
      try {
        request = JSON.parse(input.slice(0, newline));
      } catch {
        fail(new HaReadError("invalid_request", "read request is not valid JSON"));
        return;
      }
      if (
        !isPlainObject(request) ||
        request.version !== HA_READ_PROTOCOL_VERSION ||
        typeof request.action !== "string" ||
        !isPlainObject(request.payload) ||
        Object.keys(request).some((key) => !["version", "action", "payload"].includes(key))
      ) {
        fail(new HaReadError("invalid_request", "read request shape is invalid"));
        return;
      }
      this.dispatch(request.action, request.payload)
        .then((result) => {
          const response = `${JSON.stringify({ ok: true, result })}\n`;
          if (Buffer.byteLength(response) > haReadResponseLimit(request.action)) {
            fail(new HaReadError("response_too_large", "read response exceeds the size limit"));
            return;
          }
          socket.end(response);
        })
        .catch(fail);
    });
    socket.once("error", () => {});
  }
}

export async function runHaReadBroker() {
  const supervisorToken = consumeSupervisorCredentialFromInheritedFd();
  const broker = new HaReadBroker({ supervisorToken });
  await broker.start();
  console.log(JSON.stringify({ service: "ha-read-broker", event: "ready" }));
  const stop = async () => {
    await broker.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHaReadBroker().catch(() => process.exit(1));
}
