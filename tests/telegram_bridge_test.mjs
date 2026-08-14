import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANTIGRAVITY_AUTH_REQUIRED_MARKER,
  ANTIGRAVITY_HEADLESS_PERMISSION_MARKER,
  AntigravityWorkerError,
  BoundedByteMatcher,
  TELEGRAM_WORKER_INTEGRITY_MARKER,
  TelegramPollBackoff,
  buildAgyArgs,
  cancelRequesterWork,
  chunkText,
  connectTelegram,
  dispatchNormalizedUpdate,
  dispatchUpdateBatch,
  enqueueRequester,
  holdTelegramFailClosed,
  isAuthorized,
  loadRuntimeConfig,
  metricsSnapshot,
  normalizeUpdate,
  pairingTokenFromMessage,
  parseStreamResult,
  pollUpdateBatches,
  proposalDisposition,
  requesterKey,
  resetMetricsForTest,
  resetUpdateRuntimeForTest,
  resetWorkerStatusForTest,
  renderCancellationResult,
  renderRequestFailure,
  renderWorkerStatus,
  requestFailureReason,
  runAntigravityPrompt,
  safeError,
  telegramTransportErrorCode,
  waitForTelegramAuthorization,
  workerStatusSnapshot,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs";
import {
  loadBridgeState,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-state.mjs";

const pollBackoff = new TelegramPollBackoff({ jitter: () => 0 });
assert.deepEqual(
  Array.from({ length: 6 }, () => pollBackoff.nextDelay(new Error("fixture"))),
  [2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
);
pollBackoff.reset();
assert.equal(pollBackoff.nextDelay(new Error("fixture")), 2_000);
const rateLimited = new Error("fixture");
rateLimited.status = 429;
rateLimited.retryAfter = 60;
assert.equal(pollBackoff.nextDelay(rateLimited), 60_000);
assert.throws(
  () => new TelegramPollBackoff({ jitter: () => 500 }).nextDelay(new Error("fixture")),
  /jitter/u,
);

const config = loadRuntimeConfig({
  telegram_enabled: true,
  telegram_bot_token: `123456:${"A".repeat(35)}`,
  telegram_allowed_user_ids: ["100"],
  telegram_allowed_chat_ids: ["-200"],
  telegram_access_mode: "confirm_changes",
});
assert.equal(
  ANTIGRAVITY_AUTH_REQUIRED_MARKER.toString("utf8"),
  "Error: authentication required. Run 'antigravity-real' to log in, then retry.",
);
assert.equal(
  ANTIGRAVITY_HEADLESS_PERMISSION_MARKER.toString("utf8"),
  'a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.',
);
assert.equal(
  TELEGRAM_WORKER_INTEGRITY_MARKER.toString("utf8"),
  "ha-telegram-worker: isolated native configuration is unavailable",
);
const authMarkerMatcher = new BoundedByteMatcher(ANTIGRAVITY_AUTH_REQUIRED_MARKER);
const authMarkerSplit = Math.floor(ANTIGRAVITY_AUTH_REQUIRED_MARKER.length / 2);
authMarkerMatcher.push(Buffer.concat([
  Buffer.alloc(4 * 1024 * 1024, 0x78),
  ANTIGRAVITY_AUTH_REQUIRED_MARKER.subarray(0, authMarkerSplit),
]));
assert.equal(authMarkerMatcher.matched, false);
assert.ok(authMarkerMatcher.bufferedBytes < ANTIGRAVITY_AUTH_REQUIRED_MARKER.length);
authMarkerMatcher.push(ANTIGRAVITY_AUTH_REQUIRED_MARKER.subarray(authMarkerSplit));
assert.equal(authMarkerMatcher.matched, true);
assert.equal(authMarkerMatcher.bufferedBytes, 0);
const nearAuthMarker = new BoundedByteMatcher(ANTIGRAVITY_AUTH_REQUIRED_MARKER);
nearAuthMarker.push(Buffer.from(
  "Error: authentication failed or timed out",
  "utf8",
));
assert.equal(nearAuthMarker.matched, false);
const permissionMarkerMatcher = new BoundedByteMatcher(
  ANTIGRAVITY_HEADLESS_PERMISSION_MARKER,
);
const permissionMarkerSplit = 17;
permissionMarkerMatcher.push(Buffer.concat([
  Buffer.alloc(4 * 1024 * 1024, 0x79),
  ANTIGRAVITY_HEADLESS_PERMISSION_MARKER.subarray(0, permissionMarkerSplit),
]));
assert.equal(permissionMarkerMatcher.matched, false);
assert.ok(
  permissionMarkerMatcher.bufferedBytes < ANTIGRAVITY_HEADLESS_PERMISSION_MARKER.length,
);
permissionMarkerMatcher.push(
  ANTIGRAVITY_HEADLESS_PERMISSION_MARKER.subarray(permissionMarkerSplit),
);
assert.equal(permissionMarkerMatcher.matched, true);
assert.equal(permissionMarkerMatcher.bufferedBytes, 0);
assert.throws(() => new BoundedByteMatcher(Buffer.alloc(0)), /non-empty bytes/u);

const transportCanary = "SECRET_TRANSPORT_DETAIL_CANARY";
const connectErrorFixtures = [
  {
    error: Object.assign(new TypeError("fetch failed"), {
      cause: { code: "EAI_AGAIN", message: transportCanary },
    }),
    reasonClass: "network",
    retryDelay: 2_000,
    transportCode: "EAI_AGAIN",
  },
  {
    error: Object.assign(new Error("timed out"), { name: "AbortError" }),
    reasonClass: "timeout",
    retryDelay: 2_000,
  },
  {
    error: Object.assign(new Error("rate limited"), { status: 429, retryAfter: 7 }),
    reasonClass: "4xx",
    retryDelay: 7_000,
  },
  {
    error: Object.assign(new Error("upstream unavailable"), { status: 503 }),
    reasonClass: "5xx",
    retryDelay: 2_000,
  },
];
for (const fixture of connectErrorFixtures) {
  const methods = [];
  const waits = [];
  const events = [];
  let failed = false;
  const bot = await connectTelegram(config, {
    api: async (_botToken, method) => {
      methods.push(method);
      if (!failed) {
        failed = true;
        throw fixture.error;
      }
      return method === "getMe" ? { id: 42 } : true;
    },
    wait: async (milliseconds) => waits.push(milliseconds),
    backoff: new TelegramPollBackoff({ jitter: () => 0 }),
    auditEvent: (event, fields) => events.push({ event, ...fields }),
  });
  assert.deepEqual(bot, { id: 42 });
  assert.deepEqual(methods, ["deleteWebhook", "deleteWebhook", "getMe"]);
  assert.deepEqual(waits, [fixture.retryDelay]);
  assert.equal(events[0].event, "connect_retry");
  assert.equal(events[0].reason_class, fixture.reasonClass);
  assert.equal(events[0].retry_in_seconds, Math.ceil(fixture.retryDelay / 1_000));
  assert.equal(events[0].transport_code, fixture.transportCode);
  assert.equal(events.at(-1).event, "connected");
  assert.equal(JSON.stringify(events).includes(transportCanary), false);
  assert.equal(JSON.stringify(events).includes(config.botToken), false);
}
assert.equal(telegramTransportErrorCode(connectErrorFixtures[0].error), "EAI_AGAIN");
assert.equal(telegramTransportErrorCode({ code: transportCanary }), "unknown");

const getMeMethods = [];
const getMeWaits = [];
let getMeFailed = false;
await connectTelegram(config, {
  api: async (_botToken, method) => {
    getMeMethods.push(method);
    if (method === "getMe" && !getMeFailed) {
      getMeFailed = true;
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENETUNREACH" },
      });
    }
    return method === "getMe" ? { id: 43 } : true;
  },
  wait: async (milliseconds) => getMeWaits.push(milliseconds),
  backoff: new TelegramPollBackoff({ jitter: () => 0 }),
  auditEvent: () => {},
});
assert.deepEqual(getMeMethods, ["deleteWebhook", "getMe", "deleteWebhook", "getMe"]);
assert.deepEqual(getMeWaits, [2_000]);

