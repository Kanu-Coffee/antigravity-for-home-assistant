import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  BrokerError,
  DEFAULT_PROPOSAL_SOCKET_PATH,
  sendBrokerRequest,
} from "./ha-change-broker.mjs";

const SERVER_NAME = "antigravity-ha-change-proposal";
const SERVER_VERSION = "1.1.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const MAX_LINE_BYTES = 1024 * 1024;

const configPatchSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      minLength: 1,
      maxLength: 240,
      description: "Canonical path relative to /config. Sensitive paths and non-YAML files are rejected by the broker.",
    },
    expected_sha256: {
      type: "string",
      pattern: "^(missing|sha256:[a-f0-9]{64})$",
      description: "Fresh pre-change file digest, or missing for a new file.",
    },
    content: {
      type: "string",
      minLength: 1,
      maxLength: 1048576,
      description: "Complete replacement YAML content. This is bound into the broker-computed preview digest.",
    },
    activation: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "input_boolean_reload",
            "automation_reload",
            "script_reload",
            "scene_reload",
          ],
          description:
            "Optional post-check reload. input_boolean_reload retains semantic verification; automation/script/scene reloads require Telegram confirmation and broker-controlled API completion. Omit it when no safe reload is known; the validated file replacement remains executable and reports restart_required.",
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  required: ["path", "expected_sha256", "content"],
  additionalProperties: false,
};

const serviceCallSchema = {
  type: "object",
  properties: {
    domain: {
      type: "string",
      pattern: "^[a-z][a-z0-9_]*$",
      maxLength: 64,
    },
    service: {
      type: "string",
      pattern: "^[a-z][a-z0-9_]*$",
      maxLength: 64,
    },
    entity_id: {
      oneOf: [
        {
          type: "string",
          pattern: "^[a-z0-9_]+\\.[a-z0-9_]+$",
          maxLength: 255,
        },
        {
          type: "array",
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
          items: {
            type: "string",
            pattern: "^[a-z0-9_]+\\.[a-z0-9_]+$",
            maxLength: 255,
          },
        },
      ],
      description: "Optional Home Assistant entity target. Services without an entity target may omit it.",
    },
    service_data: {
      type: "object",
      description:
        "Bounded JSON service data. The broker rejects unsafe prototype keys and redacts credential-like values from the Telegram preview while binding the full value into its digest.",
      additionalProperties: true,
    },
    return_response: {
      type: "boolean",
      default: false,
      description:
        "Set true for a Home Assistant service whose REST contract requires response data (?return_response).",
    },
    expected_state: {
      type: "string",
      minLength: 1,
      maxLength: 255,
      description: "Optional fresh state precondition; requires one entity_id.",
    },
    verify_state: {
      type: "string",
      minLength: 1,
      maxLength: 255,
      description: "Optional fresh post-call state; requires expected_state and one entity_id.",
    },
  },
  required: ["domain", "service"],
  additionalProperties: false,
};

const deviceTestSchema = {
  type: "object",
  properties: {
    domain: {
      type: "string",
      enum: ["light", "switch", "input_boolean"],
    },
    service: {
      type: "string",
      enum: ["turn_on", "turn_off"],
    },
    entity_id: {
      type: "string",
      pattern: "^[a-z0-9_]+\\.[a-z0-9_]+$",
      maxLength: 255,
    },
    expected_prior_state: {
      type: "string",
      enum: ["on", "off"],
      description:
        "Fresh state precondition. It must differ from the requested test state; the broker always restores and freshly verifies this state.",
    },
  },
  required: ["domain", "service", "entity_id", "expected_prior_state"],
  additionalProperties: false,
};

const tools = [
  {
    name: "ha_change_propose",
    title: "Propose a bounded Home Assistant change",
    description:
      "Create a short-lived, broker-validated preview for one YAML replacement, any currently registered Home Assistant service call, or one separate transient device test with mandatory verified restoration. YAML replacements use digest preconditions, atomic backup/write, Home Assistant configuration checking, and verified rollback; files without a safe reload report restart_required. This tool never executes the change, never issues a capability, and cannot approve its own proposal. Show the returned preview to the bound Telegram user/chat; a separate trusted coordinator must authorize and execute it.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "config_patch",
            "service_call",
            "device_test",
            "restart",
            "update",
            "restore",
            "delete",
          ],
          description:
            "Only config_patch, service_call, and device_test are executable in v2. device_test is transient and never aliases service_call. Unsupported operations are included so the broker can return an explicit fail-closed result.",
        },
        summary: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Short human-readable intent without credentials, state dumps, or raw conversation.",
        },
        ttl_seconds: {
          type: "integer",
          minimum: 30,
          maximum: 300,
          default: 120,
        },
        payload: {
          oneOf: [configPatchSchema, serviceCallSchema, deviceTestSchema],
        },
      },
      required: ["operation", "summary", "payload"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeBoundRequester(value) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => !["surface", "user_id", "chat_id"].includes(key)) ||
    value.surface !== "telegram" ||
    typeof value.user_id !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(value.user_id) ||
    typeof value.chat_id !== "string" ||
    !/^-?[1-9][0-9]{0,19}$/u.test(value.chat_id)
  ) {
    throw new BrokerError("invalid_requester_binding", "Telegram requester binding is unavailable");
  }
  return {
    surface: "telegram",
    user_id: value.user_id,
    chat_id: value.chat_id,
  };
}

