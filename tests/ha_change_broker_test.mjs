import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BrokerError,
  ChangeBroker,
  sendBrokerRequest,
  sha256Digest,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-change-broker.mjs";
import {
  createMcpRequestHandler,
  telegramRequesterFromEnvironment,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-change-proposal-mcp.mjs";

const REQUESTER = {
  surface: "telegram",
  user_id: "10001",
  chat_id: "-20002",
};
const TOKEN_CANARY = "SUPERVISOR_CANARY_CHANGE_BROKER_4a911";

function jsonResponse(status, value) {
  return {
    status,
    async text() {
      return value === undefined ? "" : JSON.stringify(value);
    },
  };
}

function parseFixtureInputBooleans(value) {
  const helpers = new Map();
  let current = null;
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "").trimEnd();
    if (line.trim() === "") continue;
    const helper = /^([a-z][a-z0-9_]*):$/u.exec(line);
    if (helper) {
      current = {};
      helpers.set(helper[1], current);
      continue;
    }
    const option = /^ {2}(name|icon|initial):\s*(.+)$/u.exec(line);
    assert.ok(option && current, `unsupported fixture input_boolean line: ${line}`);
    if (option[1] === "initial") current.initial = option[2] === "true";
    else current[option[1]] = option[2].replace(/^['"]|['"]$/gu, "");
  }
  return helpers;
}

function createFakeHomeAssistant({
  configRoot,
  configCheckOk = true,
  failFirstServiceMutation = false,
  serviceOutcomes = [],
  failStateReadsAfterServiceCalls = null,
} = {}) {
  const states = new Map([
    ["light.fixture", "off"],
    ["switch.water_pump", "off"],
  ]);
  const attributes = new Map([
    ["light.fixture", { ignored: "private fixture attribute" }],
    ["switch.water_pump", { ignored: "private fixture attribute" }],
  ]);
  const calls = [];
  let serviceMutationCalls = 0;
  const pendingServiceOutcomes = [...serviceOutcomes];
  const syncInputBooleans = async () => {
    let contents = "";
    try {
      contents = await readFile(join(configRoot, "input_boolean.yaml"), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const helpers = parseFixtureInputBooleans(contents);
    for (const entityId of [...states.keys()]) {
      if (entityId.startsWith("input_boolean.")) {
        states.delete(entityId);
        attributes.delete(entityId);
      }
    }
    for (const [helperId, definition] of helpers) {
      const entityId = `input_boolean.${helperId}`;
      states.set(entityId, definition.initial === true ? "on" : "off");
      attributes.set(entityId, {
        friendly_name: definition.name ?? helperId.split("_").map(
          (part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`,
        ).join(" "),
        ...(definition.icon ? { icon: definition.icon } : {}),
      });
    }
  };
  const fetchImpl = async (url, options = {}) => {
    const authorization = options.headers?.Authorization;
    assert.equal(authorization, `Bearer ${TOKEN_CANARY}`);
    calls.push({
      url,
      method: options.method,
      authorization,
      body: options.body,
    });
    if (url.endsWith("/core/check")) {
      const passed = configCheckOk;
      if (!passed) configCheckOk = true;
      return jsonResponse(200, passed ? { result: "ok" } : { result: "error" });
    }
    const stateMarker = "/states/";
    if (url.includes(stateMarker) && options.method === "GET") {
      const entityId = decodeURIComponent(url.split(stateMarker)[1]);
      if (
        Number.isInteger(failStateReadsAfterServiceCalls) &&
        serviceMutationCalls >= failStateReadsAfterServiceCalls
      ) {
        return jsonResponse(503, { message: "fixture state read unavailable" });
      }
      if (!states.has(entityId)) return jsonResponse(404, { message: "fixture missing" });
      return jsonResponse(200, {
        entity_id: entityId,
        state: states.get(entityId),
        attributes: attributes.get(entityId) ?? {},
      });
    }
    const serviceMarker = "/services/";
    if (url.includes(serviceMarker) && options.method === "POST") {
      const [domain, service] = url.split(serviceMarker)[1].split("/");
      const body = JSON.parse(options.body);
      if (domain === "input_boolean" && service === "reload") {
        assert.deepEqual(body, {});
        await syncInputBooleans();
        return jsonResponse(200, []);
      }
      assert.equal(body.entity_id.startsWith(`${domain}.`), true);
      serviceMutationCalls += 1;
      const outcome = pendingServiceOutcomes.shift() ??
        (failFirstServiceMutation ? "unexpected" : "normal");
      if (failFirstServiceMutation) failFirstServiceMutation = false;
      if (outcome === "transport_error_no_change") {
        throw new Error("fixture service transport failure");
      }
      if (outcome === "http_error_no_change") {
        return jsonResponse(503, { message: "fixture service rejected" });
      }
      if (outcome === "unexpected") {
        states.set(body.entity_id, "unexpected");
      } else if (outcome === "normal") {
        states.set(body.entity_id, service === "turn_on" ? "on" : "off");
      } else if (outcome !== "no_change") {
        throw new Error(`unsupported fixture service outcome: ${outcome}`);
      }
      return jsonResponse(200, []);
    }
    return jsonResponse(404, { message: "unexpected fixture URL" });
  };
  return {
    calls,
    states,
    attributes,
    fetchImpl,
    syncInputBooleans,
    get serviceMutationCalls() {
      return serviceMutationCalls;
    },
    setConfigCheck(value) {
      configCheckOk = value;
    },
  };
}

function createFakeMemory(ha, {
  memoryBeginGate = null,
  memoryBeginUnavailable = false,
  memoryVerifyUnavailable = false,
} = {}) {
  const calls = [];
  let nextChangeId = 1;
  const matches = (expectations) => Object.entries(expectations.states).every(
    ([subject, expected]) => {
      const entityId = subject.slice("entity:".length);
      const exists = ha.states.has(entityId);
      if (expected.exists === false) return !exists;
      if (!exists) return false;
      if (Object.hasOwn(expected, "state") && ha.states.get(entityId) !== expected.state) {
        return false;
      }
      return Object.entries(expected.attributes ?? {}).every(
        ([key, value]) => (ha.attributes.get(entityId)?.[key] ?? null) === value,
      );
    },
  );
  return {
    calls,
    async begin(input) {
      calls.push({ action: "begin", input });
      if (memoryBeginGate) await memoryBeginGate;
      if (memoryBeginUnavailable) throw new BrokerError("memory_unavailable", "fixture unavailable");
      return { change_id: nextChangeId++, status: "pending" };
    },
    async verify(input) {
      calls.push({ action: "verify", input });
      if (memoryVerifyUnavailable) {
        return {
          change_id: input.changeId,
          status: "unavailable",
          verification: { reason: "fixture_unavailable" },
        };
      }
      const matched = matches(input.expectations);
      return {
        change_id: input.changeId,
        status: matched ? "verified" : "mismatch",
        matched,
      };
    },
  };
}

async function createFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "ha-change-broker-"));
  const configRoot = join(root, "config");
  const dataRoot = join(root, "data", "change-broker");
  const runRoot = join(root, "run");
  const socketPath = join(runRoot, "change-broker.sock");
  const proposalSocketPath = join(runRoot, "change-proposal.sock");
  await mkdir(join(configRoot, "themes"), { recursive: true });
  await writeFile(
    join(configRoot, "configuration.yaml"),
    "input_boolean: !include input_boolean.yaml\n",
    { mode: 0o644 },
  );
  await mkdir(runRoot, { mode: 0o700 });
  await chmod(runRoot, 0o700);
  const ha = createFakeHomeAssistant({ ...options, configRoot });
  const memory = options.memoryChange ?? createFakeMemory(ha, options);
  let clock = Date.parse("2026-08-11T00:00:00.000Z");
  const brokerOptions = {
    socketPath,
    proposalSocketPath,
    configRoot,
    dataRoot,
    supervisorToken: TOKEN_CANARY,
    supervisorUrl: "http://supervisor.fixture",
    haUrl: "http://supervisor.fixture/core/api",
    fetchImpl: ha.fetchImpl,
    memoryChange: memory,
    now: () => clock,
    sleep: async () => {},
    audit: () => {},
    requiredUid: process.getuid(),
  };
  const broker = new ChangeBroker(brokerOptions);
  await broker.start();
  return {
    root,
    configRoot,
    dataRoot,
    socketPath,
    proposalSocketPath,
    broker,
    brokerOptions,
    ha,
    memory,
    advance(milliseconds) {
      clock += milliseconds;
    },
    async close() {
      await this.broker.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function configProposal(
  path,
  expectedSha256,
  content,
  summary = "Update a test theme",
  activation = undefined,
) {
  return {
    requester: REQUESTER,
    operation: "config_patch",
    summary,
    ttl_seconds: 120,
    payload: {
      path,
      expected_sha256: expectedSha256,
      content,
      ...(activation ? { activation } : {}),
    },
  };
}

function deviceTestProposal({
  domain = "light",
  service = "turn_on",
  entityId = "light.fixture",
  expectedPriorState = "off",
  summary = "Briefly test and restore the fixture light",
} = {}) {
  return {
    requester: REQUESTER,
    operation: "device_test",
    summary,
    ttl_seconds: 120,
    payload: {
      domain,
      service,
      entity_id: entityId,
      expected_prior_state: expectedPriorState,
    },
  };
}

async function authorize(socketPath, proposal, authorization = "autonomous_policy") {
  return sendBrokerRequest("authorize", {
    proposal_id: proposal.proposal_id,
    requester: REQUESTER,
    preview_digest: proposal.preview_digest,
    authorization,
  }, { socketPath });
}

async function execute(socketPath, proposal, capability, idempotencyKey) {
  const payload = {
    proposal_id: proposal.proposal_id,
    requester: REQUESTER,
    preview_digest: proposal.preview_digest,
    capability,
    idempotency_key: idempotencyKey,
  };
  const started = await sendBrokerRequest("execute", payload, { socketPath });
  const replayed = started.replayed === true;
  if (started.status === "completed") return { ...started.result, replayed };
  if (started.status === "in_doubt") {
    return {
      status: "in_doubt",
      operation: started.operation,
      reason: started.reason,
      changed: null,
      replayed,
    };
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await sendBrokerRequest("execute_status", {
      requester: REQUESTER,
      idempotency_key: idempotencyKey,
    }, { socketPath });
    if (status.status === "completed") return { ...status.result, replayed };
    if (status.status === "in_doubt") {
      return {
        status: "in_doubt",
        operation: status.operation,
        reason: status.reason,
        changed: null,
        replayed,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fixture execution did not reach a durable terminal status");
}

test("socket config proposal reloads and verifies memory before persistent success", async () => {
  const fixture = await createFixture();
  try {
    const target = join(fixture.configRoot, "input_boolean.yaml");
    const original = "fixture_toggle:\n  name: Blue Fixture\n  icon: mdi:toggle-switch-off\n";
    const replacement = "fixture_toggle:\n  name: Green Fixture\n  icon: mdi:toggle-switch-off\n";
    await writeFile(target, original, { mode: 0o644 });
    await fixture.ha.syncInputBooleans();
    const socketInfo = await stat(fixture.socketPath);
    const proposalSocketInfo = await stat(fixture.proposalSocketPath);
    assert.equal(socketInfo.mode & 0o777, 0o600);
    assert.equal(proposalSocketInfo.mode & 0o777, 0o600);
    const health = await sendBrokerRequest("health", {}, { socketPath: fixture.socketPath });
    assert.equal(health.status, "ready");
    const proposalHealth = await sendBrokerRequest(
      "health",
      {},
      { socketPath: fixture.proposalSocketPath },
    );
    assert.equal(proposalHealth.status, "ready");
    await assert.rejects(
      sendBrokerRequest("authorize", {}, { socketPath: fixture.proposalSocketPath }),
      (error) => error instanceof BrokerError && error.code === "action_forbidden",
    );
    await assert.rejects(
      sendBrokerRequest("execute", {}, { socketPath: fixture.proposalSocketPath }),
      (error) => error instanceof BrokerError && error.code === "action_forbidden",
    );
    await assert.rejects(
      sendBrokerRequest("propose", {}, { socketPath: fixture.socketPath }),
      (error) => error instanceof BrokerError && error.code === "action_forbidden",
    );

    const proposal = await sendBrokerRequest("propose", {
      proposal: configProposal(
        "input_boolean.yaml",
        sha256Digest(original),
        replacement,
        "Update a verified input boolean",
        { kind: "input_boolean_reload" },
      ),
    }, { socketPath: fixture.proposalSocketPath });
    assert.equal(proposal.risk, "low");
    assert.equal(proposal.preview.target, "input_boolean.yaml");
    assert.equal(proposal.preview.format, "yaml-line-diff-v1");
    assert.equal(proposal.preview.change_kind, "update");
    assert.equal(proposal.preview.replacement_sha256, sha256Digest(replacement));
    assert.match(proposal.preview.mutation_sha256, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(proposal.preview.before, [{
      line: 2,
      text: "  name: Blue Fixture",
      redacted: false,
      truncated: false,
    }]);
    assert.deepEqual(proposal.preview.after, [{
      line: 2,
      text: "  name: Green Fixture",
      redacted: false,
      truncated: false,
    }]);
    assert.equal(proposal.preview.activation.kind, "input_boolean_reload");
    assert.equal(proposal.preview.activation.reload_service, "input_boolean.reload");
    assert.deepEqual(proposal.preview.activation.changes, [{
      entity_id: "input_boolean.fixture_toggle",
      change_kind: "update",
      verified_fields: ["attribute:friendly_name", "attribute:icon", "exists"],
    }]);
    assert.equal(Object.hasOwn(proposal.preview, "summary"), false);
    assert.match(proposal.preview_digest, /^sha256:[a-f0-9]{64}$/u);

    const inspected = await sendBrokerRequest("inspect", {
      proposal_id: proposal.proposal_id,
      requester: REQUESTER,
    }, { socketPath: fixture.socketPath });
    assert.deepEqual(inspected, proposal);
    await assert.rejects(
      sendBrokerRequest("inspect", {
        proposal_id: proposal.proposal_id,
        requester: { ...REQUESTER, user_id: "10002" },
      }, { socketPath: fixture.socketPath }),
      (error) => error instanceof BrokerError && error.code === "requester_mismatch",
    );

    const authorization = await authorize(fixture.socketPath, proposal, "autonomous_policy");
    assert.match(authorization.capability, /^[A-Za-z0-9_-]{43}$/u);
    const result = await execute(
      fixture.socketPath,
      proposal,
      authorization.capability,
      "config-fixture-0001",
    );
    assert.deepEqual(
      {
        status: result.status,
        changed: result.changed,
        configCheck: result.config_check,
        reload: result.reload,
        replayed: result.replayed,
      },
      {
        status: "succeeded",
        changed: true,
        configCheck: "passed",
        reload: "input_boolean.reload",
        replayed: false,
      },
    );
    assert.equal(result.fresh_verification, "memory_verified");
    assert.equal(fixture.ha.attributes.get("input_boolean.fixture_toggle").friendly_name, "Green Fixture");
    assert.deepEqual(fixture.memory.calls.map((call) => call.action), ["begin", "verify"]);
    assert.equal(
      fixture.ha.calls.some((call) => call.url.endsWith("/services/input_boolean/reload")),
      true,
    );
    assert.equal(await readFile(target, "utf8"), replacement);
    assert.equal(
      await readFile(join(fixture.dataRoot, "backups", proposal.proposal_id, "original"), "utf8"),
      original,
    );
    assert.equal((await stat(join(fixture.dataRoot, "idempotency.json"))).mode & 0o777, 0o600);
    assert.equal(
      (await readFile(join(fixture.dataRoot, "idempotency.json"), "utf8"))
        .includes(authorization.capability),
      false,
    );
    assert.equal(
      fixture.ha.calls.every((call) => call.authorization === `Bearer ${TOKEN_CANARY}`),
      true,
    );
    const createHelperProposal = await sendBrokerRequest("propose", {
      proposal: configProposal(
        "input_boolean.yaml",
        sha256Digest(replacement),
        `${replacement}new_helper:\n  name: Newly Added\n`,
        "Add a new input boolean helper",
        { kind: "input_boolean_reload" },
      ),
    }, { socketPath: fixture.proposalSocketPath });
    assert.equal(createHelperProposal.risk, "high");
    await assert.rejects(
      authorize(fixture.socketPath, createHelperProposal, "autonomous_policy"),
      (error) => error.code === "human_confirmation_required",
    );

    await fixture.broker.close();
    const restarted = new ChangeBroker(fixture.brokerOptions);
    await restarted.start();
    fixture.broker = restarted;
    const replay = await execute(
      fixture.socketPath,
      proposal,
      "invalid-but-idempotency-is-checked-before-capability",
      "config-fixture-0001",
    );
    assert.equal(replay.status, "succeeded");
    assert.equal(replay.replayed, true);
    assert.equal(await readFile(target, "utf8"), replacement);
    await assert.rejects(
      execute(
        fixture.socketPath,
        proposal,
        authorization.capability,
        "config-fixture-one-time-0002",
      ),
      (error) => error.code === "proposal_unavailable",
    );
    await assert.rejects(
      sendBrokerRequest("execute", {
        proposal_id: "different-proposal",
        requester: REQUESTER,
        preview_digest: proposal.preview_digest,
        capability: authorization.capability,
        idempotency_key: "config-fixture-0001",
      }, { socketPath: fixture.socketPath }),
      (error) => error.code === "idempotency_conflict",
    );
  } finally {
    await fixture.close();
  }
});

test("socket execute acknowledges a durable job before slow work and survives status replay", async () => {
  let releaseMemoryBegin;
  const memoryBeginGate = new Promise((resolve) => { releaseMemoryBegin = resolve; });
  const fixture = await createFixture({ memoryBeginGate });
  try {
    const target = join(fixture.configRoot, "input_boolean.yaml");
    const original = "durable_job:\n  name: Before Job\n";
    const replacement = "durable_job:\n  name: After Job\n";
    await writeFile(target, original, { mode: 0o644 });
    await fixture.ha.syncInputBooleans();
    const proposal = await sendBrokerRequest("propose", {
      proposal: configProposal(
        "input_boolean.yaml",
        sha256Digest(original),
        replacement,
        "Run a durable asynchronous config job",
        { kind: "input_boolean_reload" },
      ),
    }, { socketPath: fixture.proposalSocketPath });
    const authorization = await authorize(fixture.socketPath, proposal, "human_confirmed");
    const idempotencyKey = "config-durable-job-0001";
    const executionPayload = {
      proposal_id: proposal.proposal_id,
      requester: REQUESTER,
      preview_digest: proposal.preview_digest,
      capability: authorization.capability,
      idempotency_key: idempotencyKey,
    };

    const accepted = await sendBrokerRequest("execute", executionPayload, {
      socketPath: fixture.socketPath,
      timeoutMs: 1_000,
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.replayed, false);
    const running = await sendBrokerRequest("execute_status", {
      requester: REQUESTER,
      idempotency_key: idempotencyKey,
    }, { socketPath: fixture.socketPath });
    assert.equal(running.status, "running");

    const duplicate = await sendBrokerRequest("execute", executionPayload, {
      socketPath: fixture.socketPath,
    });
    assert.equal(duplicate.status, "running");
    assert.equal(duplicate.replayed, true);

    const recoveredBroker = new ChangeBroker({
      ...fixture.brokerOptions,
      socketPath: join(fixture.root, "recovered.sock"),
      proposalSocketPath: join(fixture.root, "recovered-proposal.sock"),
    });
    await recoveredBroker.initialize();
    const recovered = recoveredBroker.executionStatus({
      requester: REQUESTER,
      idempotency_key: idempotencyKey,
    });
    assert.equal(recovered.status, "in_doubt");
    assert.equal(recovered.reason, "previous_attempt_not_proven_complete");

    releaseMemoryBegin();
    let completed = null;
    const completionDeadline = Date.now() + 10_000;
    while (Date.now() < completionDeadline) {
      const status = await sendBrokerRequest("execute_status", {
        requester: REQUESTER,
        idempotency_key: idempotencyKey,
      }, { socketPath: fixture.socketPath });
      if (status.status === "completed") {
        completed = status;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(completed?.result?.status, "succeeded");
    assert.equal(await readFile(target, "utf8"), replacement);

    const completedReplay = await sendBrokerRequest("execute", {
      ...executionPayload,
      capability: "already-consumed-capability",
    }, { socketPath: fixture.socketPath });
    assert.equal(completedReplay.status, "completed");
    assert.equal(completedReplay.result.status, "succeeded");
    assert.equal(completedReplay.replayed, true);
    assert.equal(fixture.memory.calls.filter((call) => call.action === "begin").length, 1);
    assert.equal(
      fixture.ha.calls.filter((call) => call.url.endsWith("/services/input_boolean/reload")).length,
      1,
    );
  } finally {
    releaseMemoryBegin?.();
    await fixture.close();
  }
});

test("failed configuration check restores the exact original and replays the failure", async () => {
  const fixture = await createFixture({ configCheckOk: false });
  try {
    const target = join(fixture.configRoot, "input_boolean.yaml");
    const original = "rollback_toggle:\n  name: Blue Rollback\n";
    await writeFile(target, original, { mode: 0o640 });
    await chmod(target, 0o640);
    await fixture.ha.syncInputBooleans();
    const proposal = await sendBrokerRequest("propose", {
      proposal: configProposal(
        "input_boolean.yaml",
        sha256Digest(original),
        "rollback_toggle:\n  name: Red Rollback\n",
        "Test a checked rollback",
        { kind: "input_boolean_reload" },
      ),
    }, { socketPath: fixture.proposalSocketPath });
    const authorization = await authorize(fixture.socketPath, proposal, "human_confirmed");
    const result = await execute(
      fixture.socketPath,
      proposal,
      authorization.capability,
      "config-rollback-0001",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "config_check_failed");
    assert.equal(result.rollback.status, "verified");
    assert.equal(result.desired_memory.status, "mismatch");
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal((await stat(target)).mode & 0o777, 0o640);
    const replay = await execute(
      fixture.socketPath,
      proposal,
      "this-capability-was-consumed",
      "config-rollback-0001",
    );
    assert.equal(replay.reason, "config_check_failed");
    assert.equal(replay.replayed, true);
  } finally {
    await fixture.close();
  }
});

test("configuration execution fails closed without a supported activation contract", async () => {
  const fixture = await createFixture();
  try {
    const target = join(fixture.configRoot, "themes", "preview-only.yaml");
    const original = "primary-color: blue\n";
    await writeFile(target, original, { mode: 0o644 });
    await assert.rejects(
      sendBrokerRequest("propose", {
        proposal: configProposal(
          "themes/preview-only.yaml",
          sha256Digest(original),
          "primary-color: green\n",
          "Reject an unknown activation contract",
          { kind: "homeassistant_restart" },
        ),
      }, { socketPath: fixture.proposalSocketPath }),
      (error) => error instanceof BrokerError && error.code === "unsupported_activation",
    );
    const proposal = await sendBrokerRequest("propose", {
      proposal: configProposal(
        "themes/preview-only.yaml",
        sha256Digest(original),
        "primary-color: green\n",
      ),
    }, { socketPath: fixture.proposalSocketPath });
    assert.equal(proposal.risk, "high");
    assert.equal(proposal.preview.activation.executable, false);
    await assert.rejects(
      authorize(fixture.socketPath, proposal, "autonomous_policy"),
      (error) => error instanceof BrokerError && error.code === "human_confirmation_required",
    );
    const authorization = await authorize(fixture.socketPath, proposal, "human_confirmed");
    const result = await execute(
      fixture.socketPath,
      proposal,
      authorization.capability,
      "config-preview-only-0001",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "unsupported_activation");
    assert.equal(result.changed, false);
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal(fixture.memory.calls.length, 0);
  } finally {
    await fixture.close();
  }
});

test("semantic memory begin failure prevents a configuration mutation", async () => {
  const fixture = await createFixture({ memoryBeginUnavailable: true });
  try {
    const target = join(fixture.configRoot, "input_boolean.yaml");
    const original = "memory_guard:\n  name: Before Memory\n";
    const replacement = "memory_guard:\n  name: After Memory\n";
    await writeFile(target, original, { mode: 0o644 });
    await fixture.ha.syncInputBooleans();
    const proposal = await sendBrokerRequest("propose", {
      proposal: configProposal(
        "input_boolean.yaml",
        sha256Digest(original),
        replacement,
        "Test memory begin guard",
        { kind: "input_boolean_reload" },
      ),
    }, { socketPath: fixture.proposalSocketPath });
    const authorization = await authorize(fixture.socketPath, proposal, "human_confirmed");
    const result = await execute(
      fixture.socketPath,
      proposal,
      authorization.capability,
      "config-memory-begin-0001",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "memory_begin_failed");
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal(
      fixture.ha.calls.some((call) => call.url.endsWith("/services/input_boolean/reload")),
      false,
    );
  } finally {
    await fixture.close();
  }
});

test("unavailable post-change memory verification reloads the verified backup", async () => {
  const fixture = await createFixture({ memoryVerifyUnavailable: true });
  try {
    const target = join(fixture.configRoot, "input_boolean.yaml");
    const original = "memory_rollback:\n  name: Original Memory\n";
    const replacement = "memory_rollback:\n  name: Changed Memory\n";
    await writeFile(target, original, { mode: 0o644 });
    await fixture.ha.syncInputBooleans();
    const proposal = await sendBrokerRequest("propose", {
      proposal: configProposal(
        "input_boolean.yaml",
        sha256Digest(original),
        replacement,
        "Test memory verification rollback",
        { kind: "input_boolean_reload" },
      ),
    }, { socketPath: fixture.proposalSocketPath });
    const authorization = await authorize(fixture.socketPath, proposal, "human_confirmed");
    const result = await execute(
      fixture.socketPath,
      proposal,
      authorization.capability,
      "config-memory-verify-0001",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "memory_verification_unavailable");
    assert.equal(result.changed, false);
    assert.equal(result.rollback.status, "api_verified_memory_unavailable");
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal(
      fixture.ha.attributes.get("input_boolean.memory_rollback").friendly_name,
      "Original Memory",
    );
    assert.equal(
      fixture.ha.calls.filter((call) => call.url.endsWith("/services/input_boolean/reload")).length,
      2,
    );
  } finally {
    await fixture.close();
  }
});

test("input_boolean activation rejects ambiguous include and unverifiable semantics", async () => {
  const fixture = await createFixture();
  try {
    const target = join(fixture.configRoot, "input_boolean.yaml");
    const original = "guarded_toggle:\n  name: Guarded\n  icon: mdi:shield\n  initial: false\n";
    await writeFile(target, original, { mode: 0o644 });
    await writeFile(
      join(fixture.configRoot, "configuration.yaml"),
      "input_boolean: !include another.yaml\n",
      { mode: 0o644 },
    );
    await assert.rejects(
      sendBrokerRequest("propose", {
        proposal: configProposal(
          "input_boolean.yaml",
          sha256Digest(original),
          "guarded_toggle:\n  name: Guarded\n  icon: mdi:shield\n  initial: true\n",
          "Attempt ambiguous activation",
          { kind: "input_boolean_reload" },
        ),
      }, { socketPath: fixture.proposalSocketPath }),
      (error) => error.code === "unsupported_activation",
    );
    await writeFile(
      join(fixture.configRoot, "configuration.yaml"),
      "input_boolean: !include input_boolean.yaml\n",
      { mode: 0o644 },
    );
    await assert.rejects(
      sendBrokerRequest("propose", {
        proposal: configProposal(
          "input_boolean.yaml",
          sha256Digest(original),
          "guarded_toggle:\n  name: Guarded\n  initial: true\n",
          "Attempt unverifiable initial mutation",
          { kind: "input_boolean_reload" },
        ),
      }, { socketPath: fixture.proposalSocketPath }),
      (error) => error.code === "unverifiable_config_change",
    );
    await assert.rejects(
      sendBrokerRequest("propose", {
        proposal: configProposal(
          "input_boolean.yaml",
          sha256Digest(original),
          "guarded_toggle:\n  name: Guarded\n  initial: false\n",
          "Attempt unverifiable icon removal",
          { kind: "input_boolean_reload" },
        ),
      }, { socketPath: fixture.proposalSocketPath }),
      (error) => error.code === "unverifiable_config_change",
    );
  } finally {
    await fixture.close();
  }
});

test("configuration preview is broker-generated, bounded, and secret-safe", async () => {
  const fixture = await createFixture();
  try {
    const target = join(fixture.configRoot, "themes", "secret-preview.yaml");
    const oldToken = "OLD_SECRET_PREVIEW_CANARY_6f92f6e8d82a";
    const newToken = "NEW_SECRET_PREVIEW_CANARY_8a10ac5b731d";
    const oldPassword = "old-password-preview-canary";
    const newPassword = "new-password-preview-canary";
    const original = [
      "primary-color: blue",
      `api_token: ${oldToken}`,
      "nested:",
      `  password: ${oldPassword}`,
      "  visible-note: stable",
      `# comment ${oldToken}`,
      "",
    ].join("\n");
    const replacement = [
      "primary-color: green",
      `api_token: ${newToken}`,
      "nested:",
      `  password: ${newPassword}`,
      "  visible-note: stable",
      `# comment ${newToken}`,
      "",
    ].join("\n");
    await writeFile(target, original, { mode: 0o600 });
    const proposal = await sendBrokerRequest("propose", {
      proposal: configProposal(
        "themes/secret-preview.yaml",
        sha256Digest(original),
        replacement,
        "Only change the visible theme color",
      ),
    }, { socketPath: fixture.proposalSocketPath });
    const serialized = JSON.stringify(proposal);
    for (const secret of [oldToken, newToken, oldPassword, newPassword]) {
      assert.equal(serialized.includes(secret), false);
    }
    assert.equal(serialized.includes("Only change the visible theme color"), false);
    assert.equal(proposal.risk, "high");
    assert.equal(proposal.preview.format, "yaml-line-diff-v1");
    assert.equal(proposal.preview.change_kind, "update");
    assert.equal(proposal.preview.truncated, false);
    assert.equal(
      proposal.preview.before.some((line) => line.text === "primary-color: blue"),
      true,
    );
    assert.equal(
      proposal.preview.after.some((line) => line.text === "primary-color: green"),
      true,
    );
    assert.equal(
      [...proposal.preview.before, ...proposal.preview.after]
        .filter((line) => /api_token|password/u.test(line.text))
        .every((line) => line.redacted && line.text.includes("<redacted>")),
      true,
    );
    assert.equal(
      [...proposal.preview.before, ...proposal.preview.after]
        .filter((line) => line.text.includes("comment omitted"))
        .every((line) => line.redacted),
      true,
    );
    assert.match(proposal.preview.mutation_sha256, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(Buffer.byteLength(serialized) < 16 * 1024);
    await assert.rejects(
      authorize(fixture.socketPath, proposal, "autonomous_policy"),
      (error) => error.code === "human_confirmation_required",
    );

    const altered = await sendBrokerRequest("propose", {
      proposal: configProposal(
        "themes/secret-preview.yaml",
        sha256Digest(original),
        replacement.replace("primary-color: green", "primary-color: red"),
        "Only change the visible theme color",
      ),
    }, { socketPath: fixture.proposalSocketPath });
    assert.notEqual(altered.preview_digest, proposal.preview_digest);
    assert.notEqual(altered.preview.mutation_sha256, proposal.preview.mutation_sha256);
  } finally {
    await fixture.close();
  }
});

test("configuration preview limits changed lines and rejects stale proposal input", async () => {
  const fixture = await createFixture();
  try {
    const target = join(fixture.configRoot, "themes", "bounded-preview.yaml");
    const original = `${Array.from({ length: 80 }, (_, index) => `value_${index}: ${index}`).join("\n")}\n`;
    const replacement = `${Array.from({ length: 80 }, (_, index) => `value_${index}: ${index + 100}`).join("\n")}\n`;
    await writeFile(target, original, { mode: 0o644 });
    const proposal = await sendBrokerRequest("propose", {
      proposal: configProposal(
        "themes/bounded-preview.yaml",
        sha256Digest(original),
        replacement,
      ),
    }, { socketPath: fixture.proposalSocketPath });
    assert.equal(proposal.preview.before.length, 12);
    assert.equal(proposal.preview.after.length, 12);
    assert.equal(proposal.preview.omitted_before_lines, 68);
    assert.equal(proposal.preview.omitted_after_lines, 68);
    assert.equal(proposal.preview.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(proposal.preview)) < 16 * 1024);

    await assert.rejects(
      sendBrokerRequest("propose", {
        proposal: configProposal(
          "themes/bounded-preview.yaml",
          `sha256:${"0".repeat(64)}`,
          replacement,
        ),
      }, { socketPath: fixture.proposalSocketPath }),
      (error) => error.code === "precondition_failed",
    );
  } finally {
    await fixture.close();
  }
});

test("service call enforces state precondition and verifies the fresh state", async () => {
  const fixture = await createFixture();
  try {
    const proposal = await sendBrokerRequest("propose", {
      proposal: {
        requester: REQUESTER,
        operation: "service_call",
        summary: "Turn on the fixture light",
        payload: {
          domain: "light",
          service: "turn_on",
          entity_id: "light.fixture",
          expected_state: "off",
        },
      },
    }, { socketPath: fixture.proposalSocketPath });
    assert.equal(proposal.risk, "high");
    await assert.rejects(
      authorize(fixture.socketPath, proposal, "autonomous_policy"),
      (error) => error.code === "human_confirmation_required",
    );
    const authorization = await authorize(fixture.socketPath, proposal, "human_confirmed");
    const result = await execute(
      fixture.socketPath,
      proposal,
      authorization.capability,
      "service-fixture-0001",
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.previous_state, "off");
    assert.equal(result.current_state, "on");
    assert.equal(fixture.ha.states.get("light.fixture"), "on");
    assert.equal(
      fixture.ha.calls.some((call) => call.url.endsWith("/services/light/turn_on")),
      true,
    );

    const staleProposal = await sendBrokerRequest("propose", {
      proposal: {
        requester: REQUESTER,
        operation: "service_call",
        summary: "Turn off with a stale precondition",
        payload: {
          domain: "light",
          service: "turn_off",
          entity_id: "light.fixture",
          expected_state: "off",
        },
      },
    }, { socketPath: fixture.proposalSocketPath });
    const staleAuthorization = await authorize(
      fixture.socketPath,
      staleProposal,
      "human_confirmed",
    );
    const staleResult = await execute(
      fixture.socketPath,
      staleProposal,
      staleAuthorization.capability,
      "service-fixture-stale-0001",
    );
    assert.equal(staleResult.status, "failed");
    assert.equal(staleResult.reason, "precondition_failed");
    assert.equal(fixture.ha.states.get("light.fixture"), "on");
  } finally {
    await fixture.close();
  }
});

test("service verification failure restores the observed prior state", async () => {
  const fixture = await createFixture({ failFirstServiceMutation: true });
  try {
    const proposal = await sendBrokerRequest("propose", {
      proposal: {
        requester: REQUESTER,
        operation: "service_call",
        summary: "Turn on the fixture light",
        payload: {
          domain: "light",
          service: "turn_on",
          entity_id: "light.fixture",
          expected_state: "off",
        },
      },
    }, { socketPath: fixture.proposalSocketPath });
    const authorization = await authorize(fixture.socketPath, proposal, "human_confirmed");
    const result = await execute(
      fixture.socketPath,
      proposal,
      authorization.capability,
      "service-fixture-rollback-0001",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "fresh_verification_failed");
    assert.equal(result.changed, false);
    assert.equal(fixture.ha.states.get("light.fixture"), "off");
    assert.equal(
      fixture.ha.calls.some((call) => call.url.endsWith("/services/light/turn_off")),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("device test verifies the transient state, always restores, and replays durably", async () => {
  const fixture = await createFixture();
  try {
    const proposal = await sendBrokerRequest("propose", {
      proposal: deviceTestProposal(),
    }, { socketPath: fixture.proposalSocketPath });
    assert.equal(proposal.operation, "device_test");
    assert.equal(proposal.risk, "high");
    assert.deepEqual(proposal.preview, {
      format: "device-test-plan-v1",
      summary: "Briefly test and restore the fixture light",
      entity_id: "light.fixture",
      precondition: {
        expected_prior_state: "off",
        fresh_read_required: true,
      },
      test: {
        service: "light.turn_on",
        verify_state: "on",
        fresh_verification_required: true,
      },
      restore: {
        service: "light.turn_off",
        verify_state: "off",
        always: true,
        fresh_verification_required: true,
      },
    });
    await assert.rejects(
      authorize(fixture.socketPath, proposal, "autonomous_policy"),
      (error) => error.code === "human_confirmation_required",
    );
    const authorization = await authorize(fixture.socketPath, proposal, "human_confirmed");
    const result = await execute(
      fixture.socketPath,
      proposal,
      authorization.capability,
      "device-test-positive-0001",
    );
    assert.deepEqual({
      status: result.status,
      operation: result.operation,
      previous_state: result.previous_state,
      test_state: result.test_state,
      current_state: result.current_state,
      changed: result.changed,
      restore_status: result.restore.status,
    }, {
      status: "succeeded",
      operation: "device_test",
      previous_state: "off",
      test_state: "on",
      current_state: "off",
      changed: false,
      restore_status: "verified",
    });
    assert.equal(fixture.ha.states.get("light.fixture"), "off");
    assert.deepEqual(
      fixture.ha.calls
        .filter((call) => call.url.includes("/services/light/"))
        .map((call) => call.url.split("/services/light/")[1]),
      ["turn_on", "turn_off"],
    );

    const serviceCallCount = fixture.ha.serviceMutationCalls;
    const replay = await execute(
      fixture.socketPath,
      proposal,
      authorization.capability,
      "device-test-positive-0001",
    );
    assert.equal(replay.status, "succeeded");
    assert.equal(replay.replayed, true);
    assert.equal(fixture.ha.serviceMutationCalls, serviceCallCount);
    assert.equal(fixture.ha.states.get("light.fixture"), "off");
  } finally {
    await fixture.close();
  }
});

test("device test verification failure still restores and verifies the prior state", async () => {
  const fixture = await createFixture({ serviceOutcomes: ["unexpected", "normal"] });
  try {
    const proposal = await sendBrokerRequest("propose", {
      proposal: deviceTestProposal(),
    }, { socketPath: fixture.proposalSocketPath });
    const authorization = await authorize(fixture.socketPath, proposal, "human_confirmed");
    const result = await execute(
      fixture.socketPath,
      proposal,
      authorization.capability,
      "device-test-verification-failure-0001",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "fresh_verification_failed");
    assert.equal(result.changed, false);
    assert.equal(result.restore.status, "verified");
    assert.equal(result.current_state, "off");
    assert.equal(fixture.ha.states.get("light.fixture"), "off");
    assert.equal(fixture.ha.serviceMutationCalls, 2);
  } finally {
    await fixture.close();
  }
});

test("device test initial call error with no change still executes the restore leg", async () => {
  const fixture = await createFixture({
    serviceOutcomes: ["http_error_no_change", "normal"],
  });
  try {
    const proposal = await sendBrokerRequest("propose", {
      proposal: deviceTestProposal(),
    }, { socketPath: fixture.proposalSocketPath });
    const authorization = await authorize(fixture.socketPath, proposal, "human_confirmed");
    const result = await execute(
      fixture.socketPath,
      proposal,
      authorization.capability,
      "device-test-initial-error-0001",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "ha_request_failed");
    assert.equal(result.restore.status, "verified");
    assert.equal(result.current_state, "off");
    assert.equal(fixture.ha.states.get("light.fixture"), "off");
    assert.equal(fixture.ha.serviceMutationCalls, 2);
  } finally {
    await fixture.close();
  }
});

test("device test restore mismatch is durable rollback_failed and fail closed", async () => {
  const fixture = await createFixture({ serviceOutcomes: ["normal", "no_change"] });
  try {
    const proposal = await sendBrokerRequest("propose", {
      proposal: deviceTestProposal(),
    }, { socketPath: fixture.proposalSocketPath });
    const authorization = await authorize(fixture.socketPath, proposal, "human_confirmed");
    const result = await execute(
      fixture.socketPath,
      proposal,
      authorization.capability,
      "device-test-restore-failure-0001",
    );
    assert.equal(result.status, "in_doubt");
    assert.equal(result.reason, "rollback_failed");
    assert.equal(result.changed, null);
    assert.equal(fixture.ha.states.get("light.fixture"), "on");
    const serviceCallCount = fixture.ha.serviceMutationCalls;

    const replay = await execute(
      fixture.socketPath,
      proposal,
      authorization.capability,
      "device-test-restore-failure-0001",
    );
    assert.equal(replay.status, "in_doubt");
    assert.equal(replay.reason, "rollback_failed");
    assert.equal(replay.replayed, true);
    assert.equal(fixture.ha.serviceMutationCalls, serviceCallCount);
  } finally {
    await fixture.close();
  }
});

test("device test unobservable restore is durable in_doubt", async () => {
  const fixture = await createFixture({
    serviceOutcomes: ["normal", "normal"],
    failStateReadsAfterServiceCalls: 2,
  });
  try {
    const proposal = await sendBrokerRequest("propose", {
      proposal: deviceTestProposal(),
    }, { socketPath: fixture.proposalSocketPath });
    const authorization = await authorize(fixture.socketPath, proposal, "human_confirmed");
    const result = await execute(
      fixture.socketPath,
      proposal,
      authorization.capability,
      "device-test-restore-in-doubt-0001",
    );
    assert.equal(result.status, "in_doubt");
    assert.equal(result.reason, "execution_in_doubt");
    assert.equal(result.changed, null);
    assert.equal(fixture.ha.states.get("light.fixture"), "off");
  } finally {
    await fixture.close();
  }
});

test("device test rejects no-op targets and non-device safety operations", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      sendBrokerRequest("propose", {
        proposal: deviceTestProposal({ expectedPriorState: "on" }),
      }, { socketPath: fixture.proposalSocketPath }),
      (error) => error.code === "invalid_device_test",
    );
    for (const proposal of [
      deviceTestProposal({
        domain: "lock",
        entityId: "lock.front_door",
      }),
      deviceTestProposal({ service: "restart" }),
      deviceTestProposal({
        domain: "homeassistant",
        service: "restart",
        entityId: "homeassistant.fixture",
      }),
    ]) {
      await assert.rejects(
        sendBrokerRequest("propose", { proposal }, {
          socketPath: fixture.proposalSocketPath,
        }),
        (error) => error.code === "unsupported_device_test",
      );
    }
    assert.equal(fixture.ha.serviceMutationCalls, 0);
  } finally {
    await fixture.close();
  }
});

test("risk, requester, digest, expiry, capability, and unsupported operations fail closed", async () => {
  const fixture = await createFixture();
  try {
    const highRisk = await sendBrokerRequest("propose", {
      proposal: {
        requester: REQUESTER,
        operation: "service_call",
        summary: "Operate a safety-sensitive water pump",
        ttl_seconds: 30,
        payload: {
          domain: "switch",
          service: "turn_on",
          entity_id: "switch.water_pump",
          expected_state: "off",
        },
      },
    }, { socketPath: fixture.proposalSocketPath });
    assert.equal(highRisk.risk, "high");
    await assert.rejects(
      authorize(fixture.socketPath, highRisk, "autonomous_policy"),
      (error) => error instanceof BrokerError && error.code === "human_confirmation_required",
    );
    await assert.rejects(
      sendBrokerRequest("authorize", {
        proposal_id: highRisk.proposal_id,
        requester: { ...REQUESTER, chat_id: "-20003" },
        preview_digest: highRisk.preview_digest,
        authorization: "human_confirmed",
      }, { socketPath: fixture.socketPath }),
      (error) => error.code === "requester_mismatch",
    );
    await assert.rejects(
      sendBrokerRequest("authorize", {
        proposal_id: highRisk.proposal_id,
        requester: REQUESTER,
        preview_digest: `sha256:${"0".repeat(64)}`,
        authorization: "human_confirmed",
      }, { socketPath: fixture.socketPath }),
      (error) => error.code === "preview_mismatch",
    );
    const human = await authorize(fixture.socketPath, highRisk, "human_confirmed");
    await assert.rejects(
      execute(fixture.socketPath, highRisk, `${human.capability}x`, "bad-capability-0001"),
      (error) => error.code === "invalid_capability" || error.code === "invalid_request",
    );

    fixture.advance(31_000);
    await assert.rejects(
      execute(fixture.socketPath, highRisk, human.capability, "expired-capability-0001"),
      (error) => error.code === "proposal_unavailable" || error.code === "proposal_expired",
    );

    for (const operation of ["restart", "update", "restore", "delete"]) {
      await assert.rejects(
        sendBrokerRequest("propose", {
          proposal: {
            requester: REQUESTER,
            operation,
            summary: `${operation} Home Assistant`,
            payload: {},
          },
        }, { socketPath: fixture.proposalSocketPath }),
        (error) => error.code === "unsupported_operation",
      );
    }
    await assert.rejects(
      sendBrokerRequest("propose", {
        proposal: configProposal("secrets.yaml", "missing", "password: exposed\n"),
      }, { socketPath: fixture.proposalSocketPath }),
      (error) => error.code === "sensitive_target",
    );
    await symlink("fixture.yaml", join(fixture.configRoot, "themes", "linked.yaml"));
    await assert.rejects(
      sendBrokerRequest("propose", {
        proposal: configProposal("themes/linked.yaml", "missing", "safe: true\n"),
      }, { socketPath: fixture.proposalSocketPath }),
      (error) => error.code === "unsafe_target",
    );
  } finally {
    await fixture.close();
  }
});

test("proposal MCP exposes no authorize or execute tool and forwards the typed requester", async () => {
  const requests = [];
  const handle = createMcpRequestHandler({
    requester: REQUESTER,
    brokerRequest: async (action, payload) => {
      requests.push({ action, payload });
      return {
        proposal_id: "proposal-fixture",
        operation: payload.proposal.operation,
        risk: "high",
        requester: REQUESTER,
        preview: { summary: "fixture" },
        preview_digest: `sha256:${"1".repeat(64)}`,
        expires_at: "2026-08-11T00:02:00.000Z",
      };
    },
  });
  const initialize = await handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  assert.equal(initialize.result.serverInfo.name, "antigravity-ha-change-proposal");
  const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["ha_change_propose"]);
  assert.equal(JSON.stringify(list).includes("ha_change_execute"), false);
  assert.equal(JSON.stringify(list).includes("ha_change_authorize"), false);
  assert.equal(Object.hasOwn(list.result.tools[0].inputSchema.properties, "requester"), false);
  assert.equal(list.result.tools[0].inputSchema.required.includes("requester"), false);
  assert.equal(
    list.result.tools[0].inputSchema.properties.operation.enum.includes("device_test"),
    true,
  );
  assert.equal(
    JSON.stringify(list.result.tools[0].inputSchema).includes("expected_prior_state"),
    true,
  );

  const args = {
    operation: "service_call",
    summary: "Turn on fixture light",
    payload: {
      domain: "light",
      service: "turn_on",
      entity_id: "light.fixture",
      expected_state: "off",
    },
  };
  const call = await handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "ha_change_propose", arguments: args },
  });
  assert.equal(call.result.isError, false);
  assert.equal(call.result.structuredContent.proposal.risk, "high");
  assert.deepEqual(requests, [{
    action: "propose",
    payload: { proposal: { ...args, requester: REQUESTER } },
  }]);
  assert.equal(JSON.stringify(call).includes(TOKEN_CANARY), false);

  const deviceArgs = {
    operation: "device_test",
    summary: "Briefly test and restore the fixture light",
    payload: {
      domain: "light",
      service: "turn_on",
      entity_id: "light.fixture",
      expected_prior_state: "off",
    },
  };
  const deviceCall = await handle({
    jsonrpc: "2.0",
    id: 30,
    method: "tools/call",
    params: { name: "ha_change_propose", arguments: deviceArgs },
  });
  assert.equal(deviceCall.result.isError, false);
  assert.equal(deviceCall.result.structuredContent.proposal.operation, "device_test");
  assert.deepEqual(requests.at(-1), {
    action: "propose",
    payload: { proposal: { ...deviceArgs, requester: REQUESTER } },
  });

  const spoof = await handle({
    jsonrpc: "2.0",
    id: 31,
    method: "tools/call",
    params: {
      name: "ha_change_propose",
      arguments: { ...args, requester: { ...REQUESTER, chat_id: "-29999" } },
    },
  });
  assert.equal(spoof.result.isError, true);
  assert.equal(spoof.result.structuredContent.error, "requester_override_forbidden");
  assert.equal(requests.length, 2);

  const forbidden = await handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "ha_change_execute", arguments: {} },
  });
  assert.equal(forbidden.error.code, -32602);

  assert.deepEqual(
    telegramRequesterFromEnvironment({
      HA_TELEGRAM_USER_ID: REQUESTER.user_id,
      HA_TELEGRAM_CHAT_ID: REQUESTER.chat_id,
    }),
    REQUESTER,
  );
  assert.throws(
    () => telegramRequesterFromEnvironment({
      HA_TELEGRAM_USER_ID: "not-an-id",
      HA_TELEGRAM_CHAT_ID: REQUESTER.chat_id,
    }),
    (error) => error instanceof BrokerError && error.code === "invalid_requester_binding",
  );
});
