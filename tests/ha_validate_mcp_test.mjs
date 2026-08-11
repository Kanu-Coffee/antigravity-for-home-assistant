import assert from "node:assert/strict";
import test from "node:test";

import {
  createHaValidateMcpHandler,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-validate-mcp.mjs";

test("validation MCP exposes only two read-only fixed tools", async () => {
  const handler = createHaValidateMcpHandler();
  const response = await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(response.result.tools.map((tool) => tool.name), [
    "ha_validate_config",
    "ha_verify_state",
  ]);
  for (const tool of response.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
  }
});

test("configuration validation uses only the injected fixed checker", async () => {
  let calls = 0;
  const handler = createHaValidateMcpHandler({
    configCheck: async () => {
      calls += 1;
      return { valid: true, exit_code: 0, checked_at: "2026-08-11T01:00:00Z", output: "ok" };
    },
  });
  const response = await handler({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "ha_validate_config", arguments: {} },
  });
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.result.valid, true);
  assert.equal(calls, 1);

  const invalid = await handler({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "ha_validate_config", arguments: { reload: true } },
  });
  assert.equal(invalid.result.isError, true);
  assert.equal(calls, 1);
});

test("fresh state verification compares state and lower timestamp bound", async () => {
  const calls = [];
  const handler = createHaValidateMcpHandler({
    now: () => new Date("2026-08-11T01:00:02Z"),
    brokerRequest: async (action, payload) => {
      calls.push({ action, payload });
      return {
        entity_id: payload.entity_id,
        state: "on",
        last_changed: "2026-08-11T01:00:00Z",
        last_updated: "2026-08-11T01:00:01Z",
      };
    },
  });
  const verified = await handler({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "ha_verify_state",
      arguments: {
        entity_id: "input_boolean.fixture",
        expected_state: "on",
        not_before: "2026-08-11T01:00:00Z",
      },
    },
  });
  assert.equal(verified.result.structuredContent.result.verified, true);
  assert.deepEqual(calls, [{
    action: "state",
    payload: { entity_id: "input_boolean.fixture" },
  }]);

  const stale = await handler({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "ha_verify_state",
      arguments: {
        entity_id: "input_boolean.fixture",
        expected_state: "on",
        not_before: "2026-08-11T01:00:02Z",
      },
    },
  });
  assert.equal(stale.result.structuredContent.result.matches_state, true);
  assert.equal(stale.result.structuredContent.result.fresh_enough, false);
  assert.equal(stale.result.structuredContent.result.verified, false);

  const invalid = await handler({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "ha_verify_state",
      arguments: { entity_id: "light.bad/path", expected_state: "on" },
    },
  });
  assert.equal(invalid.result.isError, true);
  assert.equal(calls.length, 2);
});
