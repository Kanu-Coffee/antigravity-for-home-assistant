import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";

import {
  canonicalTelegramPermissionRules,
  nativeCanonicalSettingsContent,
} from "/usr/local/share/antigravity-ha/telegram-permission-policy.mjs";
import {
  TelegramActionCoordinator,
} from "/usr/local/share/antigravity-ha/telegram-action-coordinator.mjs";
import {
  parseStreamResult,
} from "/usr/local/share/antigravity-ha/telegram-bridge.mjs";

const EXPECTED_VERSION = process.env.EXPECTED_VERSION;
const SYNTHETIC_PORT = 18_791;
const SYNTHETIC_BASE_URL = `http://127.0.0.1:${SYNTHETIC_PORT}`;
const WARMUP_SENTINEL = "TELEGRAM_ACTION_NATIVE_WARMUP_SENTINEL";
const PROPOSAL_SENTINEL = "TELEGRAM_ACTION_NATIVE_PROPOSAL_SENTINEL";
const WARMUP_MODEL_TEXT = "TELEGRAM_ACTION_NATIVE_WARMUP_OK";
const WARMUP_RESPONSE = `${WARMUP_MODEL_TEXT}\n`;
const TERMINAL_MODEL_TEXT = "TELEGRAM_ACTION_NATIVE_VALID_CONTROL_OK";
const TERMINAL_RESPONSE = "TELEGRAM_ACTION_NATIVE_VALID_CONTROL_OK\n";
const USER_ID = "123456789";
const CHAT_ID = "-100123456789";
const SESSION_GENERATION = 7;
const WARMUP_UPDATE_ID = 77;
const PROPOSAL_UPDATE_ID = 78;

assert.match(EXPECTED_VERSION ?? "", /^\d+\.\d+\.\d+$/u);

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

function functionDeclarationNames(value) {
  if (!Array.isArray(value?.tools)) return [];
  return value.tools.flatMap((tool) =>
    tool?.functionDeclarations ?? tool?.function_declarations ?? [])
    .map((declaration) => declaration?.name)
    .filter((name) => typeof name === "string");
}

function sendJson(response, value) {
  const payload = JSON.stringify(value);
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendModelEvent(response, part) {
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

function createSyntheticEndpoint() {
  let proposalCallIssued = false;
  const observations = {
    proposalToolAdvertised: false,
    proposalResultReturned: false,
  };
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      const pathname = new URL(request.url, SYNTHETIC_BASE_URL).pathname;
      if (pathname.includes("countTokens")) {
        sendJson(response, { totalTokens: 1 });
        return;
      }
      const serialized = JSON.stringify(parsed);
      const declarationNames = functionDeclarationNames(parsed);
      const functionResponses = collectFunctionResponses(parsed);
      const responseEvidence = JSON.stringify(functionResponses);
      if (serialized.includes(PROPOSAL_SENTINEL) &&
          declarationNames.includes("call_mcp_tool")) {
        observations.proposalToolAdvertised = true;
        if (!proposalCallIssued) {
          proposalCallIssued = true;
          sendModelEvent(response, {
            functionCall: {
              name: "call_mcp_tool",
              args: {
                ServerName: "telegram_action",
                ToolName: "telegram_action_propose",
                Arguments: {
                  operation: "terminal_command",
                  summary: "Synthetic read-only directory proposal",
                  payload: {
                    command:
                      "ls -1A /config >/dev/null && printf 'TERMINAL-DIR-OK\\n'",
                    cwd: "/config",
                  },
                },
                toolAction: "Register approval card",
                toolSummary: "Prepared terminal proposal",
              },
            },
          });
          return;
        }
      }
      if (responseEvidence.includes("proposal_id") &&
          responseEvidence.includes("request_digest")) {
        observations.proposalResultReturned = true;
        sendModelEvent(response, { text: TERMINAL_MODEL_TEXT });
        return;
      }
      if (serialized.includes(WARMUP_SENTINEL)) {
        sendModelEvent(response, { text: WARMUP_MODEL_TEXT });
        return;
      }
      sendModelEvent(response, { text: "TELEGRAM_ACTION_NATIVE_WAITING\n" });
    });
  });
  return { server, observations };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SYNTHETIC_PORT, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

