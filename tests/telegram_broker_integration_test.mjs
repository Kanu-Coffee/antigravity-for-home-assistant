import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BrokerError } from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-change-broker.mjs";

const COORDINATOR_SOCKET = "/run/antigravity-ha/change-broker.sock";
const REQUESTER = {
  surface: "telegram",
  user_id: "100",
  chat_id: "-200",
};
const PREVIEW_DIGEST = `sha256:${"1".repeat(64)}`;
const CHANGED_DIGEST = `sha256:${"2".repeat(64)}`;
const PROPOSAL = {
  proposal_id: "proposalFixture1234567890",
  operation: "service_call",
  risk: "high",
  requester: REQUESTER,
  preview: {
    summary: "Turn on the fixture light",
    service: "light.turn_on",
    entity_id: "light.fixture",
    expected_state: "off",
    verify_state: "on",
  },
  preview_digest: PREVIEW_DIGEST,
  expires_at: "2099-01-01T00:00:00.000Z",
};

const fixtureRoot = await mkdtemp(join(tmpdir(), "telegram-broker-integration-"));
const redirectedSocket = join(fixtureRoot, "coordinator.sock");
const brokerRequests = [];
const requestedSocketPaths = [];
const telegramRequests = [];
let inspectResult = PROPOSAL;
const DURABLE_CANCEL_KEY = "tg:100:-200:durable-cancel";
let durableCompletionReady = false;

function brokerResultFor(request) {
  brokerRequests.push(request);
  if (request.action === "health") return { status: "ready" };
  if (request.action === "inspect") return inspectResult;
  if (request.action === "authorize") {
    return {
      proposal_id: request.payload.proposal_id,
      preview_digest: request.payload.preview_digest,
      capability: "C".repeat(43),
      expires_at: "2099-01-01T00:00:00.000Z",
    };
  }
  if (request.action === "execute") {
    if (request.payload.idempotency_key === DURABLE_CANCEL_KEY) {
      return {
        status: "running",
        operation: "service_call",
        replayed: false,
      };
    }
    return {
      status: "completed",
      operation: "service_call",
      replayed: false,
      result: {
        status: "succeeded",
        operation: "service_call",
        changed: true,
      },
    };
  }
  if (request.action === "execute_status" &&
      request.payload.idempotency_key === DURABLE_CANCEL_KEY) {
    if (!durableCompletionReady) return { status: "running", operation: "service_call" };
    return {
      status: "completed",
      operation: "service_call",
      result: {
        status: "succeeded",
        operation: "service_call",
        changed: true,
      },
    };
  }
  throw new Error(`unexpected broker action: ${request.action}`);
}

const brokerServer = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline === -1) return;
    let request;
    try {
      request = JSON.parse(input.slice(0, newline));
      const result = brokerResultFor(request);
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    } catch (error) {
      socket.end(`${JSON.stringify({
        id: request?.id ?? null,
        ok: false,
        error: { code: "fixture_error", message: error.message },
      })}\n`);
    }
  });
});

await new Promise((resolve, reject) => {
  brokerServer.once("error", reject);
  brokerServer.listen(redirectedSocket, resolve);
});