for (const status of [400, 401, 403, 404]) {
  const permanentCalls = [];
  const permanentWaits = [];
  const permanentEvents = [];
  let permanentHolds = 0;
  const permanentError = Object.assign(new Error(`HTTP ${status}`), { status });
  await assert.rejects(connectTelegram(config, {
    api: async (_botToken, method) => {
      permanentCalls.push(method);
      throw permanentError;
    },
    wait: async (milliseconds) => permanentWaits.push(milliseconds),
    backoff: new TelegramPollBackoff({ jitter: () => 0 }),
    auditEvent: (event, fields) => permanentEvents.push({ event, ...fields }),
    hold: async () => { permanentHolds += 1; },
  }), (error) => error === permanentError);
  assert.deepEqual(permanentCalls, ["deleteWebhook"]);
  assert.deepEqual(permanentWaits, []);
  assert.equal(permanentHolds, 1);
  assert.deepEqual(permanentEvents, [{
    event: "connect_blocked",
    reason_class: "4xx",
    status,
  }]);
}
const holdSentinel = new Error("hold test complete");
const holdWaits = [];
await assert.rejects(holdTelegramFailClosed({
  wait: async (milliseconds) => {
    holdWaits.push(milliseconds);
    if (holdWaits.length === 3) throw holdSentinel;
  },
}), (error) => error === holdSentinel);
assert.deepEqual(holdWaits, [
  60 * 60 * 1_000,
  60 * 60 * 1_000,
  60 * 60 * 1_000,
]);
resetMetricsForTest();
assert.deepEqual(Object.keys(metricsSnapshot()).sort(), [
  "approvals_total",
  "jobs_active",
  "jobs_completed_total",
  "jobs_queued",
  "stream_events_ignored_total",
  "telegram_api_errors_total",
  "updates_denied_total",
  "updates_received_total",
  "worker_duration_seconds",
]);
await dispatchNormalizedUpdate(config, {
  kind: "callback_query",
  value: { id: "metric-callback", from: { id: "999" }, message: { chat: { id: "-999" } } },
}, {
  authorization: () => false,
  api: async () => ({}),
});
const deniedMetric = metricsSnapshot();
assert.equal(deniedMetric.updates_denied_total.unauthorized, 1);
assert.equal(JSON.stringify(deniedMetric).includes("999"), false);
assert.equal(isAuthorized(config, { from: { id: 100 }, chat: { id: -200 } }), true);
assert.equal(isAuthorized(config, { from: { id: 101 }, chat: { id: -200 } }), false);
assert.equal(isAuthorized(config, { from: { id: 100 }, chat: { id: -201 } }), false);
const pairedLookup = () => true;
assert.equal(isAuthorized(config, {
  from: { id: 300 },
  chat: { id: 300, type: "private" },
}, { pairingLookup: pairedLookup }), true);
assert.equal(isAuthorized(config, {
  from: { id: 300 },
  chat: { id: -300, type: "group" },
}, { pairingLookup: pairedLookup }), false);
assert.equal(isAuthorized(config, {
  from: { id: 300 },
  chat: { id: -300, type: "supergroup" },
}, { pairingLookup: pairedLookup }), false);
const pairingToken = "A".repeat(32);
assert.equal(pairingTokenFromMessage({
  from: { id: 300 },
  chat: { id: 300, type: "private" },
  text: `/start ${pairingToken}`,
}), pairingToken);
assert.equal(pairingTokenFromMessage({
  from: { id: 300 },
  chat: { id: -300, type: "group" },
  text: `/start ${pairingToken}`,
}), null);
assert.equal(pairingTokenFromMessage({
  from: { id: 300 },
  chat: { id: 300, type: "private" },
  forward_origin: { type: "user" },
  text: `/start ${pairingToken}`,
}), null);
const incompleteStatic = loadRuntimeConfig({
  telegram_enabled: true,
  telegram_bot_token: `123456:${"B".repeat(35)}`,
  telegram_allowed_user_ids: ["100"],
});
assert.equal(isAuthorized(incompleteStatic, { from: { id: 100 }, chat: { id: -200 } }), false);
let unexpectedPairingCheck = false;
assert.equal(await waitForTelegramAuthorization(config, {
  pairingBootstrap: () => {
    unexpectedPairingCheck = true;
    return false;
  },
  wait: async () => assert.fail("static authorization must not wait"),
}), "static");
assert.equal(unexpectedPairingCheck, false);
let pairingChecks = 0;
const authorizationWaits = [];
assert.equal(await waitForTelegramAuthorization(incompleteStatic, {
  pairingBootstrap: () => {
    pairingChecks += 1;
    return pairingChecks === 3;
  },
  wait: async (milliseconds) => authorizationWaits.push(milliseconds),
}), "local_pairing");
assert.deepEqual(authorizationWaits, [2_000]);
assert.equal(pairingChecks, 3);
assert.equal(await waitForTelegramAuthorization(incompleteStatic, {
  pairingBootstrap: () => true,
  wait: async () => assert.fail("existing pairing must not wait"),
}), "local_pairing");
await assert.rejects(
  waitForTelegramAuthorization(incompleteStatic, {
    pairingBootstrap: () => {
      throw new Error("unsafe Telegram authorization state");
    },
    wait: async () => {},
  }),
  /unsafe Telegram authorization state/u,
);
assert.throws(() => loadRuntimeConfig({ telegram_enabled: true, telegram_bot_token: "" }));
assert.equal(requesterKey("100", "-200"), "100:-200");
assert.equal(proposalDisposition("read_only", "low"), "read_only");
assert.equal(proposalDisposition("confirm_changes", "low"), "human_confirmation");
assert.equal(proposalDisposition("autonomous", "low"), "autonomous_policy");
assert.equal(proposalDisposition("autonomous", "high"), "human_confirmation");

