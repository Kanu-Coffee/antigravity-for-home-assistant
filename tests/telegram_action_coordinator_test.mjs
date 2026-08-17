import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  TelegramActionCoordinator,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-action-coordinator.mjs";
import {
  normalizeActionProposal,
  sendActionRegisterRequest,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-action-proposal-mcp.mjs";

function runInput(conversationId = null) {
  return {
    user_id: "10001",
    chat_id: "-20002",
    session_generation: 3,
    update_id: 77,
    conversation_id: conversationId,
  };
}

function proposal(binding, source = "df -h /config") {
  return normalizeActionProposal({
    operation: "terminal_command",
    summary: "디스크 사용량 확인",
    payload: {
      command: source,
      cwd: "/config",
      timeout_ms: 10_000,
    },
  }, binding);
}

test("coordinator rebinds a first-turn proposal to the live conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-action-coordinator-"));
  const coordinator = new TelegramActionCoordinator({
    socketPath: join(root, "proposal.sock"),
  });
  try {
    const binding = coordinator.beginRun(runInput());
    coordinator.bindConversation(binding.run_nonce, "conversation-live-1");
    const registered = coordinator.register(proposal(binding));
    assert.match(registered.proposal_id, /^ta_[A-Za-z0-9_-]{20,48}$/u);
    const stored = coordinator.getProposal(registered.proposal_id, {
      run_nonce: binding.run_nonce,
    });
    assert.equal(stored.proposal.binding.conversation_id, "conversation-live-1");
    assert.equal(stored.proposal.request_digest, registered.request_digest);
    assert.notEqual(stored.proposal.request_digest, proposal(binding).request_digest);
    assert.equal(coordinator.finishRun(binding.run_nonce), true);
    assert.equal(coordinator.getProposal(registered.proposal_id), null);
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("coordinator socket rejects a copied requester binding and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-action-coordinator-"));
  const socketPath = join(root, "proposal.sock");
  const coordinator = new TelegramActionCoordinator({ socketPath });
  try {
    const binding = coordinator.beginRun(runInput("conversation-live-2"));
    await coordinator.start();
    const action = proposal(binding, "uptime");
    const first = await sendActionRegisterRequest(action, { socketPath });
    const replay = await sendActionRegisterRequest(action, { socketPath });
    assert.deepEqual(replay, first);

    const copied = proposal({ ...binding, user_id: "10002" }, "uptime");
    await assert.rejects(
      sendActionRegisterRequest(copied, { socketPath }),
      (error) => error?.code === "binding_mismatch",
    );
    assert.equal(
      coordinator.getProposal(first.proposal_id, { run_nonce: binding.run_nonce })
        .proposal.binding.user_id,
      "10001",
    );
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("coordinator rejects registration before init conversation binding", () => {
  const coordinator = new TelegramActionCoordinator({
    socketPath: "/tmp/telegram-action-coordinator-unstarted.sock",
  });
  const binding = coordinator.beginRun(runInput());
  assert.throws(
    () => coordinator.register(proposal(binding)),
    (error) => error?.code === "binding_mismatch",
  );
  coordinator.finishRun(binding.run_nonce);
});

test("coordinator socket waits for the first init conversation binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-action-coordinator-"));
  const socketPath = join(root, "proposal.sock");
  const coordinator = new TelegramActionCoordinator({ socketPath });
  try {
    const binding = coordinator.beginRun(runInput());
    await coordinator.start();
    const registering = sendActionRegisterRequest(proposal(binding), { socketPath });
    await new Promise((resolve) => setTimeout(resolve, 20));
    coordinator.bindConversation(binding.run_nonce, "conversation-race-bound");
    const registered = await registering;
    const stored = coordinator.getProposal(registered.proposal_id, {
      run_nonce: binding.run_nonce,
    });
    assert.equal(stored.proposal.binding.conversation_id, "conversation-race-bound");
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});
