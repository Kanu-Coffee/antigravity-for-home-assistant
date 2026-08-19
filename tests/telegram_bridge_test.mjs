import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANTIGRAVITY_AUTH_REQUIRED_MARKER,
  ANTIGRAVITY_HEADLESS_PERMISSION_MARKER,
  TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES,
  TELEGRAM_SAFE_ALLOW_RULES,
  AntigravityWorkerError,
  BoundedByteMatcher,
  TelegramPollBackoff,
  buildAgyArgs,
  cancelRequesterWork,
  chunkText,
  connectTelegram,
  dispatchNormalizedUpdate,
  dispatchUpdateBatch,
  enqueueRequester,
  handleMessage,
  holdTelegramFailClosed,
  isAuthorized,
  assertTelegramPermissionBoundary,
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
  runToolActionExecutor,
  safeError,
  terminalExecutionResult,
  telegramTransportErrorCode,
  toolActionWatchdogMs,
  waitForExecution,
  waitForTelegramPermissionBoundary,
  waitForTelegramAuthorization,
  workerFailureAuditFields,
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
  antigravity_tool_permission: "request-review",
});
assert.equal(config.toolPermission, "request-review");
assert.equal(loadRuntimeConfig({
  telegram_enabled: false,
  antigravity_tool_permission: "always-proceed",
}).toolPermission, "request-review");
assert.equal(loadRuntimeConfig({
  telegram_enabled: false,
  antigravity_tool_permission: "strict",
}).toolPermission, "request-review");
const safePermissionFixture = {
  toolPermission: "request-review",
  enableTerminalSandbox: false,
  allowNonWorkspaceAccess: false,
  artifactReviewPolicy: "agent-decides",
  permissions: {
    allow: [...TELEGRAM_SAFE_ALLOW_RULES],
    ask: [],
    deny: [...TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES],
  },
};
assert.equal(
  TELEGRAM_SAFE_ALLOW_RULES.has("mcp(ha_read/ha_read_storage_usage)"),
  true,
);
assert.deepEqual(assertTelegramPermissionBoundary(safePermissionFixture), {
  toolPermission: "request-review",
  allowCount: TELEGRAM_SAFE_ALLOW_RULES.size,
  denyCount: TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES.size,
});
const permissionBoundaryEvents = [];
let permissionBoundaryHolds = 0;
assert.equal(await waitForTelegramPermissionBoundary(
  { toolPermission: "request-review" },
  {
    load: () => {
      throw new Error("synthetic unsafe permission boundary");
    },
    hold: async () => { permissionBoundaryHolds += 1; },
    auditEvent: (event, fields) => permissionBoundaryEvents.push({ event, ...fields }),
  },
), null);
assert.equal(permissionBoundaryHolds, 1);
assert.deepEqual(permissionBoundaryEvents, [{
  event: "permission_boundary_blocked",
  error: "synthetic unsafe permission boundary",
}]);
let readyBoundaryHeld = false;
assert.deepEqual(await waitForTelegramPermissionBoundary(
  { toolPermission: "request-review" },
  {
    load: () => ({
      toolPermission: "request-review",
      allowCount: 29,
      denyCount: 33,
    }),
    hold: async () => { readyBoundaryHeld = true; },
    auditEvent: () => {
      throw new Error("ready permission boundary emitted a blocked event");
    },
  },
), {
  toolPermission: "request-review",
  allowCount: 29,
  denyCount: 33,
});
assert.equal(readyBoundaryHeld, false);
const mismatchedBoundaryEvents = [];
let mismatchedBoundaryHolds = 0;
assert.equal(await waitForTelegramPermissionBoundary(
  { toolPermission: "request-review" },
  {
    load: () => ({
      toolPermission: "always-proceed",
      allowCount: 29,
      denyCount: 33,
    }),
    hold: async () => { mismatchedBoundaryHolds += 1; },
    auditEvent: (event, fields) => mismatchedBoundaryEvents.push({
      event,
      ...fields,
    }),
  },
), null);
assert.equal(mismatchedBoundaryHolds, 1);
assert.equal(mismatchedBoundaryEvents.length, 1);
assert.equal(mismatchedBoundaryEvents[0].event, "permission_boundary_blocked");
assert.match(mismatchedBoundaryEvents[0].error, /configured and effective/u);
for (const unsafeRule of ["command(*)", "mcp(*)", "write_file(/config)"]) {
  assert.throws(() => assertTelegramPermissionBoundary({
    ...safePermissionFixture,
    permissions: {
      ...safePermissionFixture.permissions,
      allow: [...safePermissionFixture.permissions.allow, unsafeRule],
    },
  }), /bypass or block Telegram approval/u);
}
for (const nonReadOnlyBrowserTool of [
  "browser_close",
  "browser_hover",
  "browser_navigate",
  "browser_navigate_back",
  "browser_resize",
  "browser_tabs",
  "browser_wait_for",
]) {
  assert.throws(() => assertTelegramPermissionBoundary({
    ...safePermissionFixture,
    permissions: {
      ...safePermissionFixture.permissions,
      allow: [
        ...safePermissionFixture.permissions.allow,
        `mcp(playwright/${nonReadOnlyBrowserTool})`,
      ],
    },
  }), /bypass or block Telegram approval/u);
}
assert.throws(() => assertTelegramPermissionBoundary({
  ...safePermissionFixture,
  toolPermission: "always-proceed",
}), /not safe for Telegram approval/u);
assert.throws(() => assertTelegramPermissionBoundary({
  ...safePermissionFixture,
  toolPermission: "strict",
}), /not safe for Telegram approval/u);
assert.throws(() => assertTelegramPermissionBoundary({
  ...safePermissionFixture,
  permissions: { ...safePermissionFixture.permissions, ask: ["command(*)"] },
}), /bypass or block Telegram approval/u);
for (const unsafeTopLevel of [
  { enableTerminalSandbox: true },
  { allowNonWorkspaceAccess: true },
  { artifactReviewPolicy: "never" },
]) {
  assert.throws(() => assertTelegramPermissionBoundary({
    ...safePermissionFixture,
    ...unsafeTopLevel,
  }), /not safe for Telegram approval/u);
}
const missingSandboxFixture = { ...safePermissionFixture };
delete missingSandboxFixture.enableTerminalSandbox;
assert.throws(
  () => assertTelegramPermissionBoundary(missingSandboxFixture),
  /not safe for Telegram approval/u,
);
assert.throws(() => assertTelegramPermissionBoundary({
  ...safePermissionFixture,
  permissions: {
    ...safePermissionFixture.permissions,
    allow: safePermissionFixture.permissions.allow.slice(1),
  },
}), /bypass or block Telegram approval/u);
assert.throws(() => assertTelegramPermissionBoundary({
  ...safePermissionFixture,
  permissions: {
    ...safePermissionFixture.permissions,
    deny: [...safePermissionFixture.permissions.deny, "command(*)"],
  },
}), /bypass or block Telegram approval/u);
assert.equal(toolActionWatchdogMs(120_000, null, 5_000), 127_000);
assert.equal(toolActionWatchdogMs(4_000, 250, 50), 250);
assert.throws(() => toolActionWatchdogMs(120_001, null, 5_000), /watchdog/u);
assert.throws(() => assertTelegramPermissionBoundary({
  ...safePermissionFixture,
  permissions: {
    ...safePermissionFixture.permissions,
    deny: safePermissionFixture.permissions.deny.slice(1),
  },
}), /bypass or block Telegram approval/u);
assert.equal(
  ANTIGRAVITY_AUTH_REQUIRED_MARKER.toString("utf8"),
  "Error: authentication required. Run 'antigravity-real' to log in, then retry.",
);
assert.equal(
  ANTIGRAVITY_HEADLESS_PERMISSION_MARKER.toString("utf8"),
  'a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.',
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
assert.equal(proposalDisposition("request-review", "low"), "human_confirmation");
assert.equal(proposalDisposition("strict", "high"), "human_confirmation");
assert.equal(proposalDisposition("always-proceed", "low"), "autonomous_policy");
assert.equal(proposalDisposition("always-proceed", "high"), "human_confirmation");
assert.throws(() => proposalDisposition("autonomous", "low"), /invalid/u);

const planArgs = buildAgyArgs("plan", true);
assert.deepEqual(planArgs.slice(0, 2), ["--output-format", "stream-json"]);
assert.equal(planArgs.includes("--print"), false);
assert.equal(planArgs.includes("-p"), false);
assert.equal(planArgs.includes("--prompt"), false);
assert.equal(planArgs.includes("--json-schema"), false);
assert.equal(planArgs.includes("ha-telegram"), false);
assert.equal(planArgs.includes("--agent"), false);
assert.equal(planArgs.includes("--mode"), false);
assert.equal(planArgs.filter((value) => value === "--disable-slash-commands").length, 1);
assert.equal(planArgs.includes("--print-timeout"), true);
assert.equal(planArgs.includes("--sandbox"), false);
assert.equal(planArgs.includes("-c"), false);
assert.equal(planArgs.includes("approval_policy"), false);
assert.equal(buildAgyArgs("execute", false).includes("accept-edits"), false);
assert.equal(buildAgyArgs("execute", false).includes("plan"), false);

const stream = [
  JSON.stringify({ event: "init", conversation_id: "conversation.fixture-1" }),
  JSON.stringify({ event: "step_update", tool_info: { output: "secret tool output" } }),
  JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conversation.fixture-1",
      status: "SUCCESS",
      response: "최종 응답\n",
    },
  }),
].join("\n");
assert.deepEqual(parseStreamResult(stream), {
  response: "최종 응답\n",
  proposalIds: [],
  proposalKind: null,
  proposalReceipts: [],
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
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "terminal_status_failed",
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
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "conversation_mismatch",
);

const proposalOutputCanary = "PRIVATE_PROPOSAL_PREVIEW_CANARY";
const proposalId = "proposalFixture1234567890";
const parsedProposalStream = parseStreamResult([
  JSON.stringify({ event: "init", conversation_id: "conversation.proposal" }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      step_index: 3,
      step_type: "tool",
      state: "ACTIVE",
      tool_name: "call_mcp_tool",
      tool_info: {
        name: "call_mcp_tool",
        parameters: {
          Arguments: { summary: "fixture" },
          ServerName: "ha_change",
          ToolName: "ha_change_propose",
        },
      },
    },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      step_index: 3,
      step_type: "tool",
      state: "DONE",
      tool_name: "call_mcp_tool",
      tool_info: {
        name: "call_mcp_tool",
        parameters: {
          Arguments: { summary: "fixture" },
          ServerName: "ha_change",
          ToolName: "ha_change_propose",
        },
        output: JSON.stringify({
          proposal_id: proposalId,
          preview: proposalOutputCanary,
          requester: { user_id: "100", chat_id: "-200" },
        }),
      },
    },
  }),
  JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conversation.proposal",
      status: "SUCCESS",
      response: "변경 제안을 준비했습니다.",
    },
  }),
].join("\n"));
assert.deepEqual(parsedProposalStream, {
  response: "변경 제안을 준비했습니다.",
  proposalIds: [proposalId],
  proposalKind: "ha_change",
  proposalReceipts: [{
    proposalId,
    proposalKind: "ha_change",
    requestDigest: null,
    stepIndex: 3,
  }],
  conversationId: "conversation.proposal",
});
assert.equal(JSON.stringify(parsedProposalStream).includes(proposalOutputCanary), false);