const planArgs = buildAgyArgs("plan", true);
assert.deepEqual(planArgs.slice(0, 2), ["--output-format", "stream-json"]);
assert.equal(planArgs.includes("--print"), false);
assert.equal(planArgs.includes("-p"), false);
assert.equal(planArgs.includes("--prompt"), false);
assert.equal(planArgs.includes("--json-schema"), true);
assert.equal(planArgs.includes("ha-telegram"), true);
assert.equal(planArgs.includes("--disable-slash-commands"), true);
assert.equal(planArgs.includes("--print-timeout"), true);
assert.equal(planArgs.includes("--sandbox"), true);
assert.equal(planArgs.includes("-c"), false);
assert.equal(planArgs.includes("approval_policy"), false);
assert.equal(buildAgyArgs("execute", false).includes("accept-edits"), false);
assert.equal(buildAgyArgs("execute", false).includes("plan"), true);

const stream = [
  JSON.stringify({ event: "init", conversation_id: "conversation.fixture-1" }),
  JSON.stringify({ event: "step_update", tool_info: { output: "secret tool output" } }),
  JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conversation.fixture-1",
      status: "SUCCESS",
      response: `${JSON.stringify({ response: "최종 응답", proposal_ids: [] })}\n`,
    },
  }),
].join("\n");
assert.deepEqual(parseStreamResult(stream), {
  response: "최종 응답",
  proposalIds: [],
  conversationId: "conversation.fixture-1",
});
assert.throws(
  () => parseStreamResult([
    JSON.stringify({ event: "init", conversation_id: "conversation.failed" }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation.failed",
        status: "ERROR",
        response: JSON.stringify({ response: "must not escape", proposal_ids: [] }),
      },
    }),
  ].join("\n")),
  /did not report success/u,
);
assert.throws(
  () => parseStreamResult([
    JSON.stringify({ event: "init", conversation_id: "conversation.expected" }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation.swapped",
        status: "SUCCESS",
        response: JSON.stringify({ response: "must not escape", proposal_ids: [] }),
      },
    }),
  ].join("\n")),
  /changed the conversation identifier/u,
);
assert.throws(
  () => parseStreamResult([
    JSON.stringify({ event: "init", conversation_id: "conversation.extra" }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation.extra",
        status: "SUCCESS",
        response: JSON.stringify({
          response: "must not escape",
          proposal_ids: [],
          unexpected: true,
        }),
      },
    }),
  ].join("\n")),
  /managed schema/u,
);
assert.throws(() => parseStreamResult("not json\n"), /invalid JSON/u);
assert.throws(
  () => parseStreamResult(`${JSON.stringify({ event: "unexpected" })}\n`),
  /before init/u,
);
const unknownTypeCanary = "future_SECRET_TYPE_a";
const unknownRawCanary = "SECRET_RAW_NDJSON_CANARY";
const ignoredMetricBefore = metricsSnapshot().stream_events_ignored_total.unknown_type;
assert.deepEqual(parseStreamResult([
  JSON.stringify({ event: "init", conversation_id: "conversation.future" }),
  JSON.stringify({ event: unknownTypeCanary, raw: unknownRawCanary }),
  JSON.stringify({ event: "future_SECRET_TYPE_b", nested: { raw: unknownRawCanary } }),
  JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conversation.future",
      status: "SUCCESS",
      response: JSON.stringify({ response: "future compatible", proposal_ids: [] }),
    },
  }),
].join("\n")), {
  response: "future compatible",
  proposalIds: [],
  conversationId: "conversation.future",
});
const ignoredMetric = metricsSnapshot().stream_events_ignored_total;
assert.deepEqual(Object.keys(ignoredMetric), ["unknown_type"]);
assert.equal(ignoredMetric.unknown_type, ignoredMetricBefore + 2);
assert.equal(JSON.stringify(metricsSnapshot()).includes(unknownTypeCanary), false);
assert.equal(JSON.stringify(metricsSnapshot()).includes(unknownRawCanary), false);
for (const invalidEvent of [{}, { event: 7 }, { type: "init" }]) {
  assert.throws(
    () => parseStreamResult([
      JSON.stringify({ event: "init", conversation_id: "conversation.invalid-type" }),
      JSON.stringify(invalidEvent),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conversation.invalid-type",
          status: "SUCCESS",
          response: JSON.stringify({ response: "invalid", proposal_ids: [] }),
        },
      }),
    ].join("\n")),
    /missing or malformed event discriminator/u,
  );
}
assert.throws(
  () => parseStreamResult(`${JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conversation.missing-init",
      status: "SUCCESS",
      response: JSON.stringify({ response: "missing init", proposal_ids: [] }),
    },
  })}\n`),
  /valid init sequence/u,
);
assert.throws(
  () => parseStreamResult([
    JSON.stringify({ event: "step_update" }),
    JSON.stringify({ event: "init", conversation_id: "conversation.late" }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation.late",
        status: "SUCCESS",
        response: JSON.stringify({ response: "late init", proposal_ids: [] }),
      },
    }),
  ].join("\n")),
  /before init/u,
);
assert.throws(
  () => parseStreamResult([
    JSON.stringify({ event: "init", conversation_id: "conversation.one" }),
    JSON.stringify({ event: "init", conversation_id: "conversation.two" }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation.two",
        status: "SUCCESS",
        response: JSON.stringify({ response: "duplicate init", proposal_ids: [] }),
      },
    }),
  ].join("\n")),
  /invalid init sequence/u,
);
assert.throws(
  () => parseStreamResult(Buffer.from([0xc3, 0x28, 0x0a])),
  /invalid UTF-8/u,
);
assert.throws(
  () => parseStreamResult([
    JSON.stringify({ event: "init", conversation_id: "conversation.terminal" }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation.terminal",
        status: "SUCCESS",
        response: JSON.stringify({ response: "done", proposal_ids: [] }),
      },
    }),
    JSON.stringify({ event: "future_after_terminal" }),
  ].join("\n")),
  /after the terminal result/u,
);
assert.ok(chunkText("A".repeat(32_768)).every((part) => Array.from(part).length <= 4_096));
assert.throws(() => chunkText("A".repeat(32_769)), /message limit/u);
assert.equal(safeError(new Error("Bearer abc\nnext")).includes("abc"), false);