const originalCreateConnection = net.createConnection;
const originalFetch = globalThis.fetch;
net.createConnection = function createRedirectedConnection(path) {
  requestedSocketPaths.push(typeof path === "string" ? path : path?.path);
  return originalCreateConnection.call(net, redirectedSocket);
};
globalThis.fetch = async (url, options) => {
  telegramRequests.push({ url: String(url), body: JSON.parse(options.body) });
  return new Response(JSON.stringify({ ok: true, result: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

try {
  const bridgeUrl = new URL(
    "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs",
    import.meta.url,
  );
  let bridgeSource = await readFile(fileURLToPath(bridgeUrl), "utf8");
  for (const dependency of [
    "ha-change-broker.mjs",
    "telegram-pairing.mjs",
    "telegram-state.mjs",
  ]) {
    bridgeSource = bridgeSource.replaceAll(
      `"./${dependency}"`,
      JSON.stringify(new URL(dependency, bridgeUrl).href),
    );
  }
  bridgeSource += "\nexport { executeProposal, handleCallback, pendingApprovals };\n";
  const bridge = await import(
    `data:text/javascript;base64,${Buffer.from(bridgeSource).toString("base64")}`
  );

  const inspected = await bridge.inspectProposal(PROPOSAL.proposal_id, REQUESTER);
  assert.deepEqual(inspected, PROPOSAL);
  assert.deepEqual(brokerRequests.map((request) => request.action), ["inspect"]);
  assert.deepEqual(brokerRequests[0].payload, {
    proposal_id: PROPOSAL.proposal_id,
    requester: REQUESTER,
  });
  assert.deepEqual(requestedSocketPaths, [COORDINATOR_SOCKET]);

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  const deviceTestProposal = {
    ...PROPOSAL,
    proposal_id: "deviceTestProposalFixture",
    operation: "device_test",
    preview: {
      format: "device-test-plan-v1",
      entity_id: "light.fixture",
      test: { service: "light.turn_on", verify_state: "on" },
      restore: { service: "light.turn_off", verify_state: "off", always: true },
    },
  };
  inspectResult = deviceTestProposal;
  assert.deepEqual(
    await bridge.inspectProposal(deviceTestProposal.proposal_id, REQUESTER),
    deviceTestProposal,
  );
  assert.deepEqual(brokerRequests.map((request) => request.action), ["inspect"]);

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  inspectResult = { ...PROPOSAL, requester: { ...REQUESTER, user_id: "101" } };
  await assert.rejects(
    bridge.inspectProposal(PROPOSAL.proposal_id, REQUESTER),
    /invalid proposal binding/u,
  );
  assert.deepEqual(brokerRequests.map((request) => request.action), ["inspect"]);

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  inspectResult = PROPOSAL;
  const direct = await bridge.executeProposal(
    PROPOSAL,
    REQUESTER,
    "human_confirmed",
    "tg:100:-200:42",
  );
  assert.equal(direct.status, "succeeded");
  assert.deepEqual(brokerRequests.map((request) => request.action), ["authorize", "execute"]);
  assert.deepEqual(brokerRequests[0].payload, {
    proposal_id: PROPOSAL.proposal_id,
    requester: REQUESTER,
    preview_digest: PREVIEW_DIGEST,
    authorization: "human_confirmed",
  });
  assert.deepEqual(brokerRequests[1].payload, {
    proposal_id: PROPOSAL.proposal_id,
    requester: REQUESTER,
    preview_digest: PREVIEW_DIGEST,
    capability: "C".repeat(43),
    idempotency_key: "tg:100:-200:42",
  });
  assert.equal(requestedSocketPaths.every((path) => path === COORDINATOR_SOCKET), true);

  const injectedActions = [];
  let executeAttempts = 0;
  let statusChecks = 0;
  const recoveredAfterTimeout = await bridge.executeProposal(
    PROPOSAL,
    REQUESTER,
    "human_confirmed",
    "tg:100:-200:timeout-recovery",
    {
      sleep: async () => {},
      pollIntervalMs: 0,
      waitTimeoutMs: 1_000,
      brokerRequest: async (action) => {
        injectedActions.push(action);
        if (action === "authorize") return { capability: "D".repeat(43) };
        if (action === "execute") {
          executeAttempts += 1;
          if (executeAttempts === 1) throw new BrokerError("timeout", "injected response loss");
          return { status: "running", operation: "service_call", replayed: true };
        }
        if (action === "execute_status") {
          statusChecks += 1;
          if (statusChecks === 1) return { status: "running", operation: "service_call" };
          return {
            status: "completed",
            operation: "service_call",
            result: { status: "succeeded", operation: "service_call", changed: true },
          };
        }
        throw new Error(`unexpected injected action: ${action}`);
      },
    },
  );
  assert.equal(recoveredAfterTimeout.status, "succeeded");
  assert.equal(recoveredAfterTimeout.replayed, true);
  assert.equal(executeAttempts, 2);
  assert.deepEqual(injectedActions, [
    "authorize",
    "execute",
    "execute",
    "execute_status",
    "execute_status",
  ]);

  let lookupAttempts = 0;
  const missingAfterTransientOutage = await bridge.lookupExecution(
    REQUESTER,
    "tg:100:-200:lookup-retry",
    {
      sleep: async () => {},
      pollIntervalMs: 0,
      waitTimeoutMs: 1_000,
      brokerRequest: async (action) => {
        assert.equal(action, "execute_status");
        lookupAttempts += 1;
        if (lookupAttempts === 1) throw new BrokerError("broker_unavailable", "injected outage");
        throw new BrokerError("execution_not_found", "injected missing record");
      },
    },
  );
  assert.equal(missingAfterTransientOutage, null);
  assert.equal(lookupAttempts, 2);

  let cancellableLookupAttempts = 0;
  const cancellableLookup = bridge.enqueueRequester("901", "-901", (ticket) =>
    bridge.lookupExecution(
      { surface: "telegram", user_id: "901", chat_id: "-901" },
      "tg:901:-901:cancel-lookup",
      {
        signal: ticket.cancellationController.signal,
        pollIntervalMs: 60_000,
        waitTimeoutMs: 120_000,
        sleep: () => new Promise(() => {}),
        brokerRequest: async () => {
          cancellableLookupAttempts += 1;
          throw new BrokerError("broker_unavailable", "injected prolonged outage");
        },
      },
    ));
  for (let attempt = 0; attempt < 100 && cancellableLookupAttempts === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(cancellableLookupAttempts, 1);
  const lookupCancelStartedAt = Date.now();
  const cancellableLookupRejected = assert.rejects(cancellableLookup, /cancelled/u);
  assert.deepEqual(bridge.cancelRequesterWork("901", "-901"), {
    queued_cancelled: 0,
    running_cancel_requested: 1,
    approvals_cancelled: 0,
    durable_in_progress: 0,
    workers_terminated: 0,
  });
  await cancellableLookupRejected;
  assert.ok(Date.now() - lookupCancelStartedAt < 500, "recovery lookup cancellation was not prompt");
  assert.equal(cancellableLookupAttempts, 1);

  let durableLookupAttempts = 0;
  let durableCompletionAllowed = false;
  let durableStateObserved;
  const durableStateReady = new Promise((resolve) => { durableStateObserved = resolve; });
  const recoveredDurableRun = bridge.enqueueRequester("902", "-902", (ticket) =>
    bridge.lookupExecution(
      { surface: "telegram", user_id: "902", chat_id: "-902" },
      "tg:902:-902:durable-recovery",
      {
        signal: ticket.cancellationController.signal,
        pollIntervalMs: 0,
        waitTimeoutMs: 1_000,
        sleep: () => new Promise((resolve) => setImmediate(resolve)),
        onExecutionFound: () => {
          ticket.phase = "durable_running";
          ticket.cancelled = false;
          durableStateObserved();
        },
        brokerRequest: async () => {
          durableLookupAttempts += 1;
          if (durableLookupAttempts === 1) {
            return { status: "accepted", operation: "service_call", replayed: true };
          }
          if (!durableCompletionAllowed) {
            return { status: "running", operation: "service_call", replayed: true };
          }
          return {
            status: "completed",
            operation: "service_call",
            replayed: true,
            result: { status: "succeeded", operation: "service_call", changed: true },
          };
        },
      },
    ));
  await durableStateReady;
  assert.deepEqual(bridge.cancelRequesterWork("902", "-902"), {
    queued_cancelled: 0,
    running_cancel_requested: 0,
    approvals_cancelled: 0,
    durable_in_progress: 1,
    workers_terminated: 0,
  });
  durableCompletionAllowed = true;
  assert.deepEqual(await recoveredDurableRun, {
    status: "succeeded",
    operation: "service_call",
    changed: true,
    replayed: true,
  });
  assert.equal(durableLookupAttempts >= 2, true);

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  telegramRequests.length = 0;
  const approval = bridge.createApproval({
    requester: REQUESTER,
    proposal: PROPOSAL,
    idempotencyKey: "tg:100:-200:43",
  });
  const callback = {
    id: "callback-fixture",
    data: `v2a:${approval.id}`,
    from: { id: REQUESTER.user_id },
    message: { chat: { id: REQUESTER.chat_id } },
  };
  await bridge.handleCallback({ botToken: "123456:fixture" }, callback);
  assert.deepEqual(
    brokerRequests.map((request) => request.action),
    ["inspect", "authorize", "execute"],
  );
  assert.equal(brokerRequests[2].payload.idempotency_key, "tg:100:-200:43");
  assert.equal(requestedSocketPaths.every((path) => path === COORDINATOR_SOCKET), true);

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  await bridge.handleCallback({ botToken: "123456:fixture" }, callback);
  assert.deepEqual(brokerRequests, []);
  assert.deepEqual(requestedSocketPaths, []);

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  inspectResult = { ...PROPOSAL, preview_digest: CHANGED_DIGEST };
  const changedApproval = bridge.createApproval({
    requester: REQUESTER,
    proposal: PROPOSAL,
    idempotencyKey: "tg:100:-200:44",
  });
  await bridge.handleCallback(
    { botToken: "123456:fixture" },
    {
      ...callback,
      id: "callback-preview-changed",
      data: `v2a:${changedApproval.id}`,
    },
  );
  assert.deepEqual(brokerRequests.map((request) => request.action), ["inspect"]);
  assert.deepEqual(requestedSocketPaths, [COORDINATOR_SOCKET]);

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  inspectResult = PROPOSAL;
  const requesterApproval = bridge.createApproval({
    requester: REQUESTER,
    proposal: PROPOSAL,
    idempotencyKey: "tg:100:-200:45",
  });
  await bridge.handleCallback(
    { botToken: "123456:fixture" },
    {
      ...callback,
      id: "callback-wrong-requester",
      data: `v2a:${requesterApproval.id}`,
      from: { id: "101" },
    },
  );
  assert.deepEqual(brokerRequests, []);
  assert.deepEqual(requestedSocketPaths, []);
  assert.equal(bridge.pendingApprovals.size, 1);

  telegramRequests.length = 0;
  await bridge.handleCallback(
    { botToken: "123456:fixture" },
    {
      ...callback,
      id: "callback-wrong-chat",
      data: `v2a:${requesterApproval.id}`,
      message: { chat: { id: "-201" } },
    },
  );
  assert.deepEqual(brokerRequests, []);
  assert.deepEqual(requestedSocketPaths, []);
  assert.equal(bridge.pendingApprovals.size, 1);
  assert.equal(
    telegramRequests.every((request) => request.url.endsWith("/answerCallbackQuery")),
    true,
  );

  telegramRequests.length = 0;
  await bridge.handleCallback(
    { botToken: "123456:fixture" },
    {
      ...callback,
      id: "callback-owner-after-mismatch",
      data: `v2a:${requesterApproval.id}`,
    },
  );
  assert.deepEqual(
    brokerRequests.map((request) => request.action),
    ["inspect", "authorize", "execute"],
  );
  assert.equal(bridge.pendingApprovals.size, 0);

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  telegramRequests.length = 0;
  durableCompletionReady = false;
  const durableApproval = bridge.createApproval({
    requester: REQUESTER,
    proposal: PROPOSAL,
    idempotencyKey: DURABLE_CANCEL_KEY,
  });
  const durableRun = bridge.handleCallback(
    { botToken: "123456:fixture" },
    {
      ...callback,
      id: "callback-durable-cancel",
      data: `v2a:${durableApproval.id}`,
    },
  );
  for (let attempt = 0; attempt < 100 &&
      !brokerRequests.some((request) => request.action === "execute"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(brokerRequests.some((request) => request.action === "execute"), true);
  assert.deepEqual(bridge.cancelRequesterWork(REQUESTER.user_id, REQUESTER.chat_id), {
    queued_cancelled: 0,
    running_cancel_requested: 0,
    approvals_cancelled: 0,
    durable_in_progress: 1,
    workers_terminated: 0,
  });
  durableCompletionReady = true;
  await durableRun;
  assert.equal(
    telegramRequests.some((request) =>
      request.url.endsWith("/sendMessage") &&
      request.body.text.includes("Broker 실행 결과") &&
      request.body.text.includes('"status": "succeeded"')),
    true,
  );
} finally {
  net.createConnection = originalCreateConnection;
  globalThis.fetch = originalFetch;
  await new Promise((resolve) => brokerServer.close(resolve));
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("telegram broker integration tests passed");
