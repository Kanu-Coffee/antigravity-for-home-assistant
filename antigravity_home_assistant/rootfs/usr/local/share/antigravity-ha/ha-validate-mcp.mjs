import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { HaReadError, sendHaReadRequest } from "./ha-read-client.mjs";

const SERVER_NAME = "antigravity-ha-validate";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2024-11-05";
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_CHECK_OUTPUT_BYTES = 16 * 1024;

class HaValidateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HaValidateError";
    this.code = code;
  }
}

const tools = [
  {
    name: "ha_validate_config",
    title: "Validate Home Assistant configuration",
    description:
      "Run the image-managed Home Assistant configuration check without reloading or restarting Core.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ha_verify_state",
    title: "Freshly verify one Home Assistant entity state",
    description:
      "Read one exact entity from the token-isolated broker and compare it with an expected state and optional lower timestamp bound.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          pattern: "^[a-z0-9_]+\\.[a-z0-9_]+$",
          maxLength: 255,
        },
        expected_state: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          pattern: "^[^\\u0000-\\u001f\\u007f]+$",
        },
        not_before: {
          type: "string",
          format: "date-time",
          maxLength: 40,
        },
      },
      required: ["entity_id", "expected_state"],
      additionalProperties: false,
    },
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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function runConfigCheck() {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/local/bin/ha-config-check",
      [],
      {
        encoding: "utf8",
        env: {
          HOME: "/tmp",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: "/usr/local/bin:/usr/bin:/bin",
        },
        maxBuffer: MAX_CHECK_OUTPUT_BYTES,
        timeout: 65_000,
      },
      (error) => {
        if (error?.killed || error?.code === "ETIMEDOUT") {
          reject(new HaValidateError("config_check_timeout", "Configuration validation timed out"));
          return;
        }
        if (error && typeof error.code !== "number") {
          reject(new HaValidateError("config_check_unavailable", "Configuration validation is unavailable"));
          return;
        }
        resolve({
          valid: !error,
          exit_code: error && typeof error.code === "number" ? error.code : 0,
          checked_at: new Date().toISOString(),
          diagnostic_code: error ? "invalid" : "valid",
        });
      },
    );
  });
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function successContent(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
    isError: false,
  };
}

function failureContent(error) {
  const code = error instanceof HaValidateError || error instanceof HaReadError
    ? error.code
    : "validation_failed";
  return {
    content: [{ type: "text", text: `Home Assistant validation failed: ${code}` }],
    structuredContent: { error: code },
    isError: true,
  };
}

function validateStateArguments(args) {
  if (
    !isPlainObject(args) ||
    Object.keys(args).some((key) => !["entity_id", "expected_state", "not_before"].includes(key)) ||
    typeof args.entity_id !== "string" ||
    !/^[a-z0-9_]+\.[a-z0-9_]+$/u.test(args.entity_id) ||
    args.entity_id.length > 255 ||
    typeof args.expected_state !== "string" ||
    args.expected_state.length < 1 ||
    args.expected_state.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(args.expected_state)
  ) {
    throw new HaValidateError("invalid_request", "State verification arguments are invalid");
  }
  if (args.not_before !== undefined) {
    if (
      typeof args.not_before !== "string" ||
      args.not_before.length > 40 ||
      !Number.isFinite(Date.parse(args.not_before))
    ) {
      throw new HaValidateError("invalid_request", "not_before must be an ISO date-time");
    }
  }
}

export function createHaValidateMcpHandler({
  configCheck = runConfigCheck,
  brokerRequest = (action, payload) => sendHaReadRequest(action, payload),
  now = () => new Date(),
} = {}) {
  return async function handle(message) {
    if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return jsonRpcError(null, -32600, "Invalid Request");
    }
    const hasId = Object.hasOwn(message, "id");
    const id = hasId ? message.id : null;
    if (message.method === "notifications/initialized" || !hasId) return null;
    if (message.method === "initialize") {
      return jsonRpcResult(id, {
        protocolVersion: typeof message.params?.protocolVersion === "string"
          ? message.params.protocolVersion
          : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Validation-only Home Assistant tools. They do not reload, restart, call a service, or mutate configuration.",
      });
    }
    if (message.method === "ping") return jsonRpcResult(id, {});
    if (message.method === "tools/list") return jsonRpcResult(id, { tools });
    if (message.method !== "tools/call") return jsonRpcError(id, -32601, "Method not found");
    if (
      !isPlainObject(message.params) ||
      !tools.some((tool) => tool.name === message.params.name) ||
      !isPlainObject(message.params.arguments ?? {}) ||
      Object.keys(message.params).some((key) => !["name", "arguments", "_meta"].includes(key))
    ) {
      return jsonRpcError(id, -32602, "Invalid tool arguments");
    }
    const args = message.params.arguments ?? {};
    try {
      if (message.params.name === "ha_validate_config") {
        if (Object.keys(args).length !== 0) {
          throw new HaValidateError("invalid_request", "Configuration validation takes no arguments");
        }
        return jsonRpcResult(id, successContent(await configCheck()));
      }
      validateStateArguments(args);
      const observed = await brokerRequest("state", { entity_id: args.entity_id });
      if (!isPlainObject(observed) || typeof observed.state !== "string") {
        throw new HaValidateError("upstream_invalid", "State verification returned invalid data");
      }
      const observedTimestamp = observed.last_updated ?? observed.last_changed;
      const freshEnough = args.not_before === undefined ||
        (typeof observedTimestamp === "string" &&
          Date.parse(observedTimestamp) >= Date.parse(args.not_before));
      const result = {
        entity_id: args.entity_id,
        expected_state: args.expected_state,
        observed_state: observed.state,
        observed_at: typeof observedTimestamp === "string" ? observedTimestamp : null,
        verified_at: now().toISOString(),
        matches_state: observed.state === args.expected_state,
        fresh_enough: freshEnough,
      };
      result.verified = result.matches_state && result.fresh_enough;
      return jsonRpcResult(id, successContent(result));
    } catch (error) {
      return jsonRpcResult(id, failureContent(error));
    }
  };
}

export async function runHaValidateMcp({ input = process.stdin, output = process.stdout } = {}) {
  delete process.env.SUPERVISOR_TOKEN;
  delete process.env.BASH_ENV;
  delete process.env.ENV;
  delete process.env.NODE_OPTIONS;
  delete process.env.NODE_PATH;
  const handle = createHaValidateMcpHandler();
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
  runHaValidateMcp().catch(() => process.exit(1));
}
