import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { HaReadError, sendHaReadRequest } from "./ha-read-client.mjs";

const SERVER_NAME = "antigravity-ha-read";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2024-11-05";
const MAX_LINE_BYTES = 1024 * 1024;

const emptySchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const tools = [
  {
    name: "ha_read_config",
    title: "Read safe Home Assistant configuration metadata",
    description: "Return a projected, read-only subset of Home Assistant configuration metadata.",
    inputSchema: emptySchema,
    action: "config",
  },
  {
    name: "ha_read_state",
    title: "Read one exact Home Assistant entity state",
    description: "Read one exact entity ID with a small safe attribute projection.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          pattern: "^[a-z0-9_]+\\.[a-z0-9_]+$",
          maxLength: 255,
        },
      },
      required: ["entity_id"],
      additionalProperties: false,
    },
    action: "state",
  },
  {
    name: "ha_read_states",
    title: "List bounded Home Assistant entity states",
    description: "List at most 100 projected states, optionally filtered by domain and entity-ID substring.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", pattern: "^[a-z][a-z0-9_]*$", maxLength: 64 },
        query: { type: "string", pattern: "^[a-z0-9_.-]+$", maxLength: 80 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      additionalProperties: false,
    },
    action: "states",
  },
  {
    name: "ha_read_services",
    title: "List bounded Home Assistant services",
    description: "List at most 100 service names, optionally for one exact domain.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", pattern: "^[a-z][a-z0-9_]*$", maxLength: 64 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      additionalProperties: false,
    },
    action: "services",
  },
  {
    name: "ha_read_registry",
    title: "List a bounded Home Assistant registry projection",
    description:
      "List at most 100 projected area, device, or entity registry entries without credentials or integration identifiers.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["area", "device", "entity"] },
        query: { type: "string", pattern: "^[A-Za-z0-9_. -]+$", maxLength: 80 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    action: "registry",
  },
  {
    name: "ha_read_history",
    title: "Read bounded recent history for one entity",
    description:
      "Read up to 500 projected state changes for one exact entity over at most the last seven days.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          pattern: "^[a-z0-9_]+\\.[a-z0-9_]+$",
          maxLength: 255,
        },
        hours: { type: "integer", minimum: 1, maximum: 168, default: 24 },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      required: ["entity_id"],
      additionalProperties: false,
    },
    action: "history",
  },
  {
    name: "ha_read_traces",
    title: "Read bounded automation or script trace metadata",
    description:
      "List safe trace summaries, or inspect one run as step/error metadata without raw config, actions, results, triggers, or context.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", enum: ["automation", "script"] },
        item_id: { type: "string", pattern: "^[a-z0-9_-]+$", maxLength: 255 },
        run_id: { type: "string", pattern: "^[A-Za-z0-9_-]+$", maxLength: 128 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      required: ["domain"],
      additionalProperties: false,
    },
    action: "traces",
  },
  {
    name: "ha_read_system_info",
    title: "Read projected Core or Supervisor information",
    description: "Return a fixed safe projection of Core or Supervisor runtime information.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["core", "supervisor"] },
      },
      required: ["scope"],
      additionalProperties: false,
    },
    action: null,
  },
  {
    name: "ha_read_storage_usage",
    title: "Read projected Home Assistant host storage usage",
    description:
      "Return total, used, available, and fixed-category byte counts from the Supervisor data disk usage endpoint without paths or Docker access.",
    inputSchema: emptySchema,
    action: "storage_usage",
  },
  {
    name: "ha_read_core_logs",
    title: "Read a bounded tail of sanitized Home Assistant Core logs",
    description: "Return at most 500 sanitized log lines with per-line and total response limits.",
    inputSchema: {
      type: "object",
      properties: {
        lines: { type: "integer", minimum: 1, maximum: 500, default: 200 },
      },
      additionalProperties: false,
    },
    action: "core_logs",
  },
  {
    name: "ha_read_app_logs",
    title: "Read a bounded tail of sanitized Antigravity App logs",
    description: "Return at most 500 sanitized log lines for this Home Assistant App.",
    inputSchema: {
      type: "object",
      properties: {
        lines: { type: "integer", minimum: 1, maximum: 500, default: 200 },
      },
      additionalProperties: false,
    },
    action: "app_logs",
  },
].map((tool) => ({
  ...tool,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}));

const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resultContent(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
    isError: false,
  };
}

function errorContent(error) {
  const code = error instanceof HaReadError ? error.code : "read_failed";
  return {
    content: [{ type: "text", text: `Home Assistant read failed: ${code}` }],
    structuredContent: { error: code },
    isError: true,
  };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function createHaReadMcpHandler({
  brokerRequest = (action, payload) => sendHaReadRequest(action, payload),
} = {}) {
  return async function handle(message) {
    if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return jsonRpcError(null, -32600, "Invalid Request");
    }
    const hasId = Object.hasOwn(message, "id");
    const id = hasId ? message.id : null;
    if (message.method === "notifications/initialized" || !hasId) return null;
    if (message.method === "initialize") {
      const requested = typeof message.params?.protocolVersion === "string"
        ? message.params.protocolVersion
        : PROTOCOL_VERSION;
      return jsonRpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Read-only Home Assistant tools. Results are bounded projections from a token-isolated image-managed broker; no tool can call a service or change configuration.",
      });
    }
    if (message.method === "ping") return jsonRpcResult(id, {});
    if (message.method === "tools/list") {
      return jsonRpcResult(id, {
        tools: tools.map(({ action: _action, ...tool }) => tool),
      });
    }
    if (message.method !== "tools/call") return jsonRpcError(id, -32601, "Method not found");
    if (
      !isPlainObject(message.params) ||
      typeof message.params.name !== "string" ||
      !toolByName.has(message.params.name) ||
      !isPlainObject(message.params.arguments ?? {}) ||
      Object.keys(message.params).some((key) => !["name", "arguments", "_meta"].includes(key))
    ) {
      return jsonRpcError(id, -32602, "Invalid tool arguments");
    }
    const tool = toolByName.get(message.params.name);
    const arguments_ = message.params.arguments ?? {};
    if (
      tool.action === null &&
      (Object.keys(arguments_).length !== 1 || !Object.hasOwn(arguments_, "scope"))
    ) {
      return jsonRpcResult(id, errorContent(new HaReadError("invalid_request", "scope is invalid")));
    }
    const action = tool.action ?? (arguments_.scope === "core" ? "core_info" :
      arguments_.scope === "supervisor" ? "supervisor_info" : null);
    if (action === null) return jsonRpcResult(id, errorContent(new HaReadError("invalid_request", "scope is invalid")));
    const payload = tool.action === null ? {} : arguments_;
    try {
      return jsonRpcResult(id, resultContent(await brokerRequest(action, payload)));
    } catch (error) {
      return jsonRpcResult(id, errorContent(error));
    }
  };
}

export async function runHaReadMcp({ input = process.stdin, output = process.stdout } = {}) {
  delete process.env.SUPERVISOR_TOKEN;
  delete process.env.BASH_ENV;
  delete process.env.ENV;
  delete process.env.NODE_OPTIONS;
  delete process.env.NODE_PATH;
  const handle = createHaReadMcpHandler();
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      output.write(`${JSON.stringify(jsonRpcError(null, -32700, "Request exceeded the size limit"))}\n`);
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error"))}\n`);
      continue;
    }
    const response = await handle(message);
    if (response !== null) output.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHaReadMcp().catch(() => process.exit(1));
}
