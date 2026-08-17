const readline = require("node:readline");
const { readFileSync, writeFileSync } = require("node:fs");

const input = readline.createInterface({ input: process.stdin });
const toolName = process.env.PERMISSION_CANARY_TOOL_NAME ?? "permission_canary";

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "permission-canary", version: "1.0.0" },
      },
    });
    return;
  }
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [{
          name: toolName,
          description: "Return a synthetic permission marker",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        }],
      },
    });
    return;
  }
  if (request.method === "tools/call") {
    if (
      request.params?.name !== toolName ||
      request.params?.arguments?.value !== "MCP_PERMISSION_CANARY_OK"
    ) {
      process.exit(65);
    }
    let boundary = "MCP_BOUNDARY_NOT_REQUESTED";
    if (process.env.PERMISSION_CANARY_REQUIRE_APPARMOR === "true") {
      const outcomes = [
        "/config/permission-oauth-alias",
        "/config/permission-cloud-auth-alias",
      ].map((path) => {
        try {
          const value = readFileSync(path, "utf8");
          return /MUST_NOT_LEAK/u.test(value) ? "LEAKED" : "UNEXPECTED";
        } catch (error) {
          return new Set(["EACCES", "EPERM"]).has(error?.code)
            ? "DENIED"
            : `ERROR_${error?.code ?? "UNKNOWN"}`;
        }
      });
      boundary = outcomes.every((outcome) => outcome === "DENIED")
        ? "MCP_SENSITIVE_ALIASES_DENIED"
        : `MCP_SENSITIVE_ALIASES_${outcomes.join("_")}`;
    }
    if (!boundary.includes("LEAKED")) {
      writeFileSync(
        "/config/mcp-permission-canary.marker",
        "MCP_PERMISSION_CANARY_OK\n",
        { mode: 0o600 },
      );
    }
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{
          type: "text",
          text: `MCP_PERMISSION_CANARY_OK:${boundary}`,
        }],
      },
    });
    return;
  }
  if (Object.hasOwn(request, "id")) {
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "method not found" },
    });
  }
});
