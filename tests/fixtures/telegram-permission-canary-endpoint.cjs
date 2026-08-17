const http = require("node:http");

const requireAppArmor = process.env.PERMISSION_CANARY_REQUIRE_APPARMOR === "true";
const issued = new Set();

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function declarations(value) {
  if (!Array.isArray(value?.tools)) return [];
  return value.tools.flatMap((tool) =>
    tool?.functionDeclarations ?? tool?.function_declarations ?? []);
}

function collectFunctionResponses(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectFunctionResponses(item, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value)) {
    if ((key === "functionResponse" || key === "function_response") &&
        item !== null && typeof item === "object") {
      output.push(item);
    }
    collectFunctionResponses(item, output);
  }
  return output;
}

function responseEvidence(value, name) {
  return collectFunctionResponses(value)
    .filter((item) => item.name === name)
    .map((item) => JSON.stringify(item))
    .join("\n");
}

function callWhenAdvertised(response, names, name, args, key) {
  if (!names.includes(name) || issued.has(key)) return false;
  issued.add(key);
  sendEvent(response, { functionCall: { name, args } });
  return true;
}

function sendEvent(response, part) {
  const event = {
    candidates: [{
      content: { parts: [part], role: "model" },
      finishReason: "STOP",
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: 1,
      candidatesTokenCount: 1,
      totalTokenCount: 2,
    },
    modelVersion: "synthetic-model",
  };
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

const server = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    if (request.method !== "POST") {
      sendJson(response, 200, {});
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(response, 400, { error: "invalid synthetic request" });
      return;
    }
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname.includes("countTokens")) {
      sendJson(response, 200, { totalTokens: 1 });
      return;
    }
    const names = declarations(parsed).map((item) => item?.name);
    const hasSentinel = JSON.stringify(parsed).includes(
      "TELEGRAM_PERMISSION_CANARY_SENTINEL",
    );
    const writeResponses = collectFunctionResponses(parsed)
      .filter((item) => item.name === "write_to_file");
    const writeEvidence = responseEvidence(parsed, "write_to_file");
    const latestWriteEvidence = JSON.stringify(writeResponses.at(-1) ?? {});
    const commandEvidence = responseEvidence(parsed, "run_command");
    const mcpEvidence = responseEvidence(parsed, "call_mcp_tool");
    let state = "await_write_deny";
    if (/denied|permission/iu.test(writeEvidence)) state = "await_command";
    if (commandEvidence.includes("COMMAND_PERMISSION_CANARY_OK")) {
      state = requireAppArmor ? "await_alias_write_deny" : "await_mcp";
    }
    if (requireAppArmor && issued.has("settings-alias") &&
        writeResponses.length >= 2) {
      state = /denied|permission|operation not permitted/iu.test(
        latestWriteEvidence,
      ) ? "await_sensitive_alias_deny" : "settings_alias_write_succeeded";
    }
    if (requireAppArmor && issued.has("sensitive-alias") &&
        /OAUTH_PATH_SENTINEL_MUST_NOT_LEAK_89e74a|CLOUD_AUTH_SENTINEL_MUST_NOT_LEAK_b31f6c/iu
          .test(commandEvidence)) {
      state = "sensitive_alias_leaked";
    } else if (requireAppArmor && issued.has("sensitive-alias") &&
        /denied|permission|operation not permitted/iu.test(commandEvidence)) {
      state = "await_mcp";
    }
    const expectedMcpBoundary = requireAppArmor
      ? "MCP_SENSITIVE_ALIASES_DENIED"
      : "MCP_BOUNDARY_NOT_REQUESTED";
    if (mcpEvidence.includes("MCP_PERMISSION_CANARY_OK") &&
        mcpEvidence.includes(expectedMcpBoundary)) {
      state = "complete";
    }
    process.stdout.write(`${JSON.stringify({
      kind: "request",
      state,
      has_sentinel: hasSentinel,
      run_command_advertised: names.includes("run_command"),
      call_mcp_tool_advertised: names.includes("call_mcp_tool"),
      write_to_file_advertised: names.includes("write_to_file"),
      function_response_count: collectFunctionResponses(parsed).length,
    })}\n`);
    if (!hasSentinel) {
      sendEvent(response, { text: "PERMISSION_CANARY_MISSING_SENTINEL" });
      return;
    }
    if (state === "settings_alias_write_succeeded" ||
        state === "sensitive_alias_leaked") {
      sendEvent(response, { text: "PERMISSION_CANARY_SENSITIVE_ALIAS_LEAKED" });
      return;
    }
    if (state === "await_write_deny" && callWhenAdvertised(
      response,
      names,
      "write_to_file",
      {
        TargetFile: "/data/home/.gemini/antigravity-cli/settings.json",
        Overwrite: true,
        CodeContent: "{\"compromised\":true}\n",
        Description: "permission deny canary",
        toolSummary: "permission deny canary",
        toolAction: "permission deny canary",
      },
      "write",
    )) return;
    if (state === "await_command" && callWhenAdvertised(
      response,
      names,
      "run_command",
      {
        CommandLine:
          "printf '%s\\n' COMMAND_PERMISSION_CANARY_OK | tee /config/command-permission-canary.marker",
        Cwd: "/config",
        Blocking: true,
        WaitMsBeforeAsync: 0,
        explanation: "Write a harmless synthetic command permission marker.",
      },
      "command",
    )) return;
    if (state === "await_alias_write_deny" && callWhenAdvertised(
      response,
      names,
      "write_to_file",
      {
        TargetFile: "/config/permission-settings-alias",
        Overwrite: true,
        CodeContent: "{\"compromised_alias\":true}\n",
        Description: "resolved-target settings deny canary",
        toolSummary: "resolved-target settings deny canary",
        toolAction: "resolved-target settings deny canary",
      },
      "settings-alias",
    )) return;
    if (state === "await_sensitive_alias_deny" && callWhenAdvertised(
      response,
      names,
      "run_command",
      {
        CommandLine:
          "cat /config/permission-oauth-alias; cat /config/permission-cloud-auth-alias",
        Cwd: "/config",
        Blocking: true,
        WaitMsBeforeAsync: 0,
        explanation: "Exercise resolved-target OAuth and cloud-auth AppArmor boundaries.",
      },
      "sensitive-alias",
    )) return;
    if (state === "await_mcp" && callWhenAdvertised(
      response,
      names,
      "call_mcp_tool",
      {
        ServerName: "ha_change",
        ToolName: "ha_change_propose",
        Arguments: { value: "MCP_PERMISSION_CANARY_OK" },
        toolAction: "Prepare a synthetic Home Assistant change proposal",
        toolSummary: "Synthetic Home Assistant proposal metadata canary",
      },
      "mcp",
    )) return;
    if (state === "complete") {
      sendEvent(response, { text: "PERMISSION_CANARY_DONE" });
      return;
    }
    // Native 1.1.13 emits tool-less checkpoint requests between tool calls.
    // Do not advance until the matching functionResponse is present.
    sendEvent(response, { text: "PERMISSION_CANARY_WAITING_FOR_TOOL_RESPONSE" });
  });
});

server.listen(18788, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ kind: "ready" })}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
