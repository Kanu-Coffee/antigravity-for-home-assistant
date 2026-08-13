#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(scriptDirectory, "ha-memory-mcp");
const child = spawn(server, [], {
  cwd: path.resolve(scriptDirectory, "../.."),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

const labels = new Map([
  [1, "initialize"],
  [2, "tools/list"],
  [3, "memory_search"],
  [4, "memory_status"],
]);
const pending = new Map();
let stderr = "";
let protocolFailure;

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
});

function failProtocol(message) {
  if (protocolFailure) return;
  protocolFailure = new Error(message);
  for (const { reject } of pending.values()) reject(protocolFailure);
  pending.clear();
  child.kill("SIGTERM");
}

const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    failProtocol("memory MCP returned an unexpected non-JSON line");
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter || !labels.has(message.id)) {
    failProtocol("memory MCP response ID mismatch or duplicate response");
    return;
  }
  pending.delete(message.id);
  if (message.error || !Object.hasOwn(message, "result")) {
    waiter.reject(new Error(`${labels.get(message.id)} failed`));
    return;
  }
  waiter.resolve(message.result);
});

function request(id, method, params = {}) {
  if (pending.has(id) || protocolFailure) {
    return Promise.reject(protocolFailure ?? new Error("duplicate MCP request ID"));
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function assertToolResult(result, label) {
  if (result?.isError === true) throw new Error(`${label} returned a tool-level error`);
  if (!Array.isArray(result?.content) || result.content.length === 0) {
    throw new Error(`${label} returned an unexpected empty result`);
  }
  if (!result.content.some((item) => item?.type === "text" && typeof item.text === "string")) {
    throw new Error(`${label} result content mismatch`);
  }
}

const close = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
const watchdog = setTimeout(() => failProtocol("memory MCP probe timed out"), 30_000);

try {
  const initialization = await request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "antigravity-ha-development-probe", version: "1" },
  });
  if (initialization?.serverInfo?.name !== "antigravity-ha-memory") {
    throw new Error("memory MCP server identity mismatch");
  }

  // Complete the standard MCP handshake before listing or calling tools.
  notify("notifications/initialized");
  const listed = await request(2, "tools/list");
  if (!Array.isArray(listed?.tools)) throw new Error("tools/list result mismatch");
  const advertisedNames = new Set(listed.tools.map((tool) => tool?.name));
  for (const required of ["memory_search", "memory_status"]) {
    if (!advertisedNames.has(required)) throw new Error(`required tool unavailable: ${required}`);
  }
  for (const forbidden of [
    "memory_remember_explicit",
    "memory_propose",
    "memory_apply_candidate",
    "memory_begin_change",
    "memory_verify_change",
    "memory_rollback",
  ]) {
    if (advertisedNames.has(forbidden)) {
      throw new Error(`unexpected write-capable tool advertised: ${forbidden}`);
    }
  }

  const search = await request(3, "tools/call", {
    name: "memory_search",
    arguments: { query: "development probe", limit: 1 },
  });
  assertToolResult(search, "memory_search");
  const status = await request(4, "tools/call", {
    name: "memory_status",
    arguments: {},
  });
  assertToolResult(status, "memory_status");

  child.stdin.end();
  const exitCode = await close;
  if (exitCode !== 0 || protocolFailure) {
    throw protocolFailure ?? new Error(`memory MCP exited with ${exitCode}: ${stderr.trim() || "no diagnostic"}`);
  }
  if (pending.size !== 0) throw new Error("memory MCP response count mismatch");

  process.stdout.write(
    `${JSON.stringify({
      server: initialization.serverInfo.name,
      advertised_tools: listed.tools.length,
      codex_enabled_tools: ["memory_search", "memory_status"],
      search_ok: true,
      status_ok: true,
    })}\n`,
  );
} finally {
  clearTimeout(watchdog);
  if (!child.stdin.destroyed) child.stdin.end();
}