export function telegramRequesterFromEnvironment(environment = process.env) {
  return normalizeBoundRequester({
    surface: "telegram",
    user_id: environment.HA_TELEGRAM_USER_ID,
    chat_id: environment.HA_TELEGRAM_CHAT_ID,
  });
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: { proposal: value },
    isError: false,
  };
}

function toolError(error) {
  const code = error instanceof BrokerError ? error.code : "broker_error";
  const message = error instanceof BrokerError
    ? error.message
    : "Home Assistant change proposal failed";
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: code },
    isError: true,
  };
}

function validateMcpRequest(message) {
  if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    throw new BrokerError("invalid_request", "Invalid Request");
  }
}

export function createMcpRequestHandler({
  requester,
  socketPath = DEFAULT_PROPOSAL_SOCKET_PATH,
  brokerRequest = (action, payload) => sendBrokerRequest(action, payload, { socketPath }),
} = {}) {
  const boundRequester = normalizeBoundRequester(requester);
  return async function handleRequest(message) {
    validateMcpRequest(message);
    const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : undefined;
    if (message.method === "notifications/initialized" || id === undefined) return null;
    switch (message.method) {
      case "initialize": {
        const requested = typeof message.params?.protocolVersion === "string" &&
          message.params.protocolVersion !== ""
          ? message.params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
        return jsonRpcResult(id, {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "This server only creates bounded Home Assistant change proposals. It cannot authorize or execute them. Treat returned risk and preview_digest as broker-owned values, show the preview to the exact requester, and use the trusted Telegram coordinator for any confirmation.",
        });
      }
      case "ping":
        return jsonRpcResult(id, {});
      case "tools/list":
        return jsonRpcResult(id, { tools });
      case "tools/call": {
        if (!isPlainObject(message.params)) {
          return jsonRpcError(id, -32602, "params must be an object");
        }
        const unknown = Object.keys(message.params).filter(
          (key) => !["name", "arguments", "_meta"].includes(key),
        );
        if (unknown.length > 0) {
          return jsonRpcError(id, -32602, "Unsupported tool parameter");
        }
        if (typeof message.params.name !== "string" || !toolByName.has(message.params.name)) {
          return jsonRpcError(id, -32602, "Unknown or missing tool name");
        }
        if (!isPlainObject(message.params.arguments)) {
          return jsonRpcError(id, -32602, "arguments must be an object");
        }
        try {
          if (Object.prototype.hasOwnProperty.call(message.params.arguments, "requester")) {
            throw new BrokerError(
              "requester_override_forbidden",
              "requester is bound by the trusted Telegram coordinator",
            );
          }
          const proposal = await brokerRequest("propose", {
            proposal: {
              ...message.params.arguments,
              requester: boundRequester,
            },
          });
          return jsonRpcResult(id, toolResult(proposal));
        } catch (error) {
          return jsonRpcResult(id, toolError(error));
        }
      }
      default:
        return jsonRpcError(id, -32601, "Method not found");
    }
  };
}

export async function runMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const requester = telegramRequesterFromEnvironment();
  delete process.env.HA_TELEGRAM_USER_ID;
  delete process.env.HA_TELEGRAM_CHAT_ID;
  delete process.env.SUPERVISOR_TOKEN;
  delete process.env.BASH_ENV;
  delete process.env.ENV;
  delete process.env.NODE_OPTIONS;
  delete process.env.NODE_PATH;
  const handleRequest = createMcpRequestHandler({ requester });
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
    try {
      const response = await handleRequest(message);
      if (response !== null) output.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      const id = isPlainObject(message) && Object.prototype.hasOwnProperty.call(message, "id")
        ? message.id
        : null;
      const code = error instanceof BrokerError && error.code === "invalid_request"
        ? -32600
        : -32603;
      output.write(`${JSON.stringify(jsonRpcError(id, code, code === -32600 ? error.message : "Internal error"))}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpServer().catch(() => process.exit(1));
}
