import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  HA_READ_MAX_RESPONSE_BYTES,
  HA_READ_MAX_MEMORY_RESPONSE_BYTES,
  HaReadError,
  haReadResponseLimit,
  sendHaReadRequest,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-read-client.mjs";
import {
  HaReadBroker,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-read-broker.mjs";
import {
  createHaReadMcpHandler,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-read-mcp.mjs";
import {
  fetchHomeAssistantSnapshot,
  HomeAssistantUnavailableError,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-memory-ha-client.mjs";
import {
  createHaValidateMcpHandler,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-validate-mcp.mjs";

const TOKEN = "SUPERVISOR_READ_BROKER_CANARY_98f2";

function syntheticJwt(signature) {
  return ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ1c2VyIn0", signature].join(".");
}

function response(status, value, { raw = false } = {}) {
  const body = raw ? String(value) : JSON.stringify(value);
  return { status, body: Readable.from([Buffer.from(body)]) };
}

function fixtureFetch(calls) {
  return async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.redirect, "error");
    calls.push({ url, options });
    if (url.endsWith("/config")) {
      return response(200, {
        version: "2026.8.0",
        location_name: "Fixture Home",
        time_zone: "Asia/Seoul",
        latitude: 37.123,
        longitude: 127.456,
        internal_url: "https://secret.invalid",
        whitelist_external_dirs: ["/config", "/media/private"],
      });
    }
    if (url.endsWith("/states/light.kitchen")) {
      return response(200, {
        entity_id: "light.kitchen",
        state: "on",
        attributes: {
          friendly_name: "Kitchen",
          brightness: 128,
          access_token: "must-not-leak",
        },
        last_changed: "2026-08-11T00:00:00Z",
        last_updated: "2026-08-11T00:00:01Z",
      });
    }
    if (url.endsWith("/states")) {
      return response(200, [
        { entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen" } },
        { entity_id: "light.hall", state: "off", attributes: { friendly_name: "Hall" } },
        { entity_id: "sensor.outdoor", state: "21", attributes: { unit_of_measurement: "°C" } },
      ]);
    }
    if (url.endsWith("/services")) {
      return response(200, [
        { domain: "light", services: { turn_on: { fields: { secret: "ignored" } }, turn_off: {} } },
        { domain: "switch", services: { turn_on: {} } },
      ]);
    }
    if (url.endsWith("/core/info")) {
      return response(200, { result: "ok", data: {
        version: "2026.8.0",
        arch: "amd64",
        state: "started",
        audio_input: "private-device",
      } });
    }
    if (url.endsWith("/supervisor/info")) {
      return response(200, { result: "ok", data: {
        version: "2026.08.0",
        channel: "stable",
        healthy: true,
        addons: [{ slug: "private" }],
      } });
    }
    if (url.endsWith("/core/logs")) {
      return response(200, [
        "ordinary line",
        `Authorization: Bearer ${TOKEN}`,
        "password=do-not-return",
        "final line",
      ].join("\n"), { raw: true });
    }
    if (url.endsWith("/addons/self/logs")) {
      return response(200, [
        "App started",
        `token=${TOKEN}`,
        "App ready",
      ].join("\n"), { raw: true });
    }
    if (url.includes("/history/period/")) {
      return response(200, [[
        {
          entity_id: "light.kitchen",
          state: "off",
          attributes: { friendly_name: "Kitchen", brightness: 0 },
          last_changed: "2026-08-10T23:00:00Z",
        },
        {
          state: "on",
          last_changed: "2026-08-11T00:00:00Z",
        },
      ]]);
    }
    return response(404, { result: "error" });
  };
}

test("broker exposes only bounded projected GET reads", async () => {
  const calls = [];
  const webSocketCalls = [];
  const broker = new HaReadBroker({
    supervisorToken: TOKEN,
    fetchImpl: fixtureFetch(calls),
    now: () => Date.parse("2026-08-11T01:00:00Z"),
    webSocketReader: async (command, options) => {
      assert.equal(options.token, TOKEN);
      assert.equal(options.url, "ws://supervisor/core/websocket");
      webSocketCalls.push(command);
      if (command.type === "config/area_registry/list") {
        return [
          { area_id: "kitchen", name: "Kitchen", floor_id: "ground", aliases: ["secret"] },
          { area_id: "hall", name: "Hall" },
        ];
      }
      if (command.type === "trace/list") {
        return [{
          domain: "automation",
          item_id: "night_lights",
          run_id: "run_1",
          state: "stopped",
          script_execution: "finished",
          last_step: "action/0",
          timestamp: { start: "2026-08-11T00:00:00Z", finish: "2026-08-11T00:00:01Z" },
          error: `Bearer ${TOKEN}`,
        }];
      }
      if (command.type === "trace/get") {
        return {
          domain: "automation",
          item_id: "night_lights",
          run_id: "run_1",
          state: "stopped",
          script_execution: "error",
          last_step: "action/1",
          timestamp: { start: "2026-08-11T00:00:00Z", finish: "2026-08-11T00:00:01Z" },
          error: `password=hidden ${TOKEN}`,
          config: { action: [{ service: "notify.secret" }] },
          context: { user_id: "private" },
          trace: {
            "action/0": [{ result: { secret: "not-returned" } }],
            "action/1": [{ error: "private error", result: { token: TOKEN } }],
          },
        };
      }
      throw new Error(`unexpected WebSocket command: ${command.type}`);
    },
  });

  const config = await broker.dispatch("config", {});
  assert.equal(config.version, "2026.8.0");
  assert.equal(config.location_name, "Fixture Home");
  assert.equal(Object.hasOwn(config, "latitude"), false);
  assert.equal(Object.hasOwn(config, "whitelist_external_dirs"), false);
  assert.equal(JSON.stringify(config).includes("secret.invalid"), false);

  const exact = await broker.dispatch("state", { entity_id: "light.kitchen" });
  assert.deepEqual(exact.attributes, { friendly_name: "Kitchen" });
  assert.equal(JSON.stringify(exact).includes("must-not-leak"), false);

  const states = await broker.dispatch("states", { domain: "light", query: "kit", limit: 1 });
  assert.deepEqual(states.map((item) => item.entity_id), ["light.kitchen"]);
  const services = await broker.dispatch("services", { domain: "light", limit: 10 });
  assert.deepEqual(services, [
    { domain: "light", service: "turn_off" },
    { domain: "light", service: "turn_on" },
  ]);
  assert.deepEqual(await broker.dispatch("core_info", {}), {
    arch: "amd64",
    state: "started",
    version: "2026.8.0",
  });
  assert.deepEqual(await broker.dispatch("supervisor_info", {}), {
    channel: "stable",
    healthy: true,
    version: "2026.08.0",
  });
  const logs = await broker.dispatch("core_logs", { lines: 3 });
  assert.equal(logs.lines.length, 3);
  assert.equal(JSON.stringify(logs).includes(TOKEN), false);
  assert.equal(JSON.stringify(logs).includes("do-not-return"), false);
  const appLogs = await broker.dispatch("app_logs", { lines: 3 });
  assert.equal(JSON.stringify(appLogs).includes(TOKEN), false);

  const registry = await broker.dispatch("registry", {
    kind: "area",
    query: "kit",
    limit: 1,
  });
  assert.deepEqual(registry, {
    kind: "area",
    entries: [{ area_id: "kitchen", floor_id: "ground", name: "Kitchen" }],
    truncated: false,
  });
  const history = await broker.dispatch("history", {
    entity_id: "light.kitchen",
    hours: 2,
    limit: 1,
  });
  assert.equal(history.states.length, 1);
  assert.equal(history.states[0].entity_id, "light.kitchen");
  assert.equal(history.states[0].state, "on");
  assert.equal(history.truncated, true);

  const traces = await broker.dispatch("traces", {
    domain: "automation",
    item_id: "night_lights",
    limit: 10,
  });
  assert.equal(traces.traces.length, 1);
  assert.equal(JSON.stringify(traces).includes(TOKEN), false);
  const trace = await broker.dispatch("traces", {
    domain: "automation",
    item_id: "night_lights",
    run_id: "run_1",
  });
  assert.deepEqual(trace.steps, [
    { path: "action/0", events: 1, error: false },
    { path: "action/1", events: 1, error: true },
  ]);
  assert.equal(Object.hasOwn(trace, "config"), false);
  assert.equal(Object.hasOwn(trace, "context"), false);
  assert.equal(JSON.stringify(trace).includes("not-returned"), false);
  assert.equal(JSON.stringify(trace).includes(TOKEN), false);
  assert.deepEqual(webSocketCalls.map((command) => command.type), [
    "config/area_registry/list",
    "trace/list",
    "trace/get",
  ]);
  assert.equal(calls.every((call) => call.options.method === "GET"), true);
  assert.equal(calls.every((call) => !Object.hasOwn(call.options, "body")), true);
});

test("log reads fail closed for structured credentials and multiline private material", async () => {
  const canaries = [
    "JSON_SECRET_CANARY",
    "BASIC_SECRET_CANARY",
    "URL_PASSWORD_CANARY",
    "PRIVATE_KEY_CANARY",
    "CONTINUATION_SECRET_CANARY",
    "JWT_SIGNATURE_CANARY",
  ];
  const body = [
    "ordinary before",
    '{"token":"JSON_SECRET_CANARY"}',
    "Authorization: Basic BASIC_SECRET_CANARY",
    "callback=https://user:URL_PASSWORD_CANARY@example.invalid/path",
    "-----BEGIN PRIVATE KEY-----",
    "PRIVATE_KEY_CANARY",
    "-----END PRIVATE KEY-----",
    '"password":',
    '  "CONTINUATION_SECRET_CANARY"',
    `session=${syntheticJwt("JWT_SIGNATURE_CANARY")}`,
    "ordinary after",
  ].join("\n");
  const broker = new HaReadBroker({
    supervisorToken: TOKEN,
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://supervisor/core/logs");
      assert.equal(options.redirect, "error");
      return response(200, body, { raw: true });
    },
  });

  const logs = await broker.dispatch("core_logs", { lines: 50 });
  const serialized = JSON.stringify(logs);
  for (const canary of canaries) assert.equal(serialized.includes(canary), false);
  assert.equal(logs.lines.includes("ordinary before"), true);
  assert.equal(logs.lines.includes("ordinary after"), true);
  assert(logs.lines.filter((line) => line === "[REDACTED_SENSITIVE_LOG_LINE]").length >= 9);
});

test("state reads redact bounded credential signals without hiding ordinary diagnostics", async () => {
  const sensitiveStates = [
    {
      entity_id: "sensor.api_token",
      state: "ENTITY_SUBJECT_CANARY",
      attributes: { friendly_name: "API token fixture", access_token: "ATTRIBUTE_KEY_CANARY" },
    },
    {
      entity_id: "sensor.bearer_fixture",
      state: "Bearer STATE_BEARER_CANARY",
      attributes: { friendly_name: "Bearer ATTRIBUTE_VALUE_CANARY" },
    },
    {
      entity_id: "sensor.url_fixture",
      state: "https://operator:URL_CREDENTIAL_CANARY@example.invalid/path",
      attributes: {},
    },
    {
      entity_id: "sensor.jwt_fixture",
      state: syntheticJwt("JWT_STATE_CANARY"),
      attributes: {},
    },
    {
      entity_id: "sensor.private_key_fixture",
      state: "-----BEGIN PRIVATE KEY----- PRIVATE_KEY_STATE_CANARY",
      attributes: {},
    },
    {
      entity_id: "sensor.supervisor_fixture",
      state: `prefix-${TOKEN}-suffix`,
      attributes: {},
    },
    {
      entity_id: "sensor.temperature",
      state: "21.5",
      attributes: { friendly_name: "Room temperature", unit_of_measurement: "°C" },
    },
  ];
  const broker = new HaReadBroker({
    supervisorToken: TOKEN,
    fetchImpl: async (url) => {
      assert.equal(url, "http://supervisor/core/api/states");
      return response(200, sensitiveStates);
    },
  });

  const states = await broker.dispatch("states", { limit: 20 });
  const serialized = JSON.stringify(states);
  for (const canary of [
    "ENTITY_SUBJECT_CANARY",
    "ATTRIBUTE_KEY_CANARY",
    "STATE_BEARER_CANARY",
    "ATTRIBUTE_VALUE_CANARY",
    "URL_CREDENTIAL_CANARY",
    "JWT_STATE_CANARY",
    "PRIVATE_KEY_STATE_CANARY",
    TOKEN,
  ]) {
    assert.equal(serialized.includes(canary), false);
  }
  for (const state of states.slice(0, 6)) {
    assert.equal(state.state, "[REDACTED_SENSITIVE_STATE]");
  }
  assert.equal(Object.hasOwn(states[0].attributes, "access_token"), false);
  assert.equal(
    states[1].attributes.friendly_name,
    "[REDACTED_SENSITIVE_STATE]",
  );
  assert.deepEqual(states.at(-1), {
    entity_id: "sensor.temperature",
    state: "21.5",
    attributes: {
      friendly_name: "Room temperature",
      unit_of_measurement: "°C",
    },
    last_changed: null,
    last_updated: null,
  });
});

test("broker request validation and upstream cap fail closed", async () => {
  const broker = new HaReadBroker({ supervisorToken: TOKEN, fetchImpl: async () =>
    ({ status: 200, body: Readable.from([Buffer.alloc(HA_READ_MAX_RESPONSE_BYTES + 1)]) }) });
  await assert.rejects(
    broker.dispatch("state", { entity_id: "light.kitchen/../../config" }),
    (error) => error instanceof HaReadError && error.code === "invalid_request",
  );
  await assert.rejects(
    broker.dispatch("states", { limit: 101 }),
    (error) => error instanceof HaReadError && error.code === "invalid_request",
  );
  await assert.rejects(
    broker.dispatch("history", { entity_id: "light.kitchen", hours: 169 }),
    (error) => error instanceof HaReadError && error.code === "invalid_request",
  );
  await assert.rejects(
    broker.dispatch("traces", { domain: "automation", run_id: "run_1" }),
    (error) => error instanceof HaReadError && error.code === "invalid_request",
  );
  await assert.rejects(
    broker.dispatch("service_call", {}),
    (error) => error instanceof HaReadError && error.code === "unsupported_action",
  );
  await assert.rejects(
    broker.dispatch("config", { path: "/secrets.yaml" }),
    (error) => error instanceof HaReadError && error.code === "invalid_request",
  );
  await assert.rejects(
    broker.dispatch("config", {}),
    (error) => error instanceof HaReadError && error.code === "upstream_too_large",
  );
});

test("memory snapshot is an internal fixed-transport broker action", async () => {
  let received;
  const snapshot = {
    haVersion: "2026.8.0",
    areas: [],
    devices: [],
    entities: [],
    states: [],
    automations: {},
    warnings: [],
  };
  const broker = new HaReadBroker({
    supervisorToken: TOKEN,
    fetchImpl: fixtureFetch([]),
    memorySnapshotFetcher: async (options) => {
      received = options;
      return snapshot;
    },
  });
  assert.deepEqual(await broker.dispatch("memory_snapshot", {}), snapshot);
  assert.deepEqual(received, {
    url: "ws://supervisor/core/websocket",
    token: TOKEN,
    timeoutMs: 10_000,
  });
  await assert.rejects(
    broker.dispatch("memory_snapshot", { url: "ws://attacker.invalid" }),
    (error) => error instanceof HaReadError && error.code === "invalid_request",
  );
});

test("public reads remain at 1 MiB while memory snapshots have a bounded 32 MiB ceiling", async () => {
  assert.equal(haReadResponseLimit("config"), HA_READ_MAX_RESPONSE_BYTES);
  assert.equal(
    haReadResponseLimit("memory_snapshot"),
    HA_READ_MAX_MEMORY_RESPONSE_BYTES,
  );

  const root = await mkdtemp(join(tmpdir(), "ha-read-limits-"));
  const runRoot = join(root, "run");
  const memorySocketPath = join(runRoot, "memory.sock");
  const publicSocketPath = join(runRoot, "public.sock");
  await mkdir(runRoot, { mode: 0o700 });
  await chmod(runRoot, 0o700);
  const largeMemoryValue = "m".repeat(HA_READ_MAX_RESPONSE_BYTES + 8192);
  const broker = new HaReadBroker({
    socketPath: memorySocketPath,
    supervisorToken: TOKEN,
    fetchImpl: fixtureFetch([]),
    requiredUid: process.getuid(),
    memorySnapshotFetcher: async () => ({ largeMemoryValue }),
  });
  const publicServer = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end(`${JSON.stringify({
        ok: true,
        result: "p".repeat(HA_READ_MAX_RESPONSE_BYTES + 1),
      })}\n`);
    });
  });
  try {
    await broker.start();
    const memoryResult = await sendHaReadRequest(
      "memory_snapshot",
      {},
      { socketPath: memorySocketPath, timeoutMs: 30_000 },
    );
    assert.equal(memoryResult.largeMemoryValue.length, largeMemoryValue.length);

    await new Promise((resolve, reject) => {
      publicServer.once("error", reject);
      publicServer.listen(publicSocketPath, resolve);
    });
    await assert.rejects(
      sendHaReadRequest("config", {}, { socketPath: publicSocketPath }),
      (error) => error instanceof HaReadError && error.code === "response_too_large",
    );
  } finally {
    await broker.close();
    await new Promise((resolve) => publicServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("Unix socket client receives one response without receiving the credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "ha-read-broker-"));
  const runRoot = join(root, "run");
  const socketPath = join(runRoot, "ha-read.sock");
  await mkdir(runRoot, { mode: 0o700 });
  await chmod(runRoot, 0o700);
  const broker = new HaReadBroker({
    socketPath,
    supervisorToken: TOKEN,
    fetchImpl: fixtureFetch([]),
    requiredUid: process.getuid(),
  });
  try {
    await broker.start();
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    const result = await sendHaReadRequest("state", { entity_id: "light.kitchen" }, { socketPath });
    assert.equal(result.entity_id, "light.kitchen");
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    await assert.rejects(
      sendHaReadRequest("service_call", {}, { socketPath }),
      (error) => error instanceof HaReadError && error.code === "unsupported_action",
    );
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary reads, memory snapshots, and state validation share one broker failure boundary", async () => {
  const actions = [];
  const brokerRequest = async (action, payload) => {
    actions.push({ action, payload });
    throw new HaReadError("ha_timeout", "injected shared read-broker timeout");
  };
  const readHandler = createHaReadMcpHandler({ brokerRequest });
  const validateHandler = createHaValidateMcpHandler({ brokerRequest });

  const read = await readHandler({
    jsonrpc: "2.0",
    id: 101,
    method: "tools/call",
    params: {
      name: "ha_read_state",
      arguments: { entity_id: "light.kitchen" },
    },
  });
  assert.equal(read.result.isError, true);
  assert.equal(read.result.structuredContent.error, "ha_timeout");

  const validation = await validateHandler({
    jsonrpc: "2.0",
    id: 102,
    method: "tools/call",
    params: {
      name: "ha_verify_state",
      arguments: { entity_id: "light.kitchen", expected_state: "on" },
    },
  });
  assert.equal(validation.result.isError, true);
  assert.equal(validation.result.structuredContent.error, "ha_timeout");

  await assert.rejects(
    fetchHomeAssistantSnapshot({ brokerRequest }),
    (error) => error instanceof HomeAssistantUnavailableError && error.code === "ha_timeout",
  );
  assert.deepEqual(actions, [
    { action: "state", payload: { entity_id: "light.kitchen" } },
    { action: "state", payload: { entity_id: "light.kitchen" } },
    { action: "memory_snapshot", payload: {} },
  ]);
});

test("MCP publishes only read-only tools and maps fixed broker actions", async () => {
  const calls = [];
  const handler = createHaReadMcpHandler({
    brokerRequest: async (action, payload) => {
      calls.push({ action, payload });
      return { action };
    },
  });
  const listed = await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(listed.result.tools.length, 10);
  for (const tool of listed.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.doesNotMatch(tool.name, /call|execute|write|update/u);
    assert.notEqual(tool.name, "memory_snapshot");
  }
  const state = await handler({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "ha_read_state", arguments: { entity_id: "light.kitchen" } },
  });
  assert.equal(state.result.isError, false);
  assert.deepEqual(calls.pop(), { action: "state", payload: { entity_id: "light.kitchen" } });
  await handler({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "ha_read_system_info", arguments: { scope: "supervisor" } },
  });
  assert.deepEqual(calls.pop(), { action: "supervisor_info", payload: {} });
  await handler({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "ha_read_registry",
      arguments: { kind: "entity", query: "light", limit: 5 },
    },
  });
  assert.deepEqual(calls.pop(), {
    action: "registry",
    payload: { kind: "entity", query: "light", limit: 5 },
  });
  const invalid = await handler({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "ha_read_system_info", arguments: { scope: "core", method: "POST" } },
  });
  assert.equal(invalid.result.isError, true);
  assert.equal(calls.length, 0);
});