let releaseDispatch;
const dispatchGate = new Promise((resolve) => { releaseDispatch = resolve; });
const dispatchStarts = [];
const delayedHandler = async (_runtimeConfig, message) => {
  dispatchStarts.push(message.updateId);
  await dispatchGate;
};
const dispatchedOne = dispatchNormalizedUpdate(config, {
  kind: "message",
  value: { updateId: 20, from: { id: "100" }, chat: { id: "-200" }, text: "one" },
}, { messageHandler: delayedHandler });
const dispatchedTwo = dispatchNormalizedUpdate(config, {
  kind: "message",
  value: { updateId: 21, from: { id: "100" }, chat: { id: "-200" }, text: "two" },
}, { messageHandler: delayedHandler });
assert.deepEqual(dispatchStarts, [20, 21]);
releaseDispatch();
await Promise.all([dispatchedOne, dispatchedTwo]);

const acknowledgementRoot = await mkdtemp(join(tmpdir(), "telegram-update-ack-"));
try {
  const managedRoot = join(acknowledgementRoot, "data", "antigravity-ha");
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  await chmod(managedRoot, 0o700);
  const statePath = join(managedRoot, "telegram", "bridge-state.json");
  const releaseByUpdate = new Map();
  const completionByUpdate = new Map([20, 21].map((updateId) => [
    updateId,
    new Promise((resolve) => releaseByUpdate.set(updateId, resolve)),
  ]));
  const batch = [20, 21].map((updateId) => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: 100 },
      chat: { id: -200, type: "private" },
      text: `update ${updateId}`,
    },
  }));
  const firstProgress = dispatchUpdateBatch(config, batch, {
    statePath,
    messageHandler: async (_runtimeConfig, message) => completionByUpdate.get(message.updateId),
  });
  assert.equal(await firstProgress, 22);
  releaseByUpdate.get(21)();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = loadBridgeState(statePath);
    if (state.update_ledger.find((entry) => entry.update_id === 21)?.acknowledged) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(loadBridgeState(statePath).update_offset, 0);

  const secondProgress = dispatchUpdateBatch(config, batch, {
    statePath,
    messageHandler: async () => {
      throw new Error("an in-flight update must not be dispatched twice");
    },
  });
  assert.equal(await secondProgress, 22);
  releaseByUpdate.get(20)();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (loadBridgeState(statePath).update_offset === 22) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(loadBridgeState(statePath).update_offset, 22);
} finally {
  await rm(acknowledgementRoot, { recursive: true, force: true });
}

const malformedCallbackRoot = await mkdtemp(join(tmpdir(), "telegram-malformed-callback-"));
try {
  const managedRoot = join(malformedCallbackRoot, "data", "antigravity-ha");
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  await chmod(managedRoot, 0o700);
  const statePath = join(managedRoot, "telegram", "bridge-state.json");
  assert.equal(await dispatchUpdateBatch(config, [{
    update_id: 12,
    callback_query: {
      id: "",
      from: { id: 100 },
      message: { chat: { id: -200, type: "private" } },
      data: "confirm:fixture",
    },
  }], { statePath }), 13);
  assert.equal(loadBridgeState(statePath).update_offset, 13);
  assert.deepEqual(loadBridgeState(statePath).sealed_updates, []);
} finally {
  await rm(malformedCallbackRoot, { recursive: true, force: true });
}