const telegramActionProposalId = "ta_actionProposalFixture123456";
const telegramActionDigest = `sha256:${"a".repeat(64)}`;
assert.deepEqual(parseStreamResult([
  JSON.stringify({ event: "init", conversation_id: "conversation.telegram-action" }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      step_index: 4,
      step_type: "tool",
      state: "DONE",
      tool_name: "call_mcp_tool",
      tool_info: {
        name: "call_mcp_tool",
        parameters: {
          Arguments: { operation: "terminal_command" },
          ServerName: "telegram_action",
          ToolName: "telegram_action_propose",
          toolAction: "Register approval card",
          toolSummary: "Prepared terminal proposal",
        },
        output: JSON.stringify({
          proposal_id: telegramActionProposalId,
          request_digest: telegramActionDigest,
        }),
      },
    },
  }),
  JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conversation.telegram-action",
      status: "SUCCESS",
      response: "",
    },
  }),
].join("\n")), {
  response: "Telegram에서 확인할 작업 제안을 준비했습니다.",
  proposalIds: [telegramActionProposalId],
  proposalKind: "telegram_action",
  proposalReceipts: [{
    proposalId: telegramActionProposalId,
    proposalKind: "telegram_action",
    requestDigest: telegramActionDigest,
    stepIndex: 4,
  }],
  conversationId: "conversation.telegram-action",
});

