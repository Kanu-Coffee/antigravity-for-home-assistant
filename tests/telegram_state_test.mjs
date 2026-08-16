import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_OUTBOX_DELIVERIES,
  MAX_SEALED_UPDATE_ENTRIES,
  MAX_SESSIONS,
  acknowledgeDeliveryChunk,
  acknowledgeUpdate,
  applyNewSessionControl,
  bindSessionConversation,
  clearConversation,
  commitUpdateOffset,
  deletePendingApproval,
  deletePendingApprovalsForSession,
  cleanupPendingApprovals,
  deleteTerminalTurn,
  ensureSession,
  getConversation,
  getControlEffect,
  getPendingApproval,
  getPendingDelivery,
  getSession,
  getTerminalTurn,
  listPendingApprovals,
  listPendingDeliveries,
  loadBridgeState,
  loadSealedUpdates,
  markDeliveryAttempting,
  markDeliveryAmbiguous,
  markDeliveryPending,
  markPendingApprovalApproved,
  queueResponseDelivery,
  queueResponseDeliveryBatch,
  recoverAttemptingDeliveries,
  registerSealedUpdateBatch,
  resetSession,
  resetDeliveryForRetry,
  savePendingApproval,
  saveControlEffect,
  saveTerminalTurn,
  finalizeTerminalTurn,
  setConversation,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-state.mjs";

const BOT_TOKEN = `123456:${"A".repeat(35)}`;
const WRONG_BOT_TOKEN = `654321:${"B".repeat(35)}`;

function normalizedMessage(updateId, text = `update ${updateId}`) {
  return {
    updateId,
    kind: "message",
    value: {
      updateId,
      message_id: updateId + 1,
      from: { id: "10001" },
      chat: { id: "-20002", type: "private" },
      text,
    },
  };
}

function sealedRecord(updateId, text) {
  return { update_id: updateId, normalized: normalizedMessage(updateId, text) };
}

function responseDelivery(updateId, generation = 1, chunks = ["first", "second"], id = null) {
  return {
    delivery_id: id ?? `delivery-${updateId}`,
    update_id: updateId,
    user_id: "10001",
    chat_id: "-20002",
    generation,
    stage: "assistant",
    chunks,
    reply_markup: null,
  };
}

function terminalTurn(updateId, generation = 1, proposalId = null) {
  return {
    turn_id: `terminal-${updateId}`,
    update_id: updateId,
    user_id: "10001",
    chat_id: "-20002",
    generation,
    conversation_id: "conversation.terminal",
    response: `terminal response ${updateId}`,
    proposal_id: proposalId,
  };
}

function pendingApproval(generation = 1, id = "approval-1") {
  return {
    approval_id: id,
    user_id: "10001",
    chat_id: "-20002",
    generation,
    conversation_id: "conversation.approval",
    proposal_id: "proposal_canary",
    preview_digest: `sha256:${"c".repeat(64)}`,
    risk: "high",
    idempotency_key: "tg:10001:-20002:12345",
    expires_at: Date.now() + 120_000,
    approved_update_id: null,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "telegram-state-"));
  const managedRoot = join(root, "data", "antigravity-ha");
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  await chmod(managedRoot, 0o700);
  return { root, path: join(managedRoot, "telegram", "bridge-state.json") };
}