const livePollRoot = await mkdtemp(join(tmpdir(), "telegram-live-poll-"));
try {
  const managedRoot = join(livePollRoot, "data", "antigravity-ha");
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  await chmod(managedRoot, 0o700);
  const statePath = join(managedRoot, "telegram", "bridge-state.json");
  let releaseNeverPrompt;
  const neverPromptReleased = new Promise((resolve) => { releaseNeverPrompt = resolve; });
  let markNeverPromptStarted;
  const neverPromptStarted = new Promise((resolve) => { markNeverPromptStarted = resolve; });
  let markCancelProcessed;
  const cancelProcessed = new Promise((resolve) => { markCancelProcessed = resolve; });
  let pollCount = 0;
  let cancelBatchFetchedAt = 0;
  const requestedOffsets = [];
  const liveMessageHandler = async (_runtimeConfig, message) => {
    if (message.text === "/cancel") {
      const result = cancelRequesterWork(message.from.id, message.chat.id);
      assert.equal(result.running_cancel_requested, 1);
      markCancelProcessed();
      return;
    }
    await enqueueRequester(message.from.id, message.chat.id, async (ticket) => {
      markNeverPromptStarted();
      ticket.cancellationController.signal.addEventListener(
        "abort",
        releaseNeverPrompt,
        { once: true },
      );
      await neverPromptReleased;
    });
  };
  const liveApi = async (_token, method, payload) => {
    assert.equal(method, "getUpdates");
    requestedOffsets.push(payload.offset);
    pollCount += 1;
    if (pollCount === 1) {
      return [{
        update_id: 100,
        message: {
          message_id: 100,
          from: { id: 100 },
          chat: { id: -200, type: "private" },
          text: "never prompt",
        },
      }];
    }
    await neverPromptStarted;
    cancelBatchFetchedAt = Date.now();
    return [{
      update_id: 101,
      message: {
        message_id: 101,
        from: { id: 100 },
        chat: { id: -200, type: "private" },
        text: "/cancel",
      },
    }];
  };
  assert.equal(await pollUpdateBatches(config, {
    statePath,
    messageHandler: liveMessageHandler,
    api: liveApi,
    shouldContinue: () => pollCount < 2,
  }), 102);
  await cancelProcessed;
  assert.ok(Date.now() - cancelBatchFetchedAt < 500, "live /cancel dispatch was blocked");
  assert.deepEqual(requestedOffsets, [0, 101]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (loadBridgeState(statePath).update_offset === 102) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(loadBridgeState(statePath).update_offset, 102);
} finally {
  await rm(livePollRoot, { recursive: true, force: true });
}

const crashReplayRoot = await mkdtemp(join(tmpdir(), "telegram-crash-replay-"));
try {
  const managedRoot = join(crashReplayRoot, "data", "antigravity-ha");
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  await chmod(managedRoot, 0o700);
  const statePath = join(managedRoot, "telegram", "bridge-state.json");
  const promptCanary = "CRASH_REPLAY_PROMPT_MUST_REMAIN_SEALED";
  let upstream = [{
    update_id: 200,
    message: {
      message_id: 200,
      from: { id: 100 },
      chat: { id: -200, type: "private" },
      text: promptCanary,
    },
  }];
  let dispatchCount = 0;
  let pollCount = 0;
  const requestedOffsets = [];
  const neverCompletes = new Promise(() => {});
  const crashHandler = async () => {
    dispatchCount += 1;
    await neverCompletes;
  };
  const modeledBotApi = async (_token, method, payload) => {
    assert.equal(method, "getUpdates");
    requestedOffsets.push(payload.offset);
    pollCount += 1;
    upstream = upstream.filter((update) => update.update_id >= payload.offset);
    if (payload.offset === 201) {
      const durable = loadBridgeState(statePath);
      assert.equal(durable.transport_offset, 201);
      assert.equal(durable.sealed_updates.length, 1);
      assert.equal((await readFile(statePath, "utf8")).includes(promptCanary), false);
    }
    return structuredClone(upstream);
  };

  assert.equal(await pollUpdateBatches(config, {
    statePath,
    messageHandler: crashHandler,
    api: modeledBotApi,
    shouldContinue: () => pollCount < 2,
  }), 201);
  assert.equal(dispatchCount, 1);
  assert.deepEqual(requestedOffsets, [0, 201]);
  assert.deepEqual(upstream, []);
  assert.equal(loadBridgeState(statePath).update_offset, 0);

  resetUpdateRuntimeForTest();
  pollCount = 0;
  assert.equal(await pollUpdateBatches(config, {
    statePath,
    messageHandler: crashHandler,
    api: modeledBotApi,
    shouldContinue: () => pollCount < 1,
  }), 201);
  assert.equal(dispatchCount, 2, "restart did not replay the sealed unacknowledged prompt");
  assert.deepEqual(requestedOffsets, [0, 201, 201]);
} finally {
  resetUpdateRuntimeForTest();
  await rm(crashReplayRoot, { recursive: true, force: true });
}

let releaseQueue;
const queueGate = new Promise((resolve) => { releaseQueue = resolve; });
let queuedTaskStarted = false;
const firstQueued = enqueueRequester("300", "-400", async () => queueGate);
const secondQueued = enqueueRequester("300", "-400", async () => {
  queuedTaskStarted = true;
});
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(cancelRequesterWork("300", "-400"), {
  queued_cancelled: 1,
  running_cancel_requested: 1,
  approvals_cancelled: 0,
  durable_in_progress: 0,
  workers_terminated: 0,
});
releaseQueue();
await firstQueued;
await assert.rejects(secondQueued, /cancelled/u);
assert.equal(queuedTaskStarted, false);

assert.deepEqual(normalizeUpdate({
  update_id: 10,
  message: {
    message_id: 1,
    from: { id: 100 },
    chat: { id: -200, type: "group" },
    text: "line 1\r\nline 2",
  },
}), {
  updateId: 10,
  kind: "message",
  value: {
    updateId: 10,
    message_id: 1,
    from: { id: "100" },
    chat: { id: "-200", type: "group" },
    text: "line 1\nline 2",
  },
});
assert.equal(normalizeUpdate({
  update_id: 11,
  message: {
    message_id: 2,
    from: { id: 300 },
    chat: { id: 300, type: "private" },
    forward_origin: { type: "user" },
    text: `/start ${pairingToken}`,
  },
}), null);
assert.equal(normalizeUpdate({
  update_id: 12,
  callback_query: {
    id: "",
    from: { id: 100 },
    message: { chat: { id: -200, type: "private" } },
    data: "confirm:fixture",
  },
}), null);
assert.match(renderCancellationResult({
  queued_cancelled: 0,
  running_cancel_requested: 0,
  approvals_cancelled: 0,
  durable_in_progress: 1,
  workers_terminated: 0,
}), /취소할 수 없습니다.*결과를 전달/u);

const fixtureDir = await mkdtemp(join(tmpdir(), "agy-telegram-test-"));
try {
  const waitForFile = async (path, timeoutMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        await access(path);
        return;
      } catch (error) {
        if (error?.code !== "ENOENT" || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };
  const fake = join(fixtureDir, "fake-agy.mjs");
  await writeFile(fake, `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const payload = {
  prompt: input.trimEnd(),
  autoUpdateDisabled: process.env.AGY_CLI_DISABLE_AUTO_UPDATE === "true",
  leakedSupervisorToken: Boolean(process.env.SUPERVISOR_TOKEN),
  requester: [process.env.HA_TELEGRAM_USER_ID, process.env.HA_TELEGRAM_CHAT_ID],
  argv: process.argv.slice(2),
};
process.stdout.write(JSON.stringify({
  event: "init",
  conversation_id: "conversation.fixture-1",
}) + "\\n");
process.stdout.write(JSON.stringify({
  event: "result",
  result: {
    conversation_id: "conversation.fixture-1",
    status: "SUCCESS",
    response: JSON.stringify({ response: JSON.stringify(payload), proposal_ids: [] }),
  },
}) + "\\n");
`, "utf8");
  process.env.SUPERVISOR_TOKEN = "must-not-be-inherited";
  resetWorkerStatusForTest();
  assert.equal(workerStatusSnapshot(), "not_checked");
  assert.equal(renderWorkerStatus(), "아직 확인되지 않음");
  const malicious = "literal $(touch /tmp/telegram-pwned) `id` ; echo nope";
  const result = await runAntigravityPrompt(malicious, {
    binary: process.execPath,
    prefixArgs: [fake],
    cwd: fixtureDir,
    timeoutMs: 5_000,
    requester: { user_id: "100", chat_id: "-200" },
    conversationId: "conversation.fixture-1",
  });
  const payload = JSON.parse(result.response);
  assert.equal(payload.prompt, malicious);
  assert.equal(payload.autoUpdateDisabled, true);
  assert.equal(payload.leakedSupervisorToken, false);
  assert.deepEqual(payload.requester, ["100", "-200"]);
  assert.equal(payload.argv.includes(malicious), false);
  assert.equal(payload.argv.includes("--output-format"), true);
  assert.equal(payload.argv.includes("--conversation"), true);
  assert.equal(workerStatusSnapshot(), "ready");
  assert.equal(renderWorkerStatus(), "최근 요청 정상");

  const stderrCanary = "SECRET_STDERR_BEARER_URL_PROMPT_CANARY";
  const authFailureFake = join(fixtureDir, "auth-failure-agy.mjs");
  await writeFile(authFailureFake, `
for await (const _chunk of process.stdin) { /* drain stdin */ }
const marker = ${JSON.stringify(ANTIGRAVITY_AUTH_REQUIRED_MARKER.toString("utf8"))};
process.stderr.write(marker.slice(0, 19));
await new Promise((resolve) => setImmediate(resolve));
process.stderr.write(marker.slice(19) + "\\n${stderrCanary}\\n");
process.exitCode = 1;
`, "utf8");
  let authFailure;
  try {
    await runAntigravityPrompt("private auth prompt canary", {
      binary: process.execPath,
      prefixArgs: [authFailureFake],
      cwd: fixtureDir,
      timeoutMs: 5_000,
      requester: { user_id: "100", chat_id: "-200" },
    });
    assert.fail("authentication-required worker unexpectedly succeeded");
  } catch (error) {
    authFailure = error;
  }
  assert.ok(authFailure instanceof AntigravityWorkerError);
  assert.equal(authFailure.reasonClass, "authentication_required");
  assert.equal(requestFailureReason(authFailure), "authentication_required");
  assert.equal(workerStatusSnapshot(), "authentication_required");
  assert.equal(renderWorkerStatus(), "Telegram 전용 로그인 필요 (ha-telegram-login)");
  const authFailureMessage = renderRequestFailure(authFailure);
  assert.match(authFailureMessage, /ha-telegram-login/u);
  for (const forbidden of [
    stderrCanary,
    "private auth prompt canary",
    ANTIGRAVITY_AUTH_REQUIRED_MARKER.toString("utf8"),
    "antigravity-real",
    "https://",
  ]) {
    assert.equal(authFailure.message.includes(forbidden), false);
    assert.equal(authFailureMessage.includes(forbidden), false);
  }

  const permissionFailureFake = join(fixtureDir, "permission-failure-agy.mjs");
  await writeFile(permissionFailureFake, `
for await (const _chunk of process.stdin) { /* drain stdin */ }
const marker = ${JSON.stringify(ANTIGRAVITY_HEADLESS_PERMISSION_MARKER.toString("utf8"))};
process.stderr.write("jetski: synthetic diagnostic — " + marker.slice(0, 21));
await new Promise((resolve) => setImmediate(resolve));
process.stderr.write(marker.slice(21) + "\\n${stderrCanary}\\n");
`, "utf8");
  let permissionFailure;
  try {
    await runAntigravityPrompt("private permission prompt canary", {
      binary: process.execPath,
      prefixArgs: [permissionFailureFake],
      cwd: fixtureDir,
      timeoutMs: 5_000,
      requester: { user_id: "100", chat_id: "-200" },
    });
    assert.fail("headless permission-denied worker unexpectedly succeeded");
  } catch (error) {
    permissionFailure = error;
  }
  assert.ok(permissionFailure instanceof AntigravityWorkerError);
  assert.equal(permissionFailure.reasonClass, "headless_read_denied");
  assert.equal(requestFailureReason(permissionFailure), "headless_read_denied");
  assert.equal(workerStatusSnapshot(), "headless_read_denied");
  assert.equal(renderWorkerStatus(), "파일 읽기 권한 차단");
  const permissionFailureMessage = renderRequestFailure(permissionFailure);
  assert.match(permissionFailureMessage, /최신 버전/u);
  for (const forbidden of [
    stderrCanary,
    "private permission prompt canary",
    ANTIGRAVITY_HEADLESS_PERMISSION_MARKER.toString("utf8"),
    "jetski",
    "read_file",
  ]) {
    assert.equal(permissionFailure.message.includes(forbidden), false);
    assert.equal(permissionFailureMessage.includes(forbidden), false);
  }

  const permissionMarkerWithSuccessFake = join(
    fixtureDir,
    "permission-marker-success-agy.mjs",
  );
  await writeFile(permissionMarkerWithSuccessFake, `
for await (const _chunk of process.stdin) { /* drain stdin */ }
process.stderr.write(${JSON.stringify(ANTIGRAVITY_HEADLESS_PERMISSION_MARKER.toString("utf8"))});
process.stdout.write(JSON.stringify({
  event: "init",
  conversation_id: "conversation.permission-success",
}) + "\\n");
process.stdout.write(JSON.stringify({
  event: "result",
  result: {
    conversation_id: "conversation.permission-success",
    status: "SUCCESS",
    response: JSON.stringify({ response: "safe response", proposal_ids: [] }),
  },
}) + "\\n");
`, "utf8");
  const permissionMarkerSuccess = await runAntigravityPrompt(
    "permission marker success fixture",
    {
      binary: process.execPath,
      prefixArgs: [permissionMarkerWithSuccessFake],
      cwd: fixtureDir,
      timeoutMs: 5_000,
      requester: { user_id: "100", chat_id: "-200" },
    },
  );
  assert.equal(permissionMarkerSuccess.response, "safe response");
  assert.equal(workerStatusSnapshot(), "ready");

  const permissionMarkerNonzeroFake = join(
    fixtureDir,
    "permission-marker-nonzero-agy.mjs",
  );
  await writeFile(permissionMarkerNonzeroFake, `
for await (const _chunk of process.stdin) { /* drain stdin */ }
process.stderr.write(${JSON.stringify(ANTIGRAVITY_HEADLESS_PERMISSION_MARKER.toString("utf8"))});
process.exitCode = 2;
`, "utf8");
  await assert.rejects(
    runAntigravityPrompt("permission marker nonzero fixture", {
      binary: process.execPath,
      prefixArgs: [permissionMarkerNonzeroFake],
      cwd: fixtureDir,
      timeoutMs: 5_000,
      requester: { user_id: "100", chat_id: "-200" },
    }),
    (error) => error instanceof AntigravityWorkerError &&
      error.reasonClass === "worker_failed",
  );

  const permissionMarkerMalformedFake = join(
    fixtureDir,
    "permission-marker-malformed-agy.mjs",
  );
  await writeFile(permissionMarkerMalformedFake, `
for await (const _chunk of process.stdin) { /* drain stdin */ }
process.stderr.write(${JSON.stringify(ANTIGRAVITY_HEADLESS_PERMISSION_MARKER.toString("utf8"))});
process.stdout.write("not-json\\n");
`, "utf8");
  await assert.rejects(
    runAntigravityPrompt("permission marker malformed fixture", {
      binary: process.execPath,
      prefixArgs: [permissionMarkerMalformedFake],
      cwd: fixtureDir,
      timeoutMs: 5_000,
      requester: { user_id: "100", chat_id: "-200" },
    }),
    /invalid JSON/u,
  );
  assert.equal(workerStatusSnapshot(), "worker_failed");

  const emptySuccessFake = join(fixtureDir, "empty-success-agy.mjs");
  await writeFile(emptySuccessFake, `
for await (const _chunk of process.stdin) { /* drain stdin */ }
process.stderr.write("${stderrCanary}\\n");
`, "utf8");
  let emptySuccessFailure;
  try {
    await runAntigravityPrompt("empty success fixture", {
      binary: process.execPath,
      prefixArgs: [emptySuccessFake],
      cwd: fixtureDir,
      timeoutMs: 5_000,
      requester: { user_id: "100", chat_id: "-200" },
    });
    assert.fail("empty successful worker unexpectedly succeeded");
  } catch (error) {
    emptySuccessFailure = error;
  }
  assert.ok(emptySuccessFailure instanceof AntigravityWorkerError);
  assert.equal(emptySuccessFailure.reasonClass, "worker_failed");
  assert.equal(emptySuccessFailure.message.includes(stderrCanary), false);

  const integrityFailureFake = join(fixtureDir, "integrity-failure-agy.mjs");
  await writeFile(integrityFailureFake, `
for await (const _chunk of process.stdin) { /* drain stdin */ }
const marker = ${JSON.stringify(TELEGRAM_WORKER_INTEGRITY_MARKER.toString("utf8"))};
process.stderr.write(marker.slice(0, 23));
await new Promise((resolve) => setImmediate(resolve));
process.stderr.write(marker.slice(23) + "\\n${stderrCanary}\\n");
process.exitCode = 70;
`, "utf8");
  let integrityFailure;
  try {
    await runAntigravityPrompt("private integrity prompt canary", {
      binary: process.execPath,
      prefixArgs: [integrityFailureFake],
      cwd: fixtureDir,
      timeoutMs: 5_000,
      requester: { user_id: "100", chat_id: "-200" },
    });
    assert.fail("integrity-failed worker unexpectedly succeeded");
  } catch (error) {
    integrityFailure = error;
  }
  assert.ok(integrityFailure instanceof AntigravityWorkerError);
  assert.equal(integrityFailure.reasonClass, "runtime_integrity_failed");
  assert.equal(requestFailureReason(integrityFailure), "runtime_integrity_failed");
  assert.equal(workerStatusSnapshot(), "runtime_integrity_failed");
  assert.equal(renderWorkerStatus(), "격리 실행 환경 무결성 오류");
  const integrityFailureMessage = renderRequestFailure(integrityFailure);
  assert.match(integrityFailureMessage, /App을 재시작/u);
  assert.equal(integrityFailureMessage.includes(stderrCanary), false);

  const nativeExit70Fake = join(fixtureDir, "native-exit-70-agy.mjs");
  await writeFile(nativeExit70Fake, `
for await (const _chunk of process.stdin) { /* drain stdin */ }
process.stderr.write("native failure without the worker preflight marker\\n${stderrCanary}\\n");
process.exitCode = 70;
`, "utf8");
  let nativeExit70Failure;
  try {
    await runAntigravityPrompt("private native exit 70 canary", {
      binary: process.execPath,
      prefixArgs: [nativeExit70Fake],
      cwd: fixtureDir,
      timeoutMs: 5_000,
      requester: { user_id: "100", chat_id: "-200" },
    });
    assert.fail("marker-free native exit 70 unexpectedly succeeded");
  } catch (error) {
    nativeExit70Failure = error;
  }
  assert.ok(nativeExit70Failure instanceof AntigravityWorkerError);
  assert.equal(nativeExit70Failure.reasonClass, "worker_failed");
  assert.equal(requestFailureReason(nativeExit70Failure), "worker_failed");
  assert.equal(renderRequestFailure(nativeExit70Failure).includes(stderrCanary), false);

  const genericFailureFake = join(fixtureDir, "generic-failure-agy.mjs");
  await writeFile(genericFailureFake, `
for await (const _chunk of process.stdin) { /* drain stdin */ }
process.stderr.write("Error: authentication failed or timed out\\n${stderrCanary}\\n");
process.exitCode = 1;
`, "utf8");
  let genericFailure;
  try {
    await runAntigravityPrompt("private generic prompt canary", {
      binary: process.execPath,
      prefixArgs: [genericFailureFake],
      cwd: fixtureDir,
      timeoutMs: 5_000,
      requester: { user_id: "100", chat_id: "-200" },
    });
    assert.fail("generic failed worker unexpectedly succeeded");
  } catch (error) {
    genericFailure = error;
  }
  assert.ok(genericFailure instanceof AntigravityWorkerError);
  assert.equal(genericFailure.reasonClass, "worker_failed");
  assert.equal(requestFailureReason(genericFailure), "worker_failed");
  assert.equal(workerStatusSnapshot(), "worker_failed");
  assert.equal(renderWorkerStatus(), "최근 요청 실패");
  assert.equal(
    renderRequestFailure(genericFailure),
    "요청을 완료하지 못했습니다. App 로그를 확인하세요.",
  );
  assert.equal(renderRequestFailure(genericFailure).includes(stderrCanary), false);
  assert.equal(requestFailureReason(new Error("fixture timed out")), "timeout");
  assert.equal(requestFailureReason(new Error(stderrCanary)), "request_failed");

  const invalidUtf8Fake = join(fixtureDir, "invalid-utf8-agy.mjs");
  await writeFile(invalidUtf8Fake, `
for await (const _chunk of process.stdin) { /* drain stdin */ }
process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
`, "utf8");
  await assert.rejects(
    runAntigravityPrompt("invalid utf8 fixture", {
      binary: process.execPath,
      prefixArgs: [invalidUtf8Fake],
      cwd: fixtureDir,
      timeoutMs: 5_000,
      requester: { user_id: "100", chat_id: "-200" },
    }),
    /invalid UTF-8/u,
  );

  const slotFixtureRoot = join(fixtureDir, "slot-fixture");
  await mkdir(slotFixtureRoot, { recursive: true });
  const slotFake = join(fixtureDir, "slot-agy.mjs");
  await writeFile(slotFake, `
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const id = input.trim();
await writeFile(join(process.argv[2], id + ".started"), "started", "utf8");
while (true) {
  try {
    await access(join(process.argv[2], id + ".release"));
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
process.stdout.write(JSON.stringify({ event: "init", conversation_id: "conversation." + id }) + "\\n");
process.stdout.write(JSON.stringify({
  event: "result",
  result: {
    conversation_id: "conversation." + id,
    status: "SUCCESS",
    response: JSON.stringify({ response: id, proposal_ids: [] }),
  },
}) + "\\n");
`, "utf8");
  const slotRun = (id, options = {}) => runAntigravityPrompt(id, {
    binary: process.execPath,
    prefixArgs: [slotFake, slotFixtureRoot],
    cwd: fixtureDir,
    timeoutMs: 5_000,
    requester: { user_id: "800", chat_id: "-800" },
    runId: `slot:${id}`,
    ...options,
  });

  const firstSlot = slotRun("first");
  const secondSlot = slotRun("second");
  await Promise.all([
    waitForFile(join(slotFixtureRoot, "first.started")),
    waitForFile(join(slotFixtureRoot, "second.started")),
  ]);
  const thirdSlot = enqueueRequester("801", "-801", (ticket) => slotRun("third", {
    signal: ticket.cancellationController.signal,
    requester: { user_id: "801", chat_id: "-801" },
    runId: "801:-801:third-slot",
  }));
  for (let attempt = 0; attempt < 100 && metricsSnapshot().jobs_queued < 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(metricsSnapshot().jobs_active, 2);
  assert.equal(metricsSnapshot().jobs_queued >= 1, true);
  const queuedCancelStartedAt = Date.now();
  assert.deepEqual(cancelRequesterWork("801", "-801"), {
    queued_cancelled: 0,
    running_cancel_requested: 1,
    approvals_cancelled: 0,
    durable_in_progress: 0,
    workers_terminated: 0,
  });
  await assert.rejects(thirdSlot, /cancelled/u);
  assert.ok(Date.now() - queuedCancelStartedAt < 500, "global slot cancellation was not prompt");
  await assert.rejects(access(join(slotFixtureRoot, "third.started")), { code: "ENOENT" });
  assert.equal(metricsSnapshot().jobs_active, 2);
  assert.equal(metricsSnapshot().jobs_queued, 0);
  await Promise.all([
    writeFile(join(slotFixtureRoot, "first.release"), "release", "utf8"),
    writeFile(join(slotFixtureRoot, "second.release"), "release", "utf8"),
  ]);
  await Promise.all([firstSlot, secondSlot]);

  const raceFirst = slotRun("race-first");
  const raceSecond = slotRun("race-second");
  await Promise.all([
    waitForFile(join(slotFixtureRoot, "race-first.started")),
    waitForFile(join(slotFixtureRoot, "race-second.started")),
  ]);
  const raceCancellation = new AbortController();
  const racedSlot = slotRun("race-third", { signal: raceCancellation.signal });
  for (let attempt = 0; attempt < 100 && metricsSnapshot().jobs_queued < 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(metricsSnapshot().jobs_queued >= 1, true);
  const racedCancellationObserved = assert.rejects(racedSlot, /cancelled/u);
  await Promise.all([
    writeFile(join(slotFixtureRoot, "race-first.release"), "release", "utf8"),
    new Promise((resolve) => setImmediate(() => {
      raceCancellation.abort();
      resolve();
    })),
  ]);
  await racedCancellationObserved;
  await writeFile(join(slotFixtureRoot, "race-second.release"), "release", "utf8");
  await Promise.all([raceFirst, raceSecond]);
  assert.equal(metricsSnapshot().jobs_active, 0);
  assert.equal(metricsSnapshot().jobs_queued, 0);

  const slowFake = join(fixtureDir, "slow-agy.mjs");
  await writeFile(slowFake, `
for await (const _chunk of process.stdin) { /* drain stdin */ }
await new Promise((resolve) => setTimeout(resolve, 60_000));
`, "utf8");
  const running = runAntigravityPrompt("cancel fixture", {
    binary: process.execPath,
    prefixArgs: [slowFake],
    cwd: fixtureDir,
    timeoutMs: 10_000,
    requester: { user_id: "500", chat_id: "-600" },
    runId: "500:-600:cancel-fixture",
  });
  let cancellation = null;
  for (let attempt = 0; attempt < 50 && cancellation?.workers_terminated !== 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    cancellation = cancelRequesterWork("500", "-600");
  }
  assert.equal(cancellation.workers_terminated, 1);
  await assert.rejects(running, /unsuccessfully/u);

  const stubbornFake = join(fixtureDir, "stubborn-agy.mjs");
  await writeFile(stubbornFake, `
process.on("SIGTERM", () => {});
for await (const _chunk of process.stdin) { /* drain stdin */ }
setInterval(() => {}, 1_000);
`, "utf8");
  const timeoutStartedAt = Date.now();
  await assert.rejects(
    runAntigravityPrompt("timeout hard-kill fixture", {
      binary: process.execPath,
      prefixArgs: [stubbornFake],
      cwd: fixtureDir,
      timeoutMs: 200,
      hardKillGraceMs: 50,
      requester: { user_id: "700", chat_id: "700" },
      runId: "700:700:timeout-fixture",
    }),
    /timed out/u,
  );
  const timeoutElapsed = Date.now() - timeoutStartedAt;
  assert.ok(timeoutElapsed >= 225, `worker exited before SIGKILL grace: ${timeoutElapsed}ms`);
  assert.ok(timeoutElapsed < 2_000);
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}

console.log("telegram bridge v2 tests passed");