const managedProposalStep = ({ state, stepIndex = 7, output = null, metadata = {} }) => ({
  event: "step_update",
  step_update: {
    step_index: stepIndex,
    step_type: "tool",
    state,
    tool_name: "call_mcp_tool",
    tool_info: {
      name: "call_mcp_tool",
      parameters: {
        Arguments: { summary: "fixture" },
        ServerName: "ha_change",
        ToolName: "ha_change_propose",
        ...metadata,
      },
      ...(output === null ? {} : { output }),
    },
  },
});
const successTerminal = (conversationId, response = "fixture response") => ({
  event: "result",
  result: { conversation_id: conversationId, status: "SUCCESS", response },
});
for (const [suffix, metadata] of [
  ["action", { toolAction: "Proposing Home Assistant change" }],
  ["summary", { toolSummary: "Prepared a validated proposal" }],
  ["both", { toolSummary: "Prepared proposal", toolAction: "Propose change" }],
  ["reverse", { toolAction: "Propose change", toolSummary: "Prepared proposal" }],
]) {
  const conversationId = `conversation.metadata-${suffix}`;
  assert.deepEqual(parseStreamResult([
    JSON.stringify({ event: "init", conversation_id: conversationId }),
    JSON.stringify(managedProposalStep({
      state: "DONE",
      metadata,
      output: JSON.stringify({ proposal_id: proposalId }),
    })),
    JSON.stringify(successTerminal(conversationId, "metadata compatible")),
  ].join("\n")), {
    response: "metadata compatible",
    proposalIds: [proposalId],
    proposalKind: "ha_change",
    proposalReceipts: [{
      proposalId,
      proposalKind: "ha_change",
      requestDigest: null,
      stepIndex: 7,
    }],
    conversationId,
  });
}
for (const [suffix, metadata] of [
  ["unknown", { unexpectedMetadata: "blocked" }],
  ["non-string", { toolAction: { unsafe: true } }],
  ["control", { toolSummary: "unsafe\u0000metadata" }],
  ["oversize", { toolAction: "a".repeat(1_025) }],
]) {
  const conversationId = `conversation.metadata-invalid-${suffix}`;
  assert.throws(
    () => parseStreamResult([
      JSON.stringify({ event: "init", conversation_id: conversationId }),
      JSON.stringify(managedProposalStep({
        state: "DONE",
        metadata,
        output: JSON.stringify({ proposal_id: proposalId }),
      })),
      JSON.stringify(successTerminal(conversationId)),
    ].join("\n")),
    (error) => error instanceof AntigravityWorkerError &&
      error.reasonClass === "proposal_result_invalid",
  );
}
assert.deepEqual(parseStreamResult([
  JSON.stringify({ event: "init", conversation_id: "conversation.empty-proposal-response" }),
  JSON.stringify(managedProposalStep({
    state: "DONE",
    output: JSON.stringify({ proposal_id: proposalId }),
  })),
  JSON.stringify(successTerminal("conversation.empty-proposal-response", "  \n")),
].join("\n")), {
  response: "Home Assistant 변경 제안을 준비했습니다.",
  proposalIds: [proposalId],
  proposalKind: "ha_change",
  proposalReceipts: [{
    proposalId,
    proposalKind: "ha_change",
    requestDigest: null,
    stepIndex: 7,
  }],
  conversationId: "conversation.empty-proposal-response",
});
assert.throws(
  () => parseStreamResult([
    JSON.stringify({ event: "init", conversation_id: "conversation.empty-no-proposal" }),
    JSON.stringify(successTerminal("conversation.empty-no-proposal", "")),
  ].join("\n")),
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "terminal_response_invalid",
);
assert.throws(
  () => parseStreamResult([
    JSON.stringify({
      event: "init",
      conversation_id: "conversation.permission-denied-with-response",
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 9,
        step_type: "tool",
        state: "ERROR",
        tool_name: "run_command",
        tool_info: {
          name: "run_command",
          output: "User denied permission to run command",
        },
      },
    }),
    JSON.stringify(successTerminal(
      "conversation.permission-denied-with-response",
      "명령을 실행하지 못했습니다.",
    )),
  ].join("\n")),
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "headless_permission_denied",
);
for (const [suffix, response] of [
  ["non-string-with-proposal", { invalid: true }],
  ["oversize-with-proposal", " ".repeat(32_769)],
]) {
  const conversationId = `conversation.${suffix}`;
  assert.throws(
    () => parseStreamResult([
      JSON.stringify({ event: "init", conversation_id: conversationId }),
      JSON.stringify(managedProposalStep({
        state: "DONE",
        output: JSON.stringify({ proposal_id: proposalId }),
      })),
      JSON.stringify({
        event: "result",
        result: { conversation_id: conversationId, status: "SUCCESS", response },
      }),
    ].join("\n")),
    (error) => error instanceof AntigravityWorkerError &&
      error.reasonClass === "terminal_response_invalid",
  );
}
assert.throws(
  () => parseStreamResult([
    JSON.stringify({ event: "init", conversation_id: "conversation.non-string-response" }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation.non-string-response",
        status: "SUCCESS",
        response: null,
      },
    }),
  ].join("\n")),
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "terminal_response_invalid",
);
assert.throws(
  () => parseStreamResult([
    JSON.stringify({ event: "init", conversation_id: "conversation.missing-receipt" }),
    JSON.stringify(managedProposalStep({ state: "ACTIVE" })),
    JSON.stringify(successTerminal("conversation.missing-receipt")),
  ].join("\n")),
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "proposal_result_invalid",
);
assert.throws(
  () => parseStreamResult([
    JSON.stringify({ event: "init", conversation_id: "conversation.multiple-proposals" }),
    JSON.stringify(managedProposalStep({
      state: "DONE",
      stepIndex: 7,
      output: JSON.stringify({ proposal_id: proposalId }),
    })),
    JSON.stringify(managedProposalStep({
      state: "DONE",
      stepIndex: 8,
      output: JSON.stringify({ proposal_id: "proposalFixture0987654321" }),
    })),
    JSON.stringify(successTerminal("conversation.multiple-proposals")),
  ].join("\n")),
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "proposal_result_invalid",
);
assert.deepEqual(parseStreamResult([
  JSON.stringify({ event: "init", conversation_id: "conversation.other-mcp" }),
  JSON.stringify({
    ...managedProposalStep({ state: "DONE", output: proposalOutputCanary }),
    step_update: {
      ...managedProposalStep({ state: "DONE", output: proposalOutputCanary }).step_update,
      tool_info: {
        ...managedProposalStep({ state: "DONE", output: proposalOutputCanary }).step_update.tool_info,
        parameters: {
          Arguments: {},
          ServerName: "user_plugin",
          ToolName: "ha_change_propose",
        },
      },
    },
  }),
  JSON.stringify(successTerminal("conversation.other-mcp", "other MCP ignored")),
].join("\n")), {
  response: "other MCP ignored",
  proposalIds: [],
  proposalKind: null,
  proposalReceipts: [],
  conversationId: "conversation.other-mcp",
});
assert.throws(
  () => parseStreamResult([
    JSON.stringify({ event: "init", conversation_id: "conversation.bad-proposal" }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_type: "tool",
        state: "DONE",
        tool_name: "call_mcp_tool",
        tool_info: {
          name: "call_mcp_tool",
          parameters: {
            Arguments: {},
            ServerName: "ha_change",
            ToolName: "ha_change_propose",
          },
          output: "not-json",
        },
      },
    }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation.bad-proposal",
        status: "SUCCESS",
        response: "must not escape",
      },
    }),
  ].join("\n")),
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "proposal_result_invalid",
);
assert.throws(
  () => parseStreamResult("not json\n"),
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "stream_contract_failed",
);
assert.throws(
  () => parseStreamResult(`${JSON.stringify({ event: "unexpected" })}\n`),
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "stream_contract_failed",
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
      response: "future compatible",
    },
  }),
].join("\n")), {
  response: "future compatible",
  proposalIds: [],
  proposalKind: null,
  proposalReceipts: [],
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
    (error) => error instanceof AntigravityWorkerError &&
      error.reasonClass === "stream_contract_failed",
  );
}
assert.throws(
  () => parseStreamResult(`${JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conversation.missing-init",
      status: "SUCCESS",
      response: "missing init",
    },
  })}\n`),
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "stream_contract_failed",
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
        response: "late init",
      },
    }),
  ].join("\n")),
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "stream_contract_failed",
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
        response: "duplicate init",
      },
    }),
  ].join("\n")),
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "stream_contract_failed",
);
assert.throws(
  () => parseStreamResult(Buffer.from([0xc3, 0x28, 0x0a])),
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "stream_contract_failed",
);
assert.throws(
  () => parseStreamResult([
    JSON.stringify({ event: "init", conversation_id: "conversation.terminal" }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation.terminal",
        status: "SUCCESS",
        response: "done",
      },
    }),
    JSON.stringify({ event: "future_after_terminal" }),
  ].join("\n")),
  (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "stream_contract_failed",
);
assert.deepEqual(terminalExecutionResult({
  status: "in_doubt",
  operation: "multi_choice_service_call",
  choice_id: "dry_mode",
  reason: "synthetic_transport_loss",
}), {
  status: "in_doubt",
  operation: "multi_choice_service_call",
  choice_id: "dry_mode",
  reason: "synthetic_transport_loss",
  changed: null,
  replayed: false,
});
assert.throws(
  () => terminalExecutionResult({
    status: "running",
    operation: "service_call",
    choice_id: "must_not_exist",
  }),
  /invalid execution choice binding/u,
);
assert.throws(
  () => terminalExecutionResult({
    status: "completed",
    operation: "multi_choice_service_call",
    choice_id: "dry_mode",
    result: {
      status: "succeeded",
      operation: "multi_choice_service_call",
      choice_id: "cool_24",
    },
  }),
  /invalid execution result choice binding/u,
);
assert.deepEqual(await waitForExecution(
  { surface: "telegram", user_id: "100", chat_id: "-200" },
  "tgcb:100:-200:timeout-choice",
  {
    initialState: {
      status: "running",
      operation: "multi_choice_service_call",
      choice_id: "dry_mode",
    },
    waitTimeoutMs: 0,
  },
), {
  status: "in_doubt",
  operation: "multi_choice_service_call",
  choice_id: "dry_mode",
  reason: "durable_result_wait_timeout",
  changed: null,
  replayed: false,
});
assert.ok(chunkText("A".repeat(32_768)).every((part) => Array.from(part).length <= 4_096));
assert.throws(() => chunkText("A".repeat(32_769)), /message limit/u);
assert.equal(safeError(new Error("Bearer abc\nnext")).includes("abc"), false);
assert.deepEqual(workerFailureAuditFields({
  workerFailure: {
    failure_kind: "spawn_error",
    signal: "SECRET_SIGNAL_CANARY",
    errno: "SECRET_ERRNO_CANARY",
    exit_code: 42,
    flags: ["stdout_seen", "SECRET_FLAG_CANARY"],
  },
}), {
  failure_kind: "spawn_error",
  flags: [
    "errno_unrecognized",
    "exit_code_unrecognized",
    "signal_unrecognized",
    "stdout_seen",
  ],
});

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