test("session binding persists until explicit reset and rejects stale or conflicting binds", async () => {
  const paths = await fixture();
  try {
    commitUpdateOffset(41, paths);
    const created = ensureSession("10001", "-20002", paths);
    assert.deepEqual(created, {
      user_id: "10001",
      chat_id: "-20002",
      generation: 1,
      conversation_id: null,
    });
    const bound = bindSessionConversation(
      "10001",
      "-20002",
      created.generation,
      "conversation.abc-123",
      paths,
    );
    assert.equal(bound.conversation_id, "conversation.abc-123");
    assert.equal(loadBridgeState(paths.path).update_offset, 41);
    assert.equal(getConversation("10001", "-20002", paths), "conversation.abc-123");
    assert.equal(getConversation("10002", "-20002", paths), null);
    assert.throws(
      () => bindSessionConversation("10001", "-20002", 1, "conversation.other", paths),
      /already bound/u,
    );

    const reset = resetSession("10001", "-20002", paths);
    assert.equal(reset.generation, 2);
    assert.equal(reset.conversation_id, null);
    assert.throws(
      () => bindSessionConversation("10001", "-20002", 1, "conversation.stale", paths),
      /stale/u,
    );
    assert.equal(
      bindSessionConversation("10001", "-20002", 2, "conversation.next", paths)
        .conversation_id,
      "conversation.next",
    );
    const raw = await readFile(paths.path, "utf8");
    assert.equal(raw.includes("prompt"), false);
    assert.equal((await stat(paths.path)).mode & 0o777, 0o600);
    assert.equal(clearConversation("10001", "-20002", paths), true);
    assert.equal(getSession("10001", "-20002", paths).generation, 3);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("compatibility conversation helpers keep permanent state and never replace a binding", async () => {
  const paths = await fixture();
  try {
    setConversation("10001", "-20002", "conversation-permanent", paths);
    assert.equal(getConversation("10001", "-20002", {
      ...paths,
      now: Date.now() + (365 * 24 * 60 * 60 * 1_000),
    }), "conversation-permanent");
    assert.throws(
      () => setConversation("10001", "-20002", "conversation-replacement", paths),
      /already bound/u,
    );
    commitUpdateOffset(100, paths);
    assert.throws(() => commitUpdateOffset(99, paths), /cannot move backwards/u);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("session capacity fails closed without silently evicting an existing session", async () => {
  const paths = await fixture();
  try {
    for (let index = 0; index < MAX_SESSIONS; index += 1) {
      ensureSession(String(10_000 + index), "-20002", paths);
    }
    assert.throws(
      () => ensureSession("999999", "-20002", paths),
      /capacity is full/u,
    );
    assert.equal(getSession("10000", "-20002", paths)?.generation, 1);
    assert.equal(loadBridgeState(paths.path).sessions.length, MAX_SESSIONS);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("response outbox encrypts chunks, queues idempotently, and acknowledges each chunk", async () => {
  const paths = await fixture();
  const canaryOne = "SEALED_RESPONSE_CHUNK_ONE";
  const canaryTwo = "SEALED_RESPONSE_CHUNK_TWO";
  try {
    const session = ensureSession("10001", "-20002", paths);
    const delivery = responseDelivery(
      70,
      session.generation,
      [canaryOne, canaryTwo],
    );
    const queued = queueResponseDelivery(delivery, BOT_TOKEN, paths);
    assert.deepEqual(queued, {
      ...delivery,
      status: "pending",
      attempt_count: 0,
      next_chunk_index: 0,
    });
    assert.deepEqual(queueResponseDelivery(delivery, BOT_TOKEN, paths), queued);
    const equivalent = queueResponseDelivery(
      { ...delivery, delivery_id: "alternate-delivery-id" },
      BOT_TOKEN,
      paths,
    );
    assert.equal(equivalent.delivery_id, delivery.delivery_id);
    assert.equal(loadBridgeState(paths.path).response_outbox.length, 1);
    assert.throws(
      () => queueResponseDelivery({ ...delivery, chunks: ["changed"] }, BOT_TOKEN, paths),
      /changed after durable registration/u,
    );

    const raw = await readFile(paths.path, "utf8");
    assert.equal(raw.includes(canaryOne), false);
    assert.equal(raw.includes(canaryTwo), false);
    assert.equal(raw.includes(BOT_TOKEN), false);
    assert.deepEqual(getPendingDelivery(delivery.delivery_id, BOT_TOKEN, paths), queued);
    assert.deepEqual(listPendingDeliveries(BOT_TOKEN, paths), [queued]);

    const attempting = markDeliveryAttempting(delivery.delivery_id, 0, paths);
    assert.equal(attempting.status, "attempting");
    assert.equal(attempting.attempt_count, 1);
    const ambiguous = markDeliveryAmbiguous(delivery.delivery_id, 0, paths);
    assert.equal(ambiguous.status, "ambiguous");
    assert.equal(getPendingDelivery(delivery.delivery_id, BOT_TOKEN, paths).status, "ambiguous");
    assert.throws(
      () => acknowledgeDeliveryChunk(delivery.delivery_id, 1, paths),
      /in order/u,
    );
    resetDeliveryForRetry(
      delivery.delivery_id,
      delivery.user_id,
      delivery.chat_id,
      delivery.generation,
      paths,
    );
    markDeliveryAttempting(delivery.delivery_id, 0, paths);
    assert.deepEqual(acknowledgeDeliveryChunk(delivery.delivery_id, 0, paths), {
      completed: false,
      next_chunk_index: 1,
    });
    assert.equal(getPendingDelivery(delivery.delivery_id, BOT_TOKEN, paths).status, "pending");
    markDeliveryAttempting(delivery.delivery_id, 1, paths);
    assert.deepEqual(acknowledgeDeliveryChunk(delivery.delivery_id, 1, paths), {
      completed: true,
      next_chunk_index: null,
    });
    assert.equal(getPendingDelivery(delivery.delivery_id, BOT_TOKEN, paths), null);
    assert.deepEqual(loadBridgeState(paths.path).response_outbox, []);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("outbox fsyncs attempting state, recovers it as ambiguous, and isolates delivery stages", async () => {
  const paths = await fixture();
  try {
    const session = ensureSession("10001", "-20002", paths);
    const [assistant, approval] = queueResponseDeliveryBatch([
      responseDelivery(71, session.generation, ["assistant canary"]),
      {
        ...responseDelivery(71, session.generation, ["approval canary"], "delivery-71-approval"),
        stage: "approval",
        reply_markup: {
          inline_keyboard: [[
            { text: "Run", callback_data: "v2a:approvalFixture123456" },
            { text: "Cancel", callback_data: "v2d:approvalFixture123456" },
          ]],
        },
      },
    ], BOT_TOKEN, paths);
    assert.notEqual(assistant.delivery_id, approval.delivery_id);
    assert.equal(listPendingDeliveries(BOT_TOKEN, paths).length, 2);
    const raw = await readFile(paths.path, "utf8");
    assert.equal(raw.includes("assistant canary"), false);
    assert.equal(raw.includes("approval canary"), false);
    assert.equal(raw.includes("callback_data"), false);
    assert.throws(() => queueResponseDeliveryBatch([
      responseDelivery(72, session.generation, ["must not persist"]),
      {
        ...responseDelivery(72, session.generation, ["invalid"], "delivery-72-approval"),
        stage: "approval",
        reply_markup: { inline_keyboard: [] },
      },
    ], BOT_TOKEN, paths), /reply markup/u);
    assert.equal(listPendingDeliveries(BOT_TOKEN, paths).length, 2);

    markDeliveryAttempting(assistant.delivery_id, 0, paths);
    assert.equal(loadBridgeState(paths.path).response_outbox[0].status, "attempting");
    assert.equal(recoverAttemptingDeliveries(paths), 1);
    assert.equal(getPendingDelivery(assistant.delivery_id, BOT_TOKEN, paths).status, "ambiguous");
    assert.equal(recoverAttemptingDeliveries(paths), 0);

    const retried = resetDeliveryForRetry(
      assistant.delivery_id,
      assistant.user_id,
      assistant.chat_id,
      assistant.generation,
      paths,
    );
    assert.equal(retried.status, "pending");
    assert.equal(retried.attempt_count, 0);
    markDeliveryAttempting(assistant.delivery_id, 0, paths);
    markDeliveryPending(assistant.delivery_id, 0, paths);
    assert.equal(
      getPendingDelivery(assistant.delivery_id, BOT_TOKEN, paths).attempt_count,
      1,
    );

    resetSession("10001", "-20002", paths);
    assert.deepEqual(listPendingDeliveries(BOT_TOKEN, paths), []);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("terminal turns are sealed and atomically finalized into staged outbox records", async () => {
  const paths = await fixture();
  try {
    const session = ensureSession("10001", "-20002", paths);
    const bound = bindSessionConversation(
      "10001",
      "-20002",
      session.generation,
      "conversation.terminal",
      paths,
    );
    const terminal = terminalTurn(73, bound.generation, "proposalTerminalFixture");
    assert.deepEqual(saveTerminalTurn(terminal, BOT_TOKEN, paths), terminal);
    assert.deepEqual(saveTerminalTurn(terminal, BOT_TOKEN, paths), terminal);
    assert.deepEqual(getTerminalTurn(terminal.turn_id, BOT_TOKEN, paths), terminal);
    const raw = await readFile(paths.path, "utf8");
    assert.equal(raw.includes(terminal.response), false);
    assert.equal(raw.includes(terminal.proposal_id), false);
    assert.equal(raw.includes(BOT_TOKEN), false);
    assert.throws(
      () => getTerminalTurn(terminal.turn_id, WRONG_BOT_TOKEN, paths),
      (error) => error?.code === "ETELEGRAMTERMINAL",
    );

    const deliveries = [
      responseDelivery(73, bound.generation, [terminal.response], "delivery-73-assistant"),
      {
        ...responseDelivery(73, bound.generation, ["approval preview"], "delivery-73-approval"),
        stage: "approval",
        reply_markup: {
          inline_keyboard: [[
            { text: "Run", callback_data: "v2a:approvalTerminalFixture" },
          ]],
        },
      },
    ];
    const finalized = finalizeTerminalTurn(terminal.turn_id, deliveries, BOT_TOKEN, paths);
    assert.equal(finalized.length, 2);
    assert.equal(getTerminalTurn(terminal.turn_id, BOT_TOKEN, paths), null);
    assert.deepEqual(
      listPendingDeliveries(BOT_TOKEN, paths).map((delivery) => delivery.stage),
      ["assistant", "approval"],
    );

    const orphan = terminalTurn(74, bound.generation);
    saveTerminalTurn(orphan, BOT_TOKEN, paths);
    assert.equal(deleteTerminalTurn(orphan.turn_id, paths), true);
    assert.equal(deleteTerminalTurn(orphan.turn_id, paths), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("control effects make new-session and cancel updates idempotent until input ACK", async () => {
  const paths = await fixture();
  try {
    const created = ensureSession("10001", "-20002", paths);
    const bound = bindSessionConversation(
      "10001",
      "-20002",
      created.generation,
      "conversation.control",
      paths,
    );
    queueResponseDelivery(responseDelivery(200, bound.generation), BOT_TOKEN, paths);
    saveTerminalTurn({
      ...terminalTurn(200, bound.generation),
      conversation_id: bound.conversation_id,
    }, BOT_TOKEN, paths);
    savePendingApproval({
      ...pendingApproval(bound.generation, "approval-control"),
      conversation_id: bound.conversation_id,
    }, BOT_TOKEN, paths);
    const newEffect = {
      update_id: 201,
      user_id: "10001",
      chat_id: "-20002",
      command: "new",
      result: "new session applied",
    };
    const applied = applyNewSessionControl(newEffect, BOT_TOKEN, paths);
    assert.equal(applied.applied, true);
    assert.equal(applied.session.generation, 2);
    assert.equal(applied.session.conversation_id, null);
    assert.deepEqual(listPendingDeliveries(BOT_TOKEN, paths), []);
    assert.deepEqual(listPendingApprovals(BOT_TOKEN, paths), []);
    assert.equal(getTerminalTurn("terminal-200", BOT_TOKEN, paths), null);
    assert.deepEqual(getControlEffect(201, "10001", "-20002", "new", paths), newEffect);
    const replayed = applyNewSessionControl(newEffect, BOT_TOKEN, paths);
    assert.equal(replayed.applied, false);
    assert.equal(replayed.session.generation, 2);

    const cancelEffect = {
      update_id: 202,
      user_id: "10001",
      chat_id: "-20002",
      command: "cancel",
      result: "nothing to cancel",
    };
    assert.deepEqual(saveControlEffect(cancelEffect, paths), cancelEffect);
    assert.deepEqual(saveControlEffect(cancelEffect, paths), cancelEffect);
    assert.throws(
      () => getControlEffect(202, "10001", "-20002", "new", paths),
      /identity changed/u,
    );

    registerSealedUpdateBatch(
      [sealedRecord(201, "/new"), sealedRecord(202, "/cancel")],
      BOT_TOKEN,
      paths,
    );
    acknowledgeUpdate(201, paths);
    assert.equal(getControlEffect(201, "10001", "-20002", "new", paths), null);
    assert.notEqual(getControlEffect(202, "10001", "-20002", "cancel", paths), null);
    acknowledgeUpdate(202, paths);
    assert.equal(getControlEffect(202, "10001", "-20002", "cancel", paths), null);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("response outbox rejects stale sessions, wrong keys, tampering, and capacity overflow", async () => {
  const paths = await fixture();
  try {
    ensureSession("10001", "-20002", paths);
    queueResponseDelivery(responseDelivery(80), BOT_TOKEN, paths);
    assert.throws(
      () => listPendingDeliveries(WRONG_BOT_TOKEN, paths),
      (error) => error?.code === "ETELEGRAMOUTBOX",
    );
    const document = JSON.parse(await readFile(paths.path, "utf8"));
    const ciphertext = document.response_outbox[0].ciphertext;
    document.response_outbox[0].ciphertext =
      `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
    await writeFile(paths.path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    assert.throws(
      () => listPendingDeliveries(BOT_TOKEN, paths),
      (error) => error?.code === "ETELEGRAMOUTBOX",
    );
    resetSession("10001", "-20002", paths);
    assert.deepEqual(listPendingDeliveries(BOT_TOKEN, paths), []);
    assert.throws(
      () => queueResponseDelivery(responseDelivery(81), BOT_TOKEN, paths),
      /stale/u,
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }

  const capacityPaths = await fixture();
  try {
    ensureSession("10001", "-20002", capacityPaths);
    for (let index = 0; index < MAX_OUTBOX_DELIVERIES; index += 1) {
      queueResponseDelivery(
        responseDelivery(10_000 + index, 1, [`chunk ${index}`]),
        BOT_TOKEN,
        capacityPaths,
      );
    }
    assert.throws(
      () => queueResponseDelivery(responseDelivery(20_000), BOT_TOKEN, capacityPaths),
      /outbox is full/u,
    );
    assert.equal(
      loadBridgeState(capacityPaths.path).response_outbox.length,
      MAX_OUTBOX_DELIVERIES,
    );
  } finally {
    await rm(capacityPaths.root, { recursive: true, force: true });
  }
});

test("pending approvals are encrypted, restart-readable, and invalidated by session generation", async () => {
  const paths = await fixture();
  try {
    const session = ensureSession("10001", "-20002", paths);
    bindSessionConversation(
      "10001",
      "-20002",
      session.generation,
      "conversation.approval",
      paths,
    );
    const approval = pendingApproval(session.generation);
    assert.deepEqual(savePendingApproval(approval, BOT_TOKEN, paths), approval);
    assert.deepEqual(savePendingApproval(approval, BOT_TOKEN, paths), approval);
    assert.deepEqual(getPendingApproval(approval.approval_id, BOT_TOKEN, paths), approval);
    assert.deepEqual(listPendingApprovals(BOT_TOKEN, paths), [approval]);

    const raw = await readFile(paths.path, "utf8");
    assert.equal(raw.includes(approval.proposal_id), false);
    assert.equal(raw.includes(approval.preview_digest), false);
    assert.equal(raw.includes(approval.idempotency_key), false);
    assert.throws(
      () => listPendingApprovals(WRONG_BOT_TOKEN, paths),
      (error) => error?.code === "ETELEGRAMAPPROVAL",
    );
    const approved = markPendingApprovalApproved(
      approval.approval_id,
      77,
      BOT_TOKEN,
      paths,
    );
    assert.equal(approved.approved_update_id, 77);
    assert.equal(
      markPendingApprovalApproved(approval.approval_id, 77, BOT_TOKEN, paths)
        .approved_update_id,
      77,
    );
    assert.throws(
      () => markPendingApprovalApproved(approval.approval_id, 78, BOT_TOKEN, paths),
      /another update/u,
    );
    assert.deepEqual(cleanupPendingApprovals(BOT_TOKEN, {
      ...paths,
      now: approval.expires_at + 1,
    }), { expired: 0, stale: 0, duplicate: 0 });

    resetSession("10001", "-20002", paths);
    assert.equal(deletePendingApprovalsForSession(
      "10001",
      "-20002",
      session.generation,
      BOT_TOKEN,
      paths,
    ), 1);
    assert.deepEqual(listPendingApprovals(BOT_TOKEN, paths), []);
    assert.throws(
      () => savePendingApproval(approval, BOT_TOKEN, paths),
      /stale/u,
    );

    const current = getSession("10001", "-20002", paths);
    bindSessionConversation(
      "10001",
      "-20002",
      current.generation,
      "conversation.approval",
      paths,
    );
    const next = pendingApproval(current.generation, "approval-2");
    savePendingApproval(next, BOT_TOKEN, paths);
    const newer = {
      ...pendingApproval(current.generation, "approval-3"),
      expires_at: next.expires_at + 1,
    };
    const expired = {
      ...pendingApproval(current.generation, "approval-expired"),
      expires_at: Date.now() - 1,
    };
    savePendingApproval(newer, BOT_TOKEN, paths);
    savePendingApproval(expired, BOT_TOKEN, paths);
    assert.deepEqual(cleanupPendingApprovals(BOT_TOKEN, {
      ...paths,
      now: Date.now(),
    }), { expired: 1, stale: 0, duplicate: 1 });
    assert.deepEqual(listPendingApprovals(BOT_TOKEN, paths), [newer]);
    assert.equal(deletePendingApproval(newer.approval_id, paths), true);
    assert.equal(deletePendingApproval(next.approval_id, paths), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("durable acknowledgement ledger commits only an observed completed prefix", async () => {
  const paths = await fixture();
  try {
    const registered = registerSealedUpdateBatch(
      [100, 102, 103].map((updateId) => sealedRecord(updateId)),
      BOT_TOKEN,
      paths,
    );
    assert.equal(registered.update_offset, 0);
    assert.equal(registered.transport_offset, 104);
    assert.deepEqual(registered.entries.map((entry) => entry.acknowledged), [false, false, false]);

    assert.equal(acknowledgeUpdate(102, paths), 0);
    const afterOutOfOrderCompletion = loadBridgeState(paths.path);
    assert.equal(afterOutOfOrderCompletion.update_offset, 0);
    assert.deepEqual(afterOutOfOrderCompletion.update_ledger, [
      { update_id: 100, acknowledged: false },
      { update_id: 102, acknowledged: true },
      { update_id: 103, acknowledged: false },
    ]);
    assert.throws(
      () => commitUpdateOffset(103, paths),
      /cannot pass an unacknowledged update/u,
    );

    assert.deepEqual(
      loadSealedUpdates(BOT_TOKEN, paths).map((update) => update.updateId),
      [100, 103],
    );
    assert.equal(acknowledgeUpdate(100, paths), 103);
    assert.deepEqual(loadBridgeState(paths.path).update_ledger, [
      { update_id: 103, acknowledged: false },
    ]);
    assert.equal(acknowledgeUpdate(103, paths), 104);
    assert.deepEqual(loadBridgeState(paths.path).update_ledger, []);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("version 3 acknowledgement state migrates without losing a later completed update", async () => {
  const paths = await fixture();
  try {
    await mkdir(join(paths.root, "data", "antigravity-ha", "telegram"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(paths.path, `${JSON.stringify({
      version: 3,
      update_offset: 0,
      update_ledger: [
        { update_id: 100, acknowledged: false },
        { update_id: 102, acknowledged: true },
      ],
      conversations: [],
    })}\n`, { encoding: "utf8", mode: 0o600 });
    const migrated = registerSealedUpdateBatch(
      [sealedRecord(100, "legacy pending")],
      BOT_TOKEN,
      paths,
    );
    assert.equal(migrated.transport_offset, 101);
    assert.equal(loadBridgeState(paths.path).version, 7);
    assert.equal(acknowledgeUpdate(100, paths), 103);
    assert.equal(loadBridgeState(paths.path).transport_offset, 103);
    assert.deepEqual(loadBridgeState(paths.path).sealed_updates, []);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("published version 2 through 4 isolated conversation ids are discarded on shared-runtime migration", async () => {
  for (const version of [2, 3, 4]) {
    const paths = await fixture();
    try {
      await mkdir(join(paths.root, "data", "antigravity-ha", "telegram"), {
        recursive: true,
        mode: 0o700,
      });
      const legacy = {
        version,
        update_offset: 0,
        conversations: [{
          user_id: "10001",
          chat_id: "-20002",
          conversation_id: `legacy-${version}`,
          last_used_at: 1,
        }],
      };
      if (version >= 3) legacy.update_ledger = [];
      if (version >= 4) {
        legacy.transport_offset = 0;
        legacy.sealed_updates = [];
      }
      await writeFile(paths.path, `${JSON.stringify(legacy)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      assert.deepEqual(getSession("10001", "-20002", paths), {
        user_id: "10001",
        chat_id: "-20002",
        generation: 1,
        conversation_id: null,
      });
      assert.equal(
        bindSessionConversation(
          "10001",
          "-20002",
          1,
          `shared-runtime-${version}`,
          paths,
        ).conversation_id,
        `shared-runtime-${version}`,
      );
      assert.equal(resetSession("10001", "-20002", paths).generation, 2);
      const migrated = loadBridgeState(paths.path);
      assert.equal(migrated.version, 7);
      assert.equal(Object.hasOwn(migrated, "conversations"), false);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  }
});

test("version 5 response outbox metadata migrates to staged attempt tracking", async () => {
  const paths = await fixture();
  try {
    const session = ensureSession("10001", "-20002", paths);
    bindSessionConversation(
      "10001",
      "-20002",
      session.generation,
      "shared-v5-provenance",
      paths,
    );
    const queued = queueResponseDelivery(responseDelivery(501), BOT_TOKEN, paths);
    const legacy = JSON.parse(await readFile(paths.path, "utf8"));
    legacy.version = 5;
    for (const entry of legacy.response_outbox) {
      delete entry.stage;
      delete entry.attempt_count;
    }
    await writeFile(paths.path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    const migrated = getPendingDelivery(queued.delivery_id, BOT_TOKEN, paths);
    assert.equal(migrated.stage, "assistant");
    assert.equal(migrated.attempt_count, 0);
    assert.equal(
      getSession("10001", "-20002", paths).conversation_id,
      "shared-v5-provenance",
    );
    markDeliveryAttempting(queued.delivery_id, 0, paths);
    assert.equal(loadBridgeState(paths.path).version, 7);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("version 6 shared-runtime state migrates to an empty version 7 terminal journal", async () => {
  const paths = await fixture();
  try {
    const session = ensureSession("10001", "-20002", paths);
    bindSessionConversation(
      "10001",
      "-20002",
      session.generation,
      "shared-v6-provenance",
      paths,
    );
    const queued = queueResponseDelivery(responseDelivery(601), BOT_TOKEN, paths);
    const legacy = JSON.parse(await readFile(paths.path, "utf8"));
    legacy.version = 6;
    delete legacy.terminal_turns;
    await writeFile(paths.path, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const migrated = loadBridgeState(paths.path);
    assert.equal(migrated.version, 7);
    assert.deepEqual(migrated.terminal_turns, []);
    assert.deepEqual(migrated.control_effects, []);
    assert.equal(
      getSession("10001", "-20002", paths).conversation_id,
      "shared-v6-provenance",
    );
    assert.deepEqual(getPendingDelivery(queued.delivery_id, BOT_TOKEN, paths), queued);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("normalized updates are fsynced as sealed records before transport acknowledgement", async () => {
  const paths = await fixture();
  const canary = "SEALED_PROMPT_CANARY_DO_NOT_PERSIST_IN_PLAINTEXT";
  try {
    const result = registerSealedUpdateBatch(
      [sealedRecord(200, canary)],
      BOT_TOKEN,
      paths,
    );
    assert.equal(result.transport_offset, 201);
    assert.equal(loadBridgeState(paths.path).transport_offset, 201);
    const raw = await readFile(paths.path, "utf8");
    assert.equal(raw.includes(canary), false);
    assert.equal(raw.includes(BOT_TOKEN), false);
    assert.equal(loadSealedUpdates(BOT_TOKEN, paths)[0].value.text, canary);

    assert.equal(acknowledgeUpdate(200, paths), 201);
    const acknowledged = loadBridgeState(paths.path);
    assert.deepEqual(acknowledged.sealed_updates, []);
    assert.deepEqual(acknowledged.update_ledger, []);
    assert.equal((await readFile(paths.path, "utf8")).includes("ciphertext"), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("sealed spool rejects a wrong bot token and authenticated-record tampering", async () => {
  const paths = await fixture();
  try {
    registerSealedUpdateBatch([sealedRecord(300, "tamper canary")], BOT_TOKEN, paths);
    assert.throws(
      () => loadSealedUpdates(WRONG_BOT_TOKEN, paths),
      (error) => error?.code === "ETELEGRAMSPOOL",
    );

    const document = JSON.parse(await readFile(paths.path, "utf8"));
    const ciphertext = document.sealed_updates[0].ciphertext;
    document.sealed_updates[0].ciphertext = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
    await writeFile(paths.path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    assert.throws(
      () => loadSealedUpdates(BOT_TOKEN, paths),
      (error) => error?.code === "ETELEGRAMSPOOL",
    );
    assert.equal(loadBridgeState(paths.path).transport_offset, 301);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("sealed spool enforces independent entry and ciphertext byte bounds", async () => {
  const entryPaths = await fixture();
  try {
    registerSealedUpdateBatch(
      Array.from({ length: 100 }, (_, index) => sealedRecord(400 + index)),
      BOT_TOKEN,
      entryPaths,
    );
    assert.throws(
      () => registerSealedUpdateBatch(
        Array.from(
          { length: MAX_SEALED_UPDATE_ENTRIES - 99 },
          (_, index) => sealedRecord(500 + index),
        ),
        BOT_TOKEN,
        entryPaths,
      ),
      /ledger is full|spool is full/u,
    );
  } finally {
    await rm(entryPaths.root, { recursive: true, force: true });
  }

  const bytePaths = await fixture();
  try {
    const fullPrompt = "X".repeat(16 * 1024);
    registerSealedUpdateBatch(
      Array.from({ length: 100 }, (_, index) => sealedRecord(1_000 + index, fullPrompt)),
      BOT_TOKEN,
      bytePaths,
    );
    assert.throws(
      () => registerSealedUpdateBatch(
        Array.from({ length: 28 }, (_, index) => sealedRecord(1_100 + index, fullPrompt)),
        BOT_TOKEN,
        bytePaths,
      ),
      /byte limit/u,
    );
  } finally {
    await rm(bytePaths.root, { recursive: true, force: true });
  }
});
