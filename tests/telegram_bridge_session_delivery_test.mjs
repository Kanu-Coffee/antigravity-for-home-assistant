import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  drainPendingResponseDeliveries,
  drainResponseDelivery,
  handleMessage,
  processPrompt,
  responseDeliveryId,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs";
import {
  bindSessionConversation,
  ensureSession,
  getPendingApproval,
  getPendingDelivery,
  getSession,
  getTerminalTurn,
  listPendingDeliveries,
  markDeliveryAttempting,
  queueResponseDelivery,
  recoverAttemptingDeliveries,
  savePendingApproval,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-state.mjs";

const BOT_TOKEN = `123456:${"A".repeat(35)}`;
const config = {
  enabled: true,
  botToken: BOT_TOKEN,
  toolPermission: "request-review",
  allowedUsers: new Set([
    "100", "200", "300", "400", "500", "600", "700", "800", "900", "1000", "1100", "1200",
  ]),
  allowedChats: new Set([
    "-100", "-200", "-300", "-400", "-500", "-600", "-700", "-800", "-900", "-1000", "-1100", "-1200",
  ]),
};

const fixtureRoot = await mkdtemp(join(tmpdir(), "telegram-session-delivery-"));
try {
  const statePath = join(fixtureRoot, "telegram", "bridge-state.json");
  const sent = [];
  const api = async (_token, method, body) => {
    if (method === "sendMessage") sent.push(body.text);
    return true;
  };
  const runnerCalls = [];
  const runPrompt = async (prompt, options) => {
    runnerCalls.push({ prompt, conversationId: options.conversationId });
    const conversationId = options.conversationId ?? "conversation.stable";
    options.onConversation(conversationId);
    return {
      response: `reply:${prompt}`,
      proposalIds: [],
      conversationId,
    };
  };
  let acknowledged = 0;
  const common = {
    statePath,
    runPrompt,
    executionLookup: async () => null,
    api,
    acknowledgeInput: () => { acknowledged += 1; },
  };
  await processPrompt(config, {
    updateId: 1,
    from: { id: "100" },
    chat: { id: "-100" },
    text: "first",
  }, null, common);
  await processPrompt(config, {
    updateId: 2,
    from: { id: "100" },
    chat: { id: "-100" },
    text: "second",
  }, null, common);
  assert.deepEqual(runnerCalls, [
    { prompt: "first", conversationId: null },
    { prompt: "second", conversationId: "conversation.stable" },
  ]);
  assert.deepEqual(sent, ["reply:first", "reply:second"]);
  assert.equal(acknowledged, 2);
  assert.deepEqual(getSession("100", "-100", { path: statePath }), {
    user_id: "100",
    chat_id: "-100",
    generation: 1,
    conversation_id: "conversation.stable",
  });

  let parserFailureCalls = 0;
  await assert.rejects(processPrompt(config, {
    updateId: 3,
    from: { id: "200" },
    chat: { id: "-200" },
    text: "bind before terminal failure",
  }, null, {
    statePath,
    executionLookup: async () => null,
    api,
    runPrompt: async (_prompt, options) => {
      parserFailureCalls += 1;
      options.onConversation("conversation.bound-before-failure");
      throw new Error("synthetic terminal parse failure");
    },
  }), /terminal parse failure/u);
  assert.equal(parserFailureCalls, 1);
  assert.equal(
    getSession("200", "-200", { path: statePath }).conversation_id,
    "conversation.bound-before-failure",
  );
  await processPrompt(config, {
    updateId: 4,
    from: { id: "200" },
    chat: { id: "-200" },
    text: "resume after failure",
  }, null, {
    statePath,
    executionLookup: async () => null,
    api,
    runPrompt: async (_prompt, options) => {
      assert.equal(options.conversationId, "conversation.bound-before-failure");
      options.onConversation(options.conversationId);
      return {
        response: "resumed",
        proposalIds: [],
        conversationId: options.conversationId,
      };
    },
  });

  let deliveryWorkerCalls = 0;
  let deliveryAcknowledgements = 0;
  const ambiguousApi = async (_token, method) => {
    if (method === "sendChatAction") return true;
    const error = new TypeError("synthetic transport loss");
    error.cause = { code: "ECONNRESET" };
    throw error;
  };
  const ambiguousOptions = {
    statePath,
    executionLookup: async () => null,
    api: ambiguousApi,
    acknowledgeInput: () => { deliveryAcknowledgements += 1; },
    runPrompt: async (_prompt, options) => {
      deliveryWorkerCalls += 1;
      const conversationId = options.conversationId ?? "conversation.delivery";
      options.onConversation(conversationId);
      return { response: "durable response", proposalIds: [], conversationId };
    },
  };
  const deliveryMessage = {
    updateId: 5,
    from: { id: "300" },
    chat: { id: "-300" },
    text: "deliver once",
  };
  await processPrompt(config, deliveryMessage, null, ambiguousOptions);
  assert.equal(deliveryWorkerCalls, 1);
  assert.equal(deliveryAcknowledgements, 1);
  let pending = listPendingDeliveries(BOT_TOKEN, { path: statePath });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "ambiguous");

  await processPrompt(config, deliveryMessage, null, ambiguousOptions);
  assert.equal(deliveryWorkerCalls, 1, "sealed update replay must not rerun the model");
  assert.equal(deliveryAcknowledgements, 2);
  pending = listPendingDeliveries(BOT_TOKEN, { path: statePath });
  await drainResponseDelivery(pending[0], BOT_TOKEN, {
    statePath,
    includeAmbiguous: true,
    api,
  });
  assert.deepEqual(listPendingDeliveries(BOT_TOKEN, { path: statePath }), []);
  assert.equal(sent.at(-1), "durable response");

  const crashApiPayloads = [];
  const crashApi = async (_token, method, body) => {
    if (method === "sendMessage") crashApiPayloads.push(body);
    return true;
  };
  const crashFinalize = () => {
    throw new Error("synthetic crash before atomic terminal finalize");
  };

  const plainCrashMessage = {
    updateId: 80,
    from: { id: "800" },
    chat: { id: "-800" },
    text: "journal plain response",
  };
  let plainModelCalls = 0;
  let plainLookups = 0;
  let plainAcknowledgements = 0;
  const plainRunPrompt = async (_prompt, options) => {
    plainModelCalls += 1;
    const conversationId = "conversation.journal-plain";
    options.onConversation(conversationId);
    return { response: "journaled plain reply", proposalIds: [], conversationId };
  };
  await assert.rejects(processPrompt(config, plainCrashMessage, null, {
    statePath,
    runPrompt: plainRunPrompt,
    executionLookup: async () => { plainLookups += 1; return null; },
    terminalFinalize: crashFinalize,
    api: crashApi,
    acknowledgeInput: () => { plainAcknowledgements += 1; },
  }), /synthetic crash/u);
  const plainTerminalId = responseDeliveryId("800", "-800", 80, "terminal");
  assert.equal(
    getTerminalTurn(plainTerminalId, BOT_TOKEN, { path: statePath }).response,
    "journaled plain reply",
  );
  await processPrompt(config, plainCrashMessage, null, {
    statePath,
    runPrompt: async () => {
      plainModelCalls += 1;
      throw new Error("model must not rerun for a journaled plain response");
    },
    executionLookup: async () => { plainLookups += 1; return null; },
    api: crashApi,
    acknowledgeInput: () => { plainAcknowledgements += 1; },
  });
  assert.equal(plainModelCalls, 1);
  assert.equal(plainLookups, 0, "ordinary updates must never query execution recovery");
  assert.equal(plainAcknowledgements, 1, "input ACK must follow atomic terminal finalize");
  assert.equal(getTerminalTurn(plainTerminalId, BOT_TOKEN, { path: statePath }), null);
  assert.equal(crashApiPayloads.at(-1).text, "journaled plain reply");

  const humanProposal = {
    proposal_id: "proposalJournalHuman",
    requester: { surface: "telegram", user_id: "900", chat_id: "-900" },
    operation: "service_call",
    risk: "high",
    preview: { domain: "light", service: "turn_on" },
    preview_digest: `sha256:${"2".repeat(64)}`,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const humanCrashMessage = {
    updateId: 90,
    from: { id: "900" },
    chat: { id: "-900" },
    text: "journal approval response",
  };
  let humanModelCalls = 0;
  let humanInspectCalls = 0;
  let humanLookups = 0;
  let humanAcknowledgements = 0;
  const humanRunPrompt = async (_prompt, options) => {
    humanModelCalls += 1;
    const conversationId = "conversation.journal-human";
    options.onConversation(conversationId);
    return {
      response: "journaled approval reply",
      proposalIds: [humanProposal.proposal_id],
      conversationId,
    };
  };
  const humanInspect = async () => {
    humanInspectCalls += 1;
    return humanProposal;
  };
  await assert.rejects(processPrompt(config, humanCrashMessage, null, {
    statePath,
    runPrompt: humanRunPrompt,
    executionLookup: async () => { humanLookups += 1; return null; },
    proposalInspect: humanInspect,
    terminalFinalize: crashFinalize,
    api: crashApi,
    acknowledgeInput: () => { humanAcknowledgements += 1; },
  }), /synthetic crash/u);
  const humanTerminalId = responseDeliveryId("900", "-900", 90, "terminal");
  assert.equal(
    getTerminalTurn(humanTerminalId, BOT_TOKEN, { path: statePath }).proposal_id,
    humanProposal.proposal_id,
  );
  await processPrompt(config, humanCrashMessage, null, {
    statePath,
    runPrompt: async () => {
      humanModelCalls += 1;
      throw new Error("model must not rerun for a journaled approval response");
    },
    executionLookup: async () => { humanLookups += 1; return null; },
    proposalInspect: humanInspect,
    api: crashApi,
    acknowledgeInput: () => { humanAcknowledgements += 1; },
  });
  assert.equal(humanModelCalls, 1);
  assert.equal(humanLookups, 1, "proposal replay may check for a completed execution");
  assert.equal(humanInspectCalls, 2);
  assert.equal(humanAcknowledgements, 1);
  assert.equal(getTerminalTurn(humanTerminalId, BOT_TOKEN, { path: statePath }), null);
  assert.match(crashApiPayloads.at(-1).text, /이 변경을 실행할까요/u);
  assert.equal(Array.isArray(crashApiPayloads.at(-1).reply_markup.inline_keyboard), true);

  const autonomousConfig = { ...config, toolPermission: "always-proceed" };
  const autonomousProposal = {
    proposal_id: "proposalJournalAutonomous",
    requester: { surface: "telegram", user_id: "1000", chat_id: "-1000" },
    operation: "service_call",
    risk: "low",
    preview: { domain: "light", service: "turn_off" },
    preview_digest: `sha256:${"3".repeat(64)}`,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const autonomousCrashMessage = {
    updateId: 100,
    from: { id: "1000" },
    chat: { id: "-1000" },
    text: "journal autonomous response",
  };
  const autonomousResult = {
    status: "completed",
    operation: "service_call",
    changed: true,
  };
  let autonomousModelCalls = 0;
  let autonomousInspectCalls = 0;
  let autonomousExecuteCalls = 0;
  let autonomousLookups = 0;
  let autonomousAcknowledgements = 0;
  const autonomousRunPrompt = async (_prompt, options) => {
    autonomousModelCalls += 1;
    const conversationId = "conversation.journal-autonomous";
    options.onConversation(conversationId);
    return {
      response: "journaled autonomous reply",
      proposalIds: [autonomousProposal.proposal_id],
      conversationId,
    };
  };
  const autonomousInspect = async () => {
    autonomousInspectCalls += 1;
    return autonomousProposal;
  };
  const autonomousExecute = async () => {
    autonomousExecuteCalls += 1;
    return autonomousResult;
  };
  await assert.rejects(processPrompt(autonomousConfig, autonomousCrashMessage, null, {
    statePath,
    runPrompt: autonomousRunPrompt,
    executionLookup: async () => { autonomousLookups += 1; return null; },
    proposalInspect: autonomousInspect,
    proposalExecute: autonomousExecute,
    terminalFinalize: crashFinalize,
    api: crashApi,
    acknowledgeInput: () => { autonomousAcknowledgements += 1; },
  }), /synthetic crash/u);
  const autonomousTerminalId = responseDeliveryId("1000", "-1000", 100, "terminal");
  assert.equal(
    getTerminalTurn(autonomousTerminalId, BOT_TOKEN, { path: statePath }).proposal_id,
    autonomousProposal.proposal_id,
  );
  await processPrompt(autonomousConfig, autonomousCrashMessage, null, {
    statePath,
    runPrompt: async () => {
      autonomousModelCalls += 1;
      throw new Error("model must not rerun for a journaled autonomous response");
    },
    executionLookup: async () => {
      autonomousLookups += 1;
      return autonomousResult;
    },
    proposalInspect: autonomousInspect,
    proposalExecute: autonomousExecute,
    api: crashApi,
    acknowledgeInput: () => { autonomousAcknowledgements += 1; },
  });
  assert.equal(autonomousModelCalls, 1);
  assert.equal(autonomousLookups, 1);
  assert.equal(autonomousInspectCalls, 1);
  assert.equal(autonomousExecuteCalls, 1, "replay must recover, not repeat, execution");
  assert.equal(autonomousAcknowledgements, 1);
  assert.equal(getTerminalTurn(autonomousTerminalId, BOT_TOKEN, { path: statePath }), null);
  assert.match(crashApiPayloads.at(-1).text, /Broker 실행 결과/u);

  const attemptingSession = ensureSession("400", "-400", { path: statePath });
  const durableMarkup = {
    inline_keyboard: [[
      { text: "Run", callback_data: "v2a:approvalFixture123456" },
      { text: "Cancel", callback_data: "v2d:approvalFixture123456" },
    ]],
  };
  const attemptingDelivery = queueResponseDelivery({
    delivery_id: "delivery-attempting-fixture",
    update_id: 40,
    user_id: "400",
    chat_id: "-400",
    generation: attemptingSession.generation,
    stage: "approval",
    chunks: ["durable approval preview"],
    reply_markup: durableMarkup,
  }, BOT_TOKEN, { path: statePath });
  let observedAttempting = false;
  const serverFailure = new Error("synthetic upstream failure");
  serverFailure.status = 503;
  const failed = await drainResponseDelivery(attemptingDelivery, BOT_TOKEN, {
    statePath,
    api: async () => {
      observedAttempting = getPendingDelivery(
        attemptingDelivery.delivery_id,
        BOT_TOKEN,
        { path: statePath },
      ).status === "attempting";
      throw serverFailure;
    },
  });
  assert.equal(observedAttempting, true, "attempting must be fsynced before sendMessage");
  assert.equal(failed.status, "ambiguous", "5xx delivery outcome is ambiguous");
  assert.equal(
    getPendingDelivery(attemptingDelivery.delivery_id, BOT_TOKEN, { path: statePath }).status,
    "ambiguous",
  );
  let automaticResends = 0;
  await drainPendingResponseDeliveries(config, {
    statePath,
    api: async () => { automaticResends += 1; },
  });
  assert.equal(automaticResends, 0, "ambiguous deliveries must not auto-resend");
  const retriedPayloads = [];
  await handleMessage(config, {
    updateId: 41,
    from: { id: "400" },
    chat: { id: "-400", type: "private" },
    text: "/retry",
  }, {
    statePath,
    api: async (_token, method, body) => {
      if (method === "sendMessage") retriedPayloads.push(body);
      return true;
    },
    send: async () => {},
  });
  assert.equal(retriedPayloads.length, 1);
  assert.deepEqual(retriedPayloads[0].reply_markup, durableMarkup);
  assert.equal(getPendingDelivery(attemptingDelivery.delivery_id, BOT_TOKEN, {
    path: statePath,
  }), null);

  const rateLimitedSession = ensureSession("500", "-500", { path: statePath });
  const rateLimited = queueResponseDelivery({
    delivery_id: "delivery-rate-limit-fixture",
    update_id: 50,
    user_id: "500",
    chat_id: "-500",
    generation: rateLimitedSession.generation,
    stage: "assistant",
    chunks: ["rate limited response"],
    reply_markup: null,
  }, BOT_TOKEN, { path: statePath });
  let rateLimitCalls = 0;
  const rateLimitApi = async () => {
    rateLimitCalls += 1;
    const error = new Error("synthetic rate limit");
    error.status = 429;
    error.retryAfter = 1;
    throw error;
  };
  assert.deepEqual(await drainResponseDelivery(rateLimited, BOT_TOKEN, {
    statePath,
    api: rateLimitApi,
    wait: async () => {},
    retryLimit: 3,
  }), { status: "pending", next_chunk_index: 0 });
  assert.equal(rateLimitCalls, 3);
  await drainPendingResponseDeliveries(config, {
    statePath,
    api: rateLimitApi,
    wait: async () => {},
    retryLimit: 3,
  });
  assert.equal(rateLimitCalls, 3, "bounded retries must survive polling iterations");

  const restartSession = ensureSession("600", "-600", { path: statePath });
  const restartDelivery = queueResponseDelivery({
    delivery_id: "delivery-restart-fixture",
    update_id: 60,
    user_id: "600",
    chat_id: "-600",
    generation: restartSession.generation,
    stage: "assistant",
    chunks: ["uncertain after restart"],
    reply_markup: null,
  }, BOT_TOKEN, { path: statePath });
  markDeliveryAttempting(restartDelivery.delivery_id, 0, { path: statePath });
  assert.equal(recoverAttemptingDeliveries({ path: statePath }), 1);
  let restartResends = 0;
  await drainPendingResponseDeliveries(config, {
    statePath,
    api: async () => { restartResends += 1; },
  });
  assert.equal(restartResends, 0, "startup recovery must not resend an uncertain attempt");
  await handleMessage(config, {
    updateId: 61,
    from: { id: "600" },
    chat: { id: "-600", type: "private" },
    text: "/new",
  }, { statePath, api, send: async () => {} });
  await handleMessage(config, {
    updateId: 62,
    from: { id: "600" },
    chat: { id: "-600", type: "private" },
    text: "/retry",
  }, {
    statePath,
    api: async () => { restartResends += 1; },
    send: async () => {},
  });
  assert.equal(restartResends, 0, "/retry must not cross an explicit /new generation");

  const forbiddenSession = ensureSession("700", "-700", { path: statePath });
  const forbidden = queueResponseDelivery({
    delivery_id: "delivery-forbidden-fixture",
    update_id: 70,
    user_id: "700",
    chat_id: "-700",
    generation: forbiddenSession.generation,
    stage: "assistant",
    chunks: ["blocked response"],
    reply_markup: null,
  }, BOT_TOKEN, { path: statePath });
  let forbiddenCalls = 0;
  const forbiddenResult = await drainResponseDelivery(forbidden, BOT_TOKEN, {
    statePath,
    api: async () => {
      forbiddenCalls += 1;
      const error = new Error("synthetic chat forbidden");
      error.status = 403;
      throw error;
    },
  });
  assert.deepEqual(forbiddenResult, { status: "pending", next_chunk_index: 0 });
  assert.equal(forbiddenCalls, 1, "sendMessage 403 must be contained as a delivery error");

  const newControlSession = ensureSession("1100", "-1100", { path: statePath });
  bindSessionConversation(
    "1100",
    "-1100",
    newControlSession.generation,
    "conversation.control-new",
    { path: statePath },
  );
  const newControlMessage = {
    updateId: 110,
    from: { id: "1100" },
    chat: { id: "-1100", type: "private" },
    text: "/new",
  };
  await assert.rejects(handleMessage(config, newControlMessage, {
    statePath,
    api,
    send: async () => { throw new Error("synthetic new confirmation loss"); },
  }), /confirmation loss/u);
  assert.equal(getSession("1100", "-1100", { path: statePath }).generation, 2);
  const replayedNewConfirmations = [];
  await handleMessage(config, newControlMessage, {
    statePath,
    api,
    send: async (_token, _chatId, text) => replayedNewConfirmations.push(text),
  });
  assert.equal(
    getSession("1100", "-1100", { path: statePath }).generation,
    2,
    "replaying a failed /new confirmation must not increment the generation again",
  );
  assert.match(replayedNewConfirmations[0], /새 대화/u);

  const cancelControlSession = ensureSession("1200", "-1200", { path: statePath });
  const cancelControlBound = bindSessionConversation(
    "1200",
    "-1200",
    cancelControlSession.generation,
    "conversation.control-cancel",
    { path: statePath },
  );
  const approvalRecord = (approvalId) => ({
    approval_id: approvalId,
    user_id: "1200",
    chat_id: "-1200",
    generation: cancelControlBound.generation,
    conversation_id: cancelControlBound.conversation_id,
    proposal_id: "proposalControlCancel",
    preview_digest: `sha256:${"4".repeat(64)}`,
    risk: "high",
    idempotency_key: `tg:1200:-1200:${approvalId}`,
    expires_at: Date.now() + 60_000,
    approved_update_id: null,
  });
  savePendingApproval(approvalRecord("approval-control-before"), BOT_TOKEN, {
    path: statePath,
  });
  const cancelControlMessage = {
    updateId: 120,
    from: { id: "1200" },
    chat: { id: "-1200", type: "private" },
    text: "/cancel",
  };
  await assert.rejects(handleMessage(config, cancelControlMessage, {
    statePath,
    api,
    send: async () => { throw new Error("synthetic cancel confirmation loss"); },
  }), /confirmation loss/u);
  assert.equal(getPendingApproval("approval-control-before", BOT_TOKEN, {
    path: statePath,
  }), null);
  savePendingApproval(approvalRecord("approval-control-after"), BOT_TOKEN, {
    path: statePath,
  });
  const replayedCancelConfirmations = [];
  await handleMessage(config, cancelControlMessage, {
    statePath,
    api,
    send: async (_token, _chatId, text) => replayedCancelConfirmations.push(text),
  });
  assert.notEqual(getPendingApproval("approval-control-after", BOT_TOKEN, {
    path: statePath,
  }), null, "replaying /cancel must not cancel work created after the original effect");
  assert.match(replayedCancelConfirmations[0], /승인 대기 제안 1개/u);

  const approvalSession = ensureSession("100", "-100", { path: statePath });
  savePendingApproval({
    approval_id: "approvalFixture123456",
    user_id: "100",
    chat_id: "-100",
    generation: approvalSession.generation,
    conversation_id: approvalSession.conversation_id,
    proposal_id: "proposalFixture123456",
    preview_digest: `sha256:${"1".repeat(64)}`,
    risk: "high",
    idempotency_key: "tg:100:-100:reset",
    expires_at: Date.now() + 60_000,
  }, BOT_TOKEN, { path: statePath });
  const commandMessages = [];
  await handleMessage(config, {
    updateId: 6,
    from: { id: "100" },
    chat: { id: "-100", type: "private" },
    text: "/new",
  }, {
    statePath,
    api,
    send: async (_token, _chatId, text) => commandMessages.push(text),
  });
  assert.deepEqual(getSession("100", "-100", { path: statePath }), {
    user_id: "100",
    chat_id: "-100",
    generation: 2,
    conversation_id: null,
  });
  assert.equal(
    getPendingApproval("approvalFixture123456", BOT_TOKEN, { path: statePath }),
    null,
  );
  assert.match(commandMessages[0], /새 대화/u);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("telegram bridge session and delivery integration tests passed");