const backgroundDeliveryRoot = await mkdtemp(join(tmpdir(), "telegram-background-delivery-"));
try {
  const managedRoot = join(backgroundDeliveryRoot, "data", "antigravity-ha");
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  await chmod(managedRoot, 0o700);
  const statePath = join(managedRoot, "telegram", "bridge-state.json");
  let polls = 0;
  let handlerAttempts = 0;
  const waits = [];
  const offset = await pollUpdateBatches(config, {
    statePath,
    api: async (_token, method) => {
      assert.equal(method, "getUpdates");
      polls += 1;
      if (polls === 1) {
        return [{
          update_id: 250,
          message: {
            message_id: 250,
            from: { id: 100 },
            chat: { id: -200, type: "private" },
            text: "background delivery failure",
          },
        }];
      }
      await new Promise((resolve) => setImmediate(resolve));
      return [];
    },
    messageHandler: async () => {
      handlerAttempts += 1;
      if (handlerAttempts === 1) {
        throw Object.assign(new Error("chat blocked the bot"), {
          status: 403,
          telegramMethod: "sendMessage",
        });
      }
    },
    wait: async (milliseconds) => waits.push(milliseconds),
    shouldContinue: () => polls < 3,
  });
  assert.equal(offset, 251);
  assert.equal(polls, 3);
  assert.equal(handlerAttempts, 2);
  assert.equal(waits.length, 1, "sendMessage 403 should back off without killing polling");
} finally {
  resetUpdateRuntimeForTest();
  await rm(backgroundDeliveryRoot, { recursive: true, force: true });
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
const callback64 = "x".repeat(64);
assert.equal(normalizeUpdate({
  update_id: 13,
  callback_query: {
    id: "callback-64",
    from: { id: 100 },
    message: { chat: { id: -200, type: "private" } },
    data: callback64,
  },
})?.value.data, callback64);
assert.equal(normalizeUpdate({
  update_id: 14,
  callback_query: {
    id: "callback-65",
    from: { id: 100 },
    message: { chat: { id: -200, type: "private" } },
    data: "x".repeat(65),
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
  const hangingExecutor = join(fixtureDir, "hanging-executor.mjs");
  await writeFile(hangingExecutor, `#!/bin/sh
cat >/dev/null
sleep 10
`, "utf8");
  await chmod(hangingExecutor, 0o755);
  const uncertainExecution = await runToolActionExecutor({
    status: "committed",
    action_json: JSON.stringify({
      action: {
        kind: "terminal",
        source_kind: "command",
        shell_source: "true",
        source_sha256: `sha256:${"a".repeat(64)}`,
        cwd: "/config",
        timeout_ms: 1_000,
      },
      execution_digest: `sha256:${"b".repeat(64)}`,
    }),
    operation: "terminal_command",
    selected_choice_id: null,
    user_id: "100",
    chat_id: "-200",
    generation: 1,
    update_id: 50,
    run_id: "c".repeat(32),
    conversation_id: "conversation-watchdog",
    proposal_id: `ta_${"d".repeat(24)}`,
  }, {
    binary: hangingExecutor,
    workspace: fixtureDir,
    timeoutMs: 25,
    hardKillGraceMs: 10,
  });
  assert.equal(uncertainExecution.status, "in_doubt");
  assert.equal(uncertainExecution.timed_out, true);

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
  home: process.env.HOME,
  channel: process.env.ANTIGRAVITY_HA_CHANNEL,
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
    response: JSON.stringify(payload),
  },
}) + "\\n");
`, "utf8");
  process.env.SUPERVISOR_TOKEN = "must-not-be-inherited";
  resetWorkerStatusForTest();
  assert.equal(workerStatusSnapshot(), "not_checked");
  assert.equal(renderWorkerStatus(), "아직 확인되지 않음");
  const malicious = "literal $(touch /tmp/telegram-pwned) `id` ; echo nope";
  let initializedConversation = null;
  const result = await runAntigravityPrompt(malicious, {
    binary: process.execPath,
    prefixArgs: [fake],
    cwd: fixtureDir,
    timeoutMs: 5_000,
    requester: { user_id: "100", chat_id: "-200" },
    conversationId: "conversation.fixture-1",
    onConversation: (conversationId) => { initializedConversation = conversationId; },
  });
  const payload = JSON.parse(result.response);
  assert.equal(payload.prompt, malicious);
  assert.equal(payload.autoUpdateDisabled, true);
  assert.equal(payload.home, "/data/home");
  assert.equal(payload.channel, "telegram");
  assert.equal(payload.leakedSupervisorToken, false);
  assert.deepEqual(payload.requester, ["100", "-200"]);
  assert.equal(payload.argv.includes(malicious), false);
  assert.equal(payload.argv.includes("--output-format"), true);
  assert.equal(payload.argv.includes("--conversation"), true);
  assert.equal(initializedConversation, "conversation.fixture-1");
  assert.equal(workerStatusSnapshot(), "ready");
  assert.equal(renderWorkerStatus(), "최근 요청 정상");
  let mismatchedConversationBound = false;
  await assert.rejects(runAntigravityPrompt("resume mismatch", {
    binary: process.execPath,
    prefixArgs: [fake],
    cwd: fixtureDir,
    timeoutMs: 5_000,
    requester: { user_id: "100", chat_id: "-200" },
    conversationId: "conversation.expected-other",
    onConversation: () => { mismatchedConversationBound = true; },
  }), (error) => error instanceof AntigravityWorkerError &&
    error.reasonClass === "conversation_mismatch");
  assert.equal(mismatchedConversationBound, false);

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
  assert.equal(renderWorkerStatus(), "공유 Antigravity 로그인 필요 (antigravity)");
  const authFailureMessage = renderRequestFailure(authFailure);
  assert.match(authFailureMessage, /antigravity/u);
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
  assert.equal(permissionFailure.reasonClass, "headless_permission_denied");
  assert.equal(requestFailureReason(permissionFailure), "headless_permission_denied");
  assert.equal(workerStatusSnapshot(), "headless_permission_denied");
  assert.equal(renderWorkerStatus(), "직접 도구 실행 차단 (Telegram 승인 제안 필요)");
  const permissionFailureMessage = renderRequestFailure(permissionFailure);
  assert.match(permissionFailureMessage, /Telegram 승인 경계/u);
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
    response: "safe response",
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
    (error) => error instanceof AntigravityWorkerError &&
      error.reasonClass === "stream_contract_failed",
  );
  assert.equal(workerStatusSnapshot(), "stream_contract_failed");

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
  assert.deepEqual(workerFailureAuditFields(nativeExit70Failure), {
    failure_kind: "exit_code",
    exit_code: 70,
    flags: ["stderr_seen"],
  });

  const nativeSigsegvFake = join(fixtureDir, "native-sigsegv-agy.mjs");
  await writeFile(nativeSigsegvFake, `
for await (const _chunk of process.stdin) { /* drain stdin */ }
process.stderr.write("native signal diagnostic ${stderrCanary}\\n");
process.kill(process.pid, "SIGSEGV");
`, "utf8");
  let nativeSigsegvFailure;
  try {
    await runAntigravityPrompt("private native SIGSEGV prompt canary", {
      binary: process.execPath,
      prefixArgs: [nativeSigsegvFake],
      cwd: fixtureDir,
      timeoutMs: 5_000,
      requester: { user_id: "100", chat_id: "-200" },
    });
    assert.fail("SIGSEGV worker unexpectedly succeeded");
  } catch (error) {
    nativeSigsegvFailure = error;
  }
  assert.ok(nativeSigsegvFailure instanceof AntigravityWorkerError);
  assert.equal(nativeSigsegvFailure.reasonClass, "worker_failed");
  assert.deepEqual(workerFailureAuditFields(nativeSigsegvFailure), {
    failure_kind: "signal",
    signal: "SIGSEGV",
    flags: ["stderr_seen"],
  });
  for (const forbidden of [
    stderrCanary,
    "private native SIGSEGV prompt canary",
    nativeSigsegvFake,
  ]) {
    assert.equal(JSON.stringify(workerFailureAuditFields(nativeSigsegvFailure)).includes(forbidden), false);
  }

  const auditBoundaryPromptCanary = "PRIVATE_AUDIT_BOUNDARY_PROMPT_CANARY";
  const auditBoundaryStderrCanary = "PRIVATE_AUDIT_BOUNDARY_STDERR_CANARY";
  const auditBoundaryPathCanary = "PRIVATE_AUDIT_BOUNDARY_PATH_CANARY";
  const auditBoundaryRoot = join(fixtureDir, auditBoundaryPathCanary);
  const auditManagedRoot = join(auditBoundaryRoot, "data", "antigravity-ha");
  await mkdir(auditManagedRoot, { recursive: true, mode: 0o700 });
  await chmod(auditManagedRoot, 0o700);
  const auditStatePath = join(auditManagedRoot, "telegram", "bridge-state.json");
  Object.assign(nativeSigsegvFailure, {
    path: auditBoundaryPathCanary,
    prompt: auditBoundaryPromptCanary,
    stderr: auditBoundaryStderrCanary,
    token: config.botToken,
  });
  let auditApiCalls = 0;
  const auditLines = [];
  const sentAuditFailures = [];
  const originalConsoleLog = console.log;
  console.log = (...parts) => { auditLines.push(parts.join(" ")); };
  try {
    await handleMessage(config, {
      updateId: 970,
      message_id: 970,
      from: { id: "100" },
      chat: { id: "-200", type: "private" },
      text: auditBoundaryPromptCanary,
    }, {
      statePath: auditStatePath,
      api: () => {
        auditApiCalls += 1;
        throw nativeSigsegvFailure;
      },
      send: async (token, chatId, text) => {
        assert.equal(token, config.botToken);
        assert.equal(chatId, "-200");
        sentAuditFailures.push(text);
      },
    });
  } finally {
    console.log = originalConsoleLog;
  }
  assert.equal(auditApiCalls, 1);
  assert.equal(sentAuditFailures.length, 1);
  const auditRecords = auditLines
    .filter((line) => line.startsWith("[Telegram Bridge] "))
    .map((line) => JSON.parse(line.slice("[Telegram Bridge] ".length)));
  const workerFailureRecord = auditRecords.find((record) => record.event === "request_failed");
  assert.ok(workerFailureRecord);
  const { chat: workerFailureChat, ...workerFailureFields } = workerFailureRecord;
  assert.match(workerFailureChat, /^[a-f0-9]{12}$/u);
  assert.deepEqual(workerFailureFields, {
    event: "request_failed",
    reason_class: "worker_failed",
    failure_kind: "signal",
    signal: "SIGSEGV",
    flags: ["stderr_seen"],
  });
  const serializedAudit = JSON.stringify(auditRecords);
  for (const forbidden of [
    auditBoundaryPromptCanary,
    auditBoundaryStderrCanary,
    auditBoundaryPathCanary,
    config.botToken,
  ]) {
    assert.equal(serializedAudit.includes(forbidden), false);
  }

  let missingBinaryFailure;
  try {
    await runAntigravityPrompt("private spawn error prompt canary", {
      binary: join(fixtureDir, "missing-antigravity-binary"),
      cwd: fixtureDir,
      timeoutMs: 5_000,
      requester: { user_id: "100", chat_id: "-200" },
    });
    assert.fail("missing worker binary unexpectedly started");
  } catch (error) {
    missingBinaryFailure = error;
  }
  assert.ok(missingBinaryFailure instanceof AntigravityWorkerError);
  assert.deepEqual(workerFailureAuditFields(missingBinaryFailure), {
    failure_kind: "spawn_error",
    errno: "ENOENT",
    flags: [],
  });

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
    (error) => error instanceof AntigravityWorkerError &&
      error.reasonClass === "stream_contract_failed",
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
    response: id,
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
