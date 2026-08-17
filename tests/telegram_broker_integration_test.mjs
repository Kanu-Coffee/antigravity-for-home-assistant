import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BrokerError } from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-change-broker.mjs";
import {
  applyNewSessionControl,
  bindSessionConversation,
  ensureSession,
  getPendingApproval,
  listPendingDeliveries,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-state.mjs";

const COORDINATOR_SOCKET = "/run/antigravity-ha/change-broker.sock";
const REQUESTER = {
  surface: "telegram",
  user_id: "100",
  chat_id: "-200",
};
const PREVIEW_DIGEST = `sha256:${"1".repeat(64)}`;
const CHANGED_DIGEST = `sha256:${"2".repeat(64)}`;
const VALID_BOT_TOKEN = `123456:${"A".repeat(35)}`;
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
let durableExecutionKey = DURABLE_CANCEL_KEY;
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
    if (request.payload.idempotency_key === durableExecutionKey) {
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
      request.payload.idempotency_key === durableExecutionKey) {
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
  if (request.action === "execute_status") {
    throw new BrokerError("execution_not_found", "fixture execution is absent");
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
        error: { code: error?.code ?? "fixture_error", message: error.message },
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
  bridgeSource += "\nexport { executeProposal, pendingApprovals };\n";
  const bridge = await import(
    `data:text/javascript;base64,${Buffer.from(bridgeSource).toString("base64")}`
  );
  const callbackOptions = {
    statePath: join(fixtureRoot, "telegram", "bridge-state.json"),
  };
  const callbackStateOptions = { path: callbackOptions.statePath };
  const callbackSession = bindSessionConversation(
    REQUESTER.user_id,
    REQUESTER.chat_id,
    ensureSession(REQUESTER.user_id, REQUESTER.chat_id, callbackStateOptions).generation,
    "conversation.approval-fixture",
    callbackStateOptions,
  );
  let callbackUpdateId = 1_000;
  const nextCallbackUpdateId = () => {
    callbackUpdateId += 1;
    return callbackUpdateId;
  };
  const createDurableApproval = (idempotencyKey) => bridge.createApproval({
    requester: REQUESTER,
    proposal: PROPOSAL,
    idempotencyKey,
    session: callbackSession,
  }, {
    botToken: VALID_BOT_TOKEN,
    statePath: callbackOptions.statePath,
  });
  assert.throws(() => bridge.createApproval({
    requester: REQUESTER,
    proposal: PROPOSAL,
    idempotencyKey: "tg:100:-200:in-memory-forbidden",
  }), /durable bound Telegram session/u);

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
  const approval = createDurableApproval("tg:100:-200:43");
  const callback = {
    updateId: nextCallbackUpdateId(),
    id: "callback-fixture",
    data: `v2a:${approval.id}`,
    from: { id: REQUESTER.user_id },
    message: { chat: { id: REQUESTER.chat_id } },
  };
  let callbackAcknowledgements = 0;
  await bridge.handleCallback({ botToken: VALID_BOT_TOKEN }, callback, {
    ...callbackOptions,
    acknowledgeInput: () => {
      callbackAcknowledgements += 1;
      assert.equal(
        getPendingApproval(approval.id, VALID_BOT_TOKEN, callbackStateOptions),
        null,
      );
      assert.equal(
        listPendingDeliveries(VALID_BOT_TOKEN, callbackStateOptions)
          .some((delivery) => delivery.update_id === callback.updateId &&
            delivery.stage === "execution" && delivery.status === "pending"),
        true,
      );
      assert.equal(
        telegramRequests.some((request) => request.url.endsWith("/sendMessage")),
        false,
      );
    },
  });
  assert.equal(callbackAcknowledgements, 1);
  assert.deepEqual(
    brokerRequests.map((request) => request.action),
    ["inspect", "authorize", "execute"],
  );
  assert.equal(brokerRequests[2].payload.idempotency_key, "tgcb:100:-200:1001");
  assert.equal(requestedSocketPaths.every((path) => path === COORDINATOR_SOCKET), true);

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  telegramRequests.length = 0;
  const duplicateUpdateId = nextCallbackUpdateId();
  durableExecutionKey = `tgcb:${REQUESTER.user_id}:${REQUESTER.chat_id}:${duplicateUpdateId}`;
  durableCompletionReady = true;
  let recoveredAcknowledgements = 0;
  await bridge.handleCallback({ botToken: VALID_BOT_TOKEN }, {
    ...callback,
    updateId: duplicateUpdateId,
    id: "callback-fixture-duplicate",
  }, {
    ...callbackOptions,
    acknowledgeInput: () => {
      recoveredAcknowledgements += 1;
      assert.equal(
        listPendingDeliveries(VALID_BOT_TOKEN, callbackStateOptions)
          .some((delivery) => delivery.update_id === duplicateUpdateId &&
            delivery.stage === "execution" && delivery.status === "pending"),
        true,
      );
      assert.equal(
        telegramRequests.some((request) => request.url.endsWith("/sendMessage")),
        false,
      );
    },
  });
  assert.deepEqual(brokerRequests.map((request) => request.action), ["execute_status"]);
  assert.deepEqual(requestedSocketPaths, [COORDINATOR_SOCKET]);
  assert.equal(recoveredAcknowledgements, 1);
  assert.equal(
    telegramRequests.some((request) => request.url.endsWith("/sendMessage")),
    true,
  );
  durableExecutionKey = DURABLE_CANCEL_KEY;
  durableCompletionReady = false;

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  telegramRequests.length = 0;
  const missingApprovalUpdateId = nextCallbackUpdateId();
  await bridge.handleCallback({ botToken: VALID_BOT_TOKEN }, {
    ...callback,
    updateId: missingApprovalUpdateId,
    id: "callback-missing-no-execution",
    data: `v2a:${"missingApproval1"}`,
  }, callbackOptions);
  assert.deepEqual(brokerRequests.map((request) => request.action), ["execute_status"]);
  assert.deepEqual(requestedSocketPaths, [COORDINATOR_SOCKET]);
  assert.equal(
    telegramRequests.some((request) => request.url.endsWith("/sendMessage")),
    false,
  );
  assert.equal(
    telegramRequests.some((request) =>
      request.url.endsWith("/answerCallbackQuery") &&
      request.body.callback_query_id === "callback-missing-no-execution" &&
      request.body.show_alert === true),
    true,
  );

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  telegramRequests.length = 0;
  inspectResult = { ...PROPOSAL, preview_digest: CHANGED_DIGEST };
  const changedApproval = createDurableApproval("tg:100:-200:44");
  const changedUpdateId = nextCallbackUpdateId();
  let failureAcknowledgements = 0;
  await bridge.handleCallback(
    { botToken: VALID_BOT_TOKEN },
    {
      ...callback,
      updateId: changedUpdateId,
      id: "callback-preview-changed",
      data: `v2a:${changedApproval.id}`,
    },
    {
      ...callbackOptions,
      acknowledgeInput: () => {
        failureAcknowledgements += 1;
        assert.equal(
          getPendingApproval(changedApproval.id, VALID_BOT_TOKEN, callbackStateOptions),
          null,
        );
        assert.equal(
          listPendingDeliveries(VALID_BOT_TOKEN, callbackStateOptions)
            .some((delivery) => delivery.update_id === changedUpdateId &&
              delivery.stage === "error" && delivery.status === "pending"),
          true,
        );
        assert.equal(
          telegramRequests.some((request) => request.url.endsWith("/sendMessage")),
          false,
        );
      },
    },
  );
  assert.equal(failureAcknowledgements, 1);
  assert.deepEqual(brokerRequests.map((request) => request.action), ["inspect"]);
  assert.deepEqual(requestedSocketPaths, [COORDINATOR_SOCKET]);

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  inspectResult = PROPOSAL;
  const requesterApproval = createDurableApproval("tg:100:-200:45");
  await bridge.handleCallback(
    { botToken: VALID_BOT_TOKEN },
    {
      ...callback,
      updateId: nextCallbackUpdateId(),
      id: "callback-wrong-requester",
      data: `v2a:${requesterApproval.id}`,
      from: { id: "101" },
    },
    callbackOptions,
  );
  assert.deepEqual(brokerRequests, []);
  assert.deepEqual(requestedSocketPaths, []);
  assert.equal(bridge.pendingApprovals.size, 1);

  telegramRequests.length = 0;
  await bridge.handleCallback(
    { botToken: VALID_BOT_TOKEN },
    {
      ...callback,
      updateId: nextCallbackUpdateId(),
      id: "callback-wrong-chat",
      data: `v2a:${requesterApproval.id}`,
      message: { chat: { id: "-201" } },
    },
    callbackOptions,
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
    { botToken: VALID_BOT_TOKEN },
    {
      ...callback,
      updateId: nextCallbackUpdateId(),
      id: "callback-owner-after-mismatch",
      data: `v2a:${requesterApproval.id}`,
    },
    callbackOptions,
  );
  assert.deepEqual(
    brokerRequests.map((request) => request.action),
    ["inspect", "authorize", "execute"],
  );
  assert.equal(bridge.pendingApprovals.size, 0);

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  const sessionOptions = callbackStateOptions;
  const restartApproval = createDurableApproval("tg:100:-200:approval-restart");
  assert.notEqual(
    getPendingApproval(restartApproval.id, VALID_BOT_TOKEN, sessionOptions),
    null,
  );
  bridge.pendingApprovals.clear();
  await bridge.handleCallback(
    { botToken: VALID_BOT_TOKEN },
    {
      ...callback,
      updateId: nextCallbackUpdateId(),
      id: "callback-after-restart",
      data: `v2a:${restartApproval.id}`,
    },
    callbackOptions,
  );
  assert.deepEqual(
    brokerRequests.map((request) => request.action),
    ["inspect", "authorize", "execute"],
  );
  assert.equal(
    getPendingApproval(restartApproval.id, VALID_BOT_TOKEN, sessionOptions),
    null,
  );

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  telegramRequests.length = 0;
  const deniedApproval = createDurableApproval("tg:100:-200:approval-denied-restart");
  bridge.pendingApprovals.clear();
  await bridge.handleCallback(
    { botToken: VALID_BOT_TOKEN },
    {
      ...callback,
      updateId: nextCallbackUpdateId(),
      id: "callback-denied-after-restart",
      data: `v2d:${deniedApproval.id}`,
    },
    callbackOptions,
  );
  assert.equal(
    getPendingApproval(deniedApproval.id, VALID_BOT_TOKEN, sessionOptions),
    null,
  );
  assert.deepEqual(brokerRequests, [], "a denied approval must never reach the broker");
  assert.deepEqual(requestedSocketPaths, []);
  assert.equal(
    telegramRequests.some((request) =>
      request.url.endsWith("/answerCallbackQuery") &&
      request.body.callback_query_id === "callback-denied-after-restart" &&
      request.body.text === "취소했습니다."),
    true,
  );

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  inspectResult = PROPOSAL;
  const transitionApproval = createDurableApproval("tg:100:-200:approval-transition");
  const transitionUpdateId = nextCallbackUpdateId();
  const transitionCallback = {
    ...callback,
    updateId: transitionUpdateId,
    id: "callback-approval-transition-crash",
    data: `v2a:${transitionApproval.id}`,
  };
  await assert.rejects(bridge.handleCallback(
    { botToken: VALID_BOT_TOKEN },
    transitionCallback,
    {
      ...callbackOptions,
      afterApprovalTransition: () => {
        throw new Error("synthetic crash after durable approval transition");
      },
    },
  ), /synthetic crash/u);
  const transitioned = getPendingApproval(
    transitionApproval.id,
    VALID_BOT_TOKEN,
    sessionOptions,
  );
  assert.equal(transitioned.approved_update_id, transitionUpdateId);
  assert.deepEqual(brokerRequests, [], "approval must be durable before broker inspection");
  telegramRequests.length = 0;
  let duplicateTapAcknowledgements = 0;
  const duplicateTapUpdateId = nextCallbackUpdateId();
  await bridge.handleCallback(
    { botToken: VALID_BOT_TOKEN },
    {
      ...transitionCallback,
      updateId: duplicateTapUpdateId,
      id: "callback-approval-double-tap",
    },
    {
      ...callbackOptions,
      acknowledgeInput: () => {
        duplicateTapAcknowledgements += 1;
        const pending = getPendingApproval(
          transitionApproval.id,
          VALID_BOT_TOKEN,
          sessionOptions,
        );
        assert.equal(pending.approved_update_id, transitionUpdateId);
        assert.equal(
          listPendingDeliveries(VALID_BOT_TOKEN, callbackStateOptions)
            .some((delivery) => delivery.update_id === duplicateTapUpdateId),
          false,
        );
      },
    },
  );
  assert.equal(duplicateTapAcknowledgements, 1);
  assert.deepEqual(brokerRequests, [], "a second callback must not repeat broker execution");
  assert.equal(
    telegramRequests.every((request) =>
      request.url.endsWith("/answerCallbackQuery")),
    true,
  );
  bridge.pendingApprovals.clear();
  await bridge.handleCallback(
    { botToken: VALID_BOT_TOKEN },
    transitionCallback,
    callbackOptions,
  );
  assert.deepEqual(
    brokerRequests.map((request) => request.action),
    ["inspect", "authorize", "execute"],
  );
  assert.equal(
    brokerRequests[2].payload.idempotency_key,
    `tgcb:${REQUESTER.user_id}:${REQUESTER.chat_id}:${transitionUpdateId}`,
  );
  assert.equal(
    getPendingApproval(transitionApproval.id, VALID_BOT_TOKEN, sessionOptions),
    null,
  );

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  telegramRequests.length = 0;
  durableCompletionReady = false;
  const durableApproval = createDurableApproval(DURABLE_CANCEL_KEY);
  const durableUpdateId = nextCallbackUpdateId();
  durableExecutionKey = `tgcb:${REQUESTER.user_id}:${REQUESTER.chat_id}:${durableUpdateId}`;
  const durableRun = bridge.handleCallback(
    { botToken: VALID_BOT_TOKEN },
    {
      ...callback,
      updateId: durableUpdateId,
      id: "callback-durable-cancel",
      data: `v2a:${durableApproval.id}`,
    },
    callbackOptions,
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

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  telegramRequests.length = 0;
  let releaseCancellationBlocker;
  let cancellationBlockerStarted;
  const cancellationBlockerReady = new Promise((resolve) => {
    cancellationBlockerStarted = resolve;
  });
  const cancellationBlocker = bridge.enqueueRequester(
    REQUESTER.user_id,
    REQUESTER.chat_id,
    async () => {
      cancellationBlockerStarted();
      await new Promise((resolve) => { releaseCancellationBlocker = resolve; });
    },
  );
  await cancellationBlockerReady;
  const cancelledApproval = createDurableApproval("tg:100:-200:queued-cancel");
  const cancelledUpdateId = nextCallbackUpdateId();
  let cancelledAcknowledgements = 0;
  const cancelledCallback = bridge.handleCallback(
    { botToken: VALID_BOT_TOKEN },
    {
      ...callback,
      updateId: cancelledUpdateId,
      id: "callback-queued-cancel",
      data: `v2a:${cancelledApproval.id}`,
    },
    {
      ...callbackOptions,
      acknowledgeInput: () => { cancelledAcknowledgements += 1; },
    },
  );
  assert.equal(
    getPendingApproval(cancelledApproval.id, VALID_BOT_TOKEN, sessionOptions)
      .approved_update_id,
    cancelledUpdateId,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    telegramRequests.some((request) =>
      request.url.endsWith("/answerCallbackQuery") &&
      request.body.callback_query_id === "callback-queued-cancel" &&
      request.body.text === "승인했습니다."),
    true,
    "Telegram callback acknowledgement must not wait behind the requester queue",
  );
  assert.deepEqual(brokerRequests, [], "queued approval execution must remain serialized");
  assert.deepEqual(
    bridge.cancelRequesterWork(REQUESTER.user_id, REQUESTER.chat_id, {
      botToken: VALID_BOT_TOKEN,
      statePath: callbackOptions.statePath,
    }),
    {
      queued_cancelled: 1,
      running_cancel_requested: 1,
      approvals_cancelled: 0,
      durable_in_progress: 0,
      workers_terminated: 0,
    },
  );
  releaseCancellationBlocker();
  await cancellationBlocker;
  await cancelledCallback;
  assert.equal(cancelledAcknowledgements, 1);
  assert.equal(
    getPendingApproval(cancelledApproval.id, VALID_BOT_TOKEN, sessionOptions),
    null,
  );
  assert.deepEqual(brokerRequests, [], "a queued cancelled approval must never reach the broker");

  brokerRequests.length = 0;
  requestedSocketPaths.length = 0;
  telegramRequests.length = 0;
  let releaseSessionBlocker;
  let sessionBlockerStarted;
  const sessionBlockerReady = new Promise((resolve) => { sessionBlockerStarted = resolve; });
  const sessionBlocker = bridge.enqueueRequester(
    REQUESTER.user_id,
    REQUESTER.chat_id,
    async () => {
      sessionBlockerStarted();
      await new Promise((resolve) => { releaseSessionBlocker = resolve; });
    },
  );
  await sessionBlockerReady;
  const staleApproval = createDurableApproval("tg:100:-200:queued-session-reset");
  const staleUpdateId = nextCallbackUpdateId();
  let staleAcknowledgements = 0;
  const staleCallback = bridge.handleCallback(
    { botToken: VALID_BOT_TOKEN },
    {
      ...callback,
      updateId: staleUpdateId,
      id: "callback-queued-session-reset",
      data: `v2a:${staleApproval.id}`,
    },
    {
      ...callbackOptions,
      acknowledgeInput: () => { staleAcknowledgements += 1; },
    },
  );
  assert.equal(
    getPendingApproval(staleApproval.id, VALID_BOT_TOKEN, sessionOptions)
      .approved_update_id,
    staleUpdateId,
  );
  const reset = applyNewSessionControl({
    update_id: 9_000_000,
    user_id: REQUESTER.user_id,
    chat_id: REQUESTER.chat_id,
    command: "new",
    result: "synthetic reset",
  }, VALID_BOT_TOKEN, sessionOptions);
  assert.equal(reset.session.generation, callbackSession.generation + 1);
  releaseSessionBlocker();
  await sessionBlocker;
  await staleCallback;
  assert.equal(staleAcknowledgements, 1);
  assert.equal(
    getPendingApproval(staleApproval.id, VALID_BOT_TOKEN, sessionOptions),
    null,
  );
  assert.deepEqual(brokerRequests, [], "an approval from an old session must never reach the broker");
  assert.equal(
    telegramRequests.some((request) => request.url.endsWith("/sendMessage") &&
      request.body.text.includes("이전 승인 요청을 실행하지 않았습니다")),
    true,
  );
} finally {
  net.createConnection = originalCreateConnection;
  globalThis.fetch = originalFetch;
  await new Promise((resolve) => brokerServer.close(resolve));
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("telegram broker integration tests passed");