async function runNative(prompt, environment, conversationId = null) {
  const args = [
    "--output-format",
    "stream-json",
    "--print-timeout",
    "20s",
    "--disable-slash-commands",
  ];
  if (conversationId !== null) args.push("--conversation", conversationId);
  const child = spawn("/usr/local/libexec/antigravity-real", args, {
    cwd: "/config",
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(`${prompt}\n`);
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  assert.deepEqual(exit, { code: 0, signal: null }, `native stderr: ${stderr}`);
  assert.equal(stderr, "");
  return stdout;
}

function prepareNativeHome() {
  mkdirSync("/data/home/.gemini/antigravity-cli", {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync("/data/home/.gemini/config", { recursive: true, mode: 0o700 });
  mkdirSync("/config", { recursive: true, mode: 0o755 });
  const settings = JSON.parse(readFileSync("/etc/antigravity/settings.json", "utf8"));
  settings.modelProvider = "gemini";
  settings.permissions = canonicalTelegramPermissionRules("request-review");
  writeFileSync(
    "/data/home/.gemini/antigravity-cli/settings.json",
    nativeCanonicalSettingsContent(settings, "request-review"),
    { mode: 0o600 },
  );
  writeFileSync(
    "/data/home/.gemini/config/mcp_config.json",
    JSON.stringify({
      mcpServers: {
        telegram_action: {
          command: "/usr/local/bin/telegram-action-proposal-mcp",
          args: [],
        },
      },
    }),
    { mode: 0o600 },
  );
}

const { server, observations } = createSyntheticEndpoint();
const coordinator = new TelegramActionCoordinator();
let runBinding = null;
try {
  prepareNativeHome();
  await listen(server);
  await coordinator.start();
  const nativeVersion = await new Promise((resolve, reject) => {
    const child = spawn("/usr/local/libexec/antigravity-real", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve(output.trim())
      : reject(new Error(`native version exited ${code}`)));
  });
  assert.equal(nativeVersion, EXPECTED_VERSION);

  const commonEnvironment = {
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    ANTIGRAVITY_HA_CHANNEL: "telegram",
    GEMINI_API_KEY: "synthetic-telegram-action-control",
    GOOGLE_GEMINI_BASE_URL: SYNTHETIC_BASE_URL,
    HOME: "/data/home",
    HA_TELEGRAM_USER_ID: USER_ID,
    HA_TELEGRAM_CHAT_ID: CHAT_ID,
    HA_TELEGRAM_SESSION_GENERATION: String(SESSION_GENERATION),
    HA_TELEGRAM_ACTION_PROPOSAL_SOCKET: coordinator.socketPath,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    TERM: "dumb",
    NO_COLOR: "1",
  };
  const warmupStream = await runNative(WARMUP_SENTINEL, {
    ...commonEnvironment,
    HA_TELEGRAM_UPDATE_ID: String(WARMUP_UPDATE_ID),
    HA_TELEGRAM_RUN_NONCE: "warmup-run-nonce-1234567890",
  });
  const warmup = parseStreamResult(warmupStream);
  assert.equal(warmup.response, WARMUP_RESPONSE);
  assert.equal(warmup.proposalIds.length, 0);

  runBinding = coordinator.beginRun({
    user_id: USER_ID,
    chat_id: CHAT_ID,
    session_generation: SESSION_GENERATION,
    update_id: PROPOSAL_UPDATE_ID,
    conversation_id: warmup.conversationId,
  });
  const proposalStream = await runNative(PROPOSAL_SENTINEL, {
    ...commonEnvironment,
    HA_TELEGRAM_UPDATE_ID: String(PROPOSAL_UPDATE_ID),
    HA_TELEGRAM_RUN_NONCE: runBinding.run_nonce,
    HA_ANTIGRAVITY_CONVERSATION_ID: warmup.conversationId,
  }, warmup.conversationId);
  const events = proposalStream.trim().split("\n").map(JSON.parse);
  const terminalEvents = events.filter((event) => event.event === "result");
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].result.status, "SUCCESS");
  assert.equal(terminalEvents[0].result.response, TERMINAL_RESPONSE);
  const toolSteps = events
    .filter((event) => event.event === "step_update" &&
      event.step_update?.step_type === "tool")
    .map((event) => event.step_update);
  assert.equal(toolSteps.length, 2);
  assert.deepEqual(toolSteps.map((step) => step.state), ["ACTIVE", "DONE"]);
  assert.equal(toolSteps[0].step_index, toolSteps[1].step_index);
  assert.ok(Number.isSafeInteger(toolSteps[0].step_index));
  for (const step of toolSteps) {
    assert.equal(step.tool_name, "call_mcp_tool");
    assert.equal(step.tool_info.name, "call_mcp_tool");
    assert.deepEqual(Object.keys(step.tool_info.parameters).sort(), [
      "Arguments",
      "ServerName",
      "ToolName",
    ]);
    assert.equal(step.tool_info.parameters.ServerName, "telegram_action");
    assert.equal(step.tool_info.parameters.ToolName, "telegram_action_propose");
  }
  assert.equal(Object.hasOwn(toolSteps[0].tool_info, "output"), false);
  assert.equal(typeof toolSteps[1].tool_info.output, "string");
  const nativeOutput = JSON.parse(toolSteps[1].tool_info.output);
  assert.deepEqual(Object.keys(nativeOutput).sort(), [
    "preview",
    "proposal_id",
    "request_digest",
  ]);
  assert.match(nativeOutput.proposal_id, /^ta_[A-Za-z0-9_-]{20,48}$/u);
  assert.match(nativeOutput.request_digest, /^sha256:[a-f0-9]{64}$/u);

  const parsed = parseStreamResult(proposalStream);
  assert.equal(parsed.response, TERMINAL_RESPONSE);
  assert.equal(parsed.conversationId, warmup.conversationId);
  assert.deepEqual(parsed.proposalIds, [nativeOutput.proposal_id]);
  assert.equal(parsed.proposalKind, "telegram_action");
  assert.equal(parsed.proposalReceipts.length, 1);
  const receipt = parsed.proposalReceipts[0];
  assert.equal(receipt.proposalId, nativeOutput.proposal_id);
  assert.equal(receipt.requestDigest, nativeOutput.request_digest);
  assert.equal(receipt.stepIndex, toolSteps[0].step_index);

  const registered = coordinator.getProposal(receipt.proposalId, {
    run_nonce: runBinding.run_nonce,
  });
  assert.ok(registered);
  assert.equal(registered.proposal.request_digest, receipt.requestDigest);
  assert.deepEqual(registered.proposal.binding, runBinding);
  assert.equal(observations.proposalToolAdvertised, true);
  assert.equal(observations.proposalResultReturned, true);
  assert.equal(toolSteps.some((step) => step.tool_name === "run_command"), false);
  process.stdout.write(
    `telegram action native valid control passed for Antigravity ${nativeVersion}\n`,
  );
} finally {
  if (runBinding !== null) coordinator.finishRun(runBinding.run_nonce);
  await coordinator.close();
  if (server.listening) await closeServer(server);
}
