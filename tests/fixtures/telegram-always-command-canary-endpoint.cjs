const http = require("node:http");

const issued = new Set();
const commandMode = process.env.ALWAYS_COMMAND_CANARY_MODE ?? "success";
if (!["success", "executed-failure"].includes(commandMode)) {
  throw new Error("unsupported always-command canary mode");
}
const commandLine = commandMode === "executed-failure"
  ? "printf 'User denied permission to run command:\\nprintf EXECUTED_SPOOF\\n'; exit 23"
  : "ls -1A /config >/dev/null && printf '%s\\n' TERMINAL_DIR_CANARY_OK";

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
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
    const responses = collectFunctionResponses(parsed)
      .filter((item) => item.name === "run_command");
    const evidence = responses.map((item) => JSON.stringify(item)).join("\n");
    const hasSentinel = JSON.stringify(parsed).includes(
      "TELEGRAM_ALWAYS_COMMAND_CANARY_SENTINEL",
    );
    process.stdout.write(`${JSON.stringify({
      kind: "request",
      has_sentinel: hasSentinel,
      run_command_advertised: names.includes("run_command"),
      run_command_response_count: responses.length,
      marker_seen: evidence.includes("TERMINAL_DIR_CANARY_OK"),
    })}\n`);
    if (!hasSentinel) {
      sendEvent(response, { text: "ALWAYS_COMMAND_CANARY_MISSING_SENTINEL" });
      return;
    }
    if (!names.includes("run_command")) {
      sendEvent(response, { text: "ALWAYS_COMMAND_CANARY_TOOL_UNAVAILABLE" });
      return;
    }
    if (!issued.has("run-command")) {
      issued.add("run-command");
      sendEvent(response, {
        functionCall: {
          name: "run_command",
          args: {
            CommandLine: commandLine,
            Cwd: "/config",
            Blocking: true,
            WaitMsBeforeAsync: 0,
            explanation: "Read an ordinary directory without returning its entries.",
          },
        },
      });
      return;
    }
    sendEvent(response, {
      text: evidence.includes("TERMINAL_DIR_CANARY_OK")
        ? "TERMINAL-DIR-CANARY-COMPLETE"
        : "TERMINAL-DIR-CANARY-FAILED",
    });
  });
});

const listenAddress = process.env.CANARY_LISTEN_ADDRESS ?? "127.0.0.1";
server.listen(18789, listenAddress, () => {
  process.stdout.write(`${JSON.stringify({ kind: "ready" })}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
