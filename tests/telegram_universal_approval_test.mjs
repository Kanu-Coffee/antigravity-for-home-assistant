import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AntigravityWorkerError,
  dispatchNormalizedUpdate,
  dispatchUpdateBatch,
  handleMessage,
  handleToolCallback,
  normalizeUpdate,
  processPrompt as productionProcessPrompt,
  renderToolApprovalCard,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs";
import {
  TelegramActionCoordinator,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-action-coordinator.mjs";
import {
  normalizeActionProposal,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-action-proposal-mcp.mjs";
import {
  commitToolApproval,
  decideToolApproval,
  getToolApproval,
  listToolApprovals,
  loadBridgeState,
  registerSealedUpdateBatch,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-state.mjs";

const BOT_TOKEN = `123456:${"A".repeat(35)}`;
const config = {
  enabled: true,
  botToken: BOT_TOKEN,
  toolPermission: "request-review",
  allowedUsers: new Set(["100"]),
  allowedChats: new Set(["-200"]),
};

function processPrompt(promptConfig, message, ticket, options = {}) {
  return productionProcessPrompt(promptConfig, message, ticket, {
    permissionBoundaryLoad: (expectedToolPermission) => ({
      toolPermission: expectedToolPermission,
    }),
    ...options,
  });
}

function actionWorker(coordinator, proposalArguments, conversationId) {
  return async (_prompt, options) => {
    const initialBinding = options.telegramAction;
    options.onConversation(conversationId);
    const registered = coordinator.register(
      normalizeActionProposal(proposalArguments, initialBinding),
    );
    return {
      response: "Telegram 승인을 기다립니다.",
      proposalIds: [registered.proposal_id],
      proposalKind: "telegram_action",
      proposalReceipts: [{
        proposalId: registered.proposal_id,
        proposalKind: "telegram_action",
        requestDigest: registered.request_digest,
        stepIndex: 3,
      }],
      conversationId,
    };
  };
}

test("terminal proposal becomes a durable card and resumes the same conversation after approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-universal-approval-"));
  const statePath = join(root, "telegram", "bridge-state.json");
  const coordinator = new TelegramActionCoordinator({
    socketPath: join(root, "proposal.sock"),
  });
  const calls = [];
  const api = async (_token, method, body) => {
    calls.push({ method, body });
    return true;
  };
  try {
    await processPrompt(config, {
      updateId: 41,
      from: { id: "100" },
      chat: { id: "-200" },
      text: "디스크 사용량을 확인해줘",
    }, null, {
      statePath,
      actionCoordinator: coordinator,
      runPrompt: actionWorker(coordinator, {
        operation: "terminal_command",
        summary: "디스크 사용량 확인",
        payload: { command: "df -h /config", cwd: "/config", timeout_ms: 10_000 },
      }, "conversation.universal-1"),
      api,
    });

    const [approval] = listToolApprovals(BOT_TOKEN, { path: statePath });
    assert.equal(approval.status, "pending");
    assert.equal(approval.conversation_id, "conversation.universal-1");
    assert.equal(JSON.stringify(approval).includes("df -h /config"), true);
    const card = calls.find((call) => call.method === "sendMessage" &&
      call.body.reply_markup !== undefined);
    assert.ok(card);
    assert.match(card.body.text, /df -h \/config/u);
    assert.equal(card.body.reply_markup.inline_keyboard[0].length, 2);

    const sequence = [];
    let continuation = null;
    await handleToolCallback(config, {
      updateId: 42,
      id: "callback-terminal-1",
      from: { id: "100" },
      message: { chat: { id: "-200", type: "private" } },
      data: `v4a:${approval.approval_id}`,
    }, {
      statePath,
      api: async (_token, method) => {
        sequence.push(method);
        return true;
      },
      executor: async (committed) => {
        sequence.push("executor");
        assert.equal(committed.status, "committed");
        return {
          status: "completed",
          exit_code: 0,
          stdout: "Filesystem fixture",
          stderr: "",
          timed_out: false,
          duration_ms: 7,
        };
      },
      promptProcessor: async (_cfg, message, _ticket, options) => {
        sequence.push("continuation");
        continuation = message.text;
        options.acknowledgeInput();
      },
    });
    assert.equal(sequence[0], "answerCallbackQuery", "callback must be acknowledged first");
    assert.deepEqual(sequence.slice(1), ["executor", "continuation"]);
    assert.match(continuation, /conversation/u);
    assert.match(continuation, /Filesystem fixture/u);
    assert.deepEqual(listToolApprovals(BOT_TOKEN, { path: statePath }), []);
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an expired Telegram callback answer cannot block exact-once execution, continuation, or update ACK", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-universal-callback-answer-"));
  const statePath = join(root, "telegram", "bridge-state.json");
  const coordinator = new TelegramActionCoordinator({
    socketPath: join(root, "proposal.sock"),
  });
  try {
    await processPrompt(config, {
      updateId: 43,
      from: { id: "100" },
      chat: { id: "-200" },
      text: "가동 시간을 확인해줘",
    }, null, {
      statePath,
      actionCoordinator: coordinator,
      runPrompt: actionWorker(coordinator, {
        operation: "terminal_command",
        summary: "가동 시간 확인",
        payload: { command: "uptime", cwd: "/config", timeout_ms: 10_000 },
      }, "conversation.callback-answer"),
      api: async () => true,
    });
    const [approval] = listToolApprovals(BOT_TOKEN, { path: statePath });
    const rawUpdate = {
      update_id: 44,
      callback_query: {
        id: "callback-answer-expired",
        from: { id: 100 },
        message: {
          message_id: 440,
          chat: { id: -200, type: "private" },
        },
        data: `v4a:${approval.approval_id}`,
      },
    };
    const normalized = normalizeUpdate(rawUpdate);
    registerSealedUpdateBatch(
      [{ update_id: rawUpdate.update_id, normalized }],
      BOT_TOKEN,
      { path: statePath },
    );

    let executorCalls = 0;
    let continuationCalls = 0;
    let continuationConversation = null;
    let callbackAnswerCalls = 0;
    const callbackExpired = Object.assign(new Error("query is too old"), { status: 400 });
    const callbackHandler = (runtimeConfig, callback, options) => handleToolCallback(
      runtimeConfig,
      callback,
      {
        ...options,
        executor: async (committed) => {
          executorCalls += 1;
          assert.equal(committed.status, "committed");
          return {
            status: "completed",
            exit_code: 0,
            stdout: "up 10 minutes",
            stderr: "",
            timed_out: false,
            duration_ms: 5,
          };
        },
        promptProcessor: async (_cfg, message, _ticket, continuationOptions) => {
          continuationCalls += 1;
          continuationConversation = getToolApproval(
            approval.approval_id,
            BOT_TOKEN,
            { path: statePath },
          )?.conversation_id ?? null;
          assert.match(message.text, /up 10 minutes/u);
          continuationOptions.acknowledgeInput();
        },
      },
    );
    const failingCallbackApi = async (_token, method) => {
      assert.equal(method, "answerCallbackQuery");
      callbackAnswerCalls += 1;
      throw callbackExpired;
    };

    await dispatchNormalizedUpdate(config, normalized, {
      statePath,
      api: failingCallbackApi,
      callbackHandler,
    });

    assert.equal(callbackAnswerCalls, 1);
    assert.equal(executorCalls, 1);
    assert.equal(continuationCalls, 1);
    assert.equal(continuationConversation, "conversation.callback-answer");
    assert.equal(getToolApproval(approval.approval_id, BOT_TOKEN, { path: statePath }), null);
    const acknowledged = loadBridgeState(statePath);
    assert.equal(acknowledged.update_offset, 45);
    assert.deepEqual(acknowledged.update_ledger, []);
    assert.deepEqual(acknowledged.sealed_updates, []);

    // A duplicate callback cannot reconstruct the consumed approval or execute
    // its exact action a second time, even when Telegram rejects the UX answer.
    await dispatchNormalizedUpdate(config, normalized, {
      statePath,
      api: failingCallbackApi,
      callbackHandler,
    });
    assert.equal(callbackAnswerCalls, 2);
    assert.equal(executorCalls, 1);
    assert.equal(continuationCalls, 1);
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("expired and unauthorized callback answers cannot poison the sealed update spool", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-callback-answer-spool-"));
  const statePath = join(root, "telegram", "bridge-state.json");
  let callbackAnswerCalls = 0;
  const callbackExpired = Object.assign(new Error("query is too old"), { status: 400 });
  const callbackUpdate = (updateId, userId, chatId, suffix) => ({
    update_id: updateId,
    callback_query: {
      id: `callback-${suffix}`,
      from: { id: userId },
      message: {
        message_id: updateId * 10,
        chat: { id: chatId, type: "private" },
      },
      data: "v4a:missingApprovalId123456",
    },
  });
  try {
    const nextOffset = await dispatchUpdateBatch(config, [
      callbackUpdate(60, 100, -200, "expired"),
      callbackUpdate(61, 999, -999, "unauthorized"),
    ], {
      statePath,
      api: async (_token, method) => {
        assert.equal(method, "answerCallbackQuery");
        callbackAnswerCalls += 1;
        throw callbackExpired;
      },
    });
    assert.equal(nextOffset, 62);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (loadBridgeState(statePath).update_offset === 62) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const state = loadBridgeState(statePath);
    assert.equal(callbackAnswerCalls, 2);
    assert.equal(state.update_offset, 62);
    assert.deepEqual(state.update_ledger, []);
    assert.deepEqual(state.sealed_updates, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a native headless denial is replanned once into a Telegram proposal in the same conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-universal-replan-"));
  const statePath = join(root, "telegram", "bridge-state.json");
  const coordinator = new TelegramActionCoordinator({
    socketPath: join(root, "proposal.sock"),
  });
  const prompts = [];
  const conversationId = "conversation.universal-replan";
  try {
    await processPrompt(config, {
      updateId: 45,
      from: { id: "100" },
      chat: { id: "-200" },
      text: "uptime을 실행해줘",
    }, null, {
      statePath,
      actionCoordinator: coordinator,
      runPrompt: async (prompt, options) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          options.onConversation(conversationId);
          throw new AntigravityWorkerError("headless_permission_denied");
        }
        assert.equal(options.conversationId, conversationId);
        const registered = coordinator.register(normalizeActionProposal({
          operation: "terminal_command",
          summary: "가동 시간 확인",
          payload: { command: "uptime", cwd: "/config", timeout_ms: 10_000 },
        }, options.telegramAction));
        return {
          response: "Telegram 승인을 기다립니다.",
          proposalIds: [registered.proposal_id],
          proposalKind: "telegram_action",
          proposalReceipts: [{
            proposalId: registered.proposal_id,
            proposalKind: "telegram_action",
            requestDigest: registered.request_digest,
            stepIndex: 4,
          }],
          conversationId,
        };
      },
      api: async () => true,
    });
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Telegram mediation correction/u);
    assert.match(prompts[1], /not authorization/u);
    const [approval] = listToolApprovals(BOT_TOKEN, { path: statePath });
    assert.equal(approval.status, "pending");
    assert.equal(approval.conversation_id, conversationId);
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("/cancel removes a pending Telegram action without executing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-universal-cancel-"));
  const statePath = join(root, "telegram", "bridge-state.json");
  const coordinator = new TelegramActionCoordinator({
    socketPath: join(root, "proposal.sock"),
  });
  const sent = [];
  try {
    await processPrompt(config, {
      updateId: 46,
      from: { id: "100" },
      chat: { id: "-200" },
      text: "진단 스크립트를 준비해줘",
    }, null, {
      statePath,
      actionCoordinator: coordinator,
      runPrompt: actionWorker(coordinator, {
        operation: "terminal_command",
        summary: "진단 스크립트",
        payload: { script: "printf 'ok\\n'", cwd: "/config", timeout_ms: 10_000 },
      }, "conversation.universal-cancel"),
      api: async () => true,
    });
    assert.equal(listToolApprovals(BOT_TOKEN, { path: statePath }).length, 1);
    await handleMessage(config, {
      updateId: 47,
      from: { id: "100" },
      chat: { id: "-200", type: "private" },
      text: "/cancel",
    }, {
      statePath,
      send: async (_token, _chatId, text) => sent.push(text),
      api: async () => true,
    });
    assert.deepEqual(listToolApprovals(BOT_TOKEN, { path: statePath }), []);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /승인 대기 제안 1개/u);
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("multi-choice callback executes only the opaque selected terminal action", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-universal-choice-"));
  const statePath = join(root, "telegram", "bridge-state.json");
  const coordinator = new TelegramActionCoordinator({
    socketPath: join(root, "proposal.sock"),
  });
  let continuation = "";
  try {
    await processPrompt(config, {
      updateId: 48,
      from: { id: "100" },
      chat: { id: "-200" },
      text: "진단 대상을 선택하게 해줘",
    }, null, {
      statePath,
      actionCoordinator: coordinator,
      runPrompt: actionWorker(coordinator, {
        operation: "multi_choice_terminal",
        summary: "진단 대상 선택",
        payload: {
          prompt: "대상을 선택하세요",
          choices: [
            {
              choice_id: "config",
              label: "/config",
              command: "printf 'CONFIG\\n'",
              cwd: "/config",
            },
            {
              choice_id: "home",
              label: "Antigravity HOME",
              command: "printf 'HOME\\n'",
              cwd: "/config",
            },
          ],
          cancel_label: "선택 취소",
        },
      }, "conversation.universal-choice"),
      api: async () => true,
    });
    const [approval] = listToolApprovals(BOT_TOKEN, { path: statePath });
    const card = renderToolApprovalCard(approval);
    assert.equal(card.replyMarkup.inline_keyboard.at(-1).at(-1).text, "선택 취소");
    const selected = approval.choice_tokens.find((choice) => choice.choice_id === "home");
    assert.ok(selected);
    await handleToolCallback(config, {
      updateId: 49,
      id: "callback-choice-1",
      from: { id: "100" },
      message: { chat: { id: "-200", type: "private" } },
      data: `v4c:${approval.approval_id}:${selected.token}`,
    }, {
      statePath,
      api: async () => true,
      executor: async (committed) => {
        assert.equal(committed.selected_choice_id, "home");
        const action = JSON.parse(committed.action_json);
        assert.equal(
          action.choices.find((choice) => choice.choice_id === "home").action.shell_source,
          "printf 'HOME\\n'",
        );
        return {
          status: "completed",
          exit_code: 0,
          stdout: "HOME",
          stderr: "",
          timed_out: false,
          duration_ms: 3,
        };
      },
      promptProcessor: async (_cfg, message, _ticket, options) => {
        continuation = message.text;
        options.acknowledgeInput();
      },
    });
    assert.match(continuation, /"selected_choice_id": "home"/u);
    assert.match(continuation, /"stdout": "HOME"/u);
    assert.deepEqual(listToolApprovals(BOT_TOKEN, { path: statePath }), []);
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("question choice returns to Antigravity without starting the executor", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-universal-question-"));
  const statePath = join(root, "telegram", "bridge-state.json");
  const coordinator = new TelegramActionCoordinator({
    socketPath: join(root, "proposal.sock"),
  });
  let executorCalls = 0;
  let continuation = "";
  try {
    await processPrompt(config, {
      updateId: 50,
      from: { id: "100" },
      chat: { id: "-200" },
      text: "진단 수준을 물어봐",
    }, null, {
      statePath,
      actionCoordinator: coordinator,
      runPrompt: actionWorker(coordinator, {
        operation: "question",
        summary: "진단 수준",
        payload: {
          prompt: "어느 수준으로 진단할까요?",
          choices: [
            { choice_id: "quick", label: "빠른 진단" },
            { choice_id: "full", label: "전체 진단" },
          ],
        },
      }, "conversation.universal-question"),
      api: async () => true,
    });
    const [approval] = listToolApprovals(BOT_TOKEN, { path: statePath });
    const selected = approval.choice_tokens.find((choice) => choice.choice_id === "full");
    await handleToolCallback(config, {
      updateId: 51,
      id: "callback-question-1",
      from: { id: "100" },
      message: { chat: { id: "-200", type: "private" } },
      data: `v4c:${approval.approval_id}:${selected.token}`,
    }, {
      statePath,
      api: async () => true,
      executor: async () => { executorCalls += 1; throw new Error("must not execute"); },
      promptProcessor: async (_cfg, message, _ticket, options) => {
        continuation = message.text;
        options.acknowledgeInput();
      },
    });
    assert.equal(executorCalls, 0);
    assert.match(continuation, /"status": "answered"/u);
    assert.match(continuation, /"choice_id": "full"/u);
    assert.match(continuation, /"label": "전체 진단"/u);
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a committed callback replay becomes in_doubt and never respawns the executor", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-universal-recovery-"));
  const statePath = join(root, "telegram", "bridge-state.json");
  const coordinator = new TelegramActionCoordinator({
    socketPath: join(root, "proposal.sock"),
  });
  try {
    await processPrompt(config, {
      updateId: 51,
      from: { id: "100" },
      chat: { id: "-200" },
      text: "uptime",
    }, null, {
      statePath,
      actionCoordinator: coordinator,
      runPrompt: actionWorker(coordinator, {
        operation: "terminal_command",
        summary: "가동 시간 확인",
        payload: { command: "uptime", cwd: "/config", timeout_ms: 10_000 },
      }, "conversation.universal-2"),
      api: async () => true,
    });
    let [approval] = listToolApprovals(BOT_TOKEN, { path: statePath });
    approval = decideToolApproval(
      approval.approval_id,
      52,
      "approve",
      BOT_TOKEN,
      { path: statePath },
    );
    commitToolApproval(
      approval.approval_id,
      approval.commit_token,
      BOT_TOKEN,
      { path: statePath },
    );
    let executorCalls = 0;
    let continuation = "";
    await handleToolCallback(config, {
      updateId: 52,
      id: "callback-recovery-1",
      from: { id: "100" },
      message: { chat: { id: "-200", type: "private" } },
      data: `v4a:${approval.approval_id}`,
    }, {
      statePath,
      api: async () => true,
      executor: async () => { executorCalls += 1; throw new Error("must not spawn"); },
      promptProcessor: async (_cfg, message, _ticket, options) => {
        continuation = message.text;
        options.acknowledgeInput();
      },
    });
    assert.equal(executorCalls, 0);
    assert.match(continuation, /in_doubt/u);
    assert.equal(getToolApproval(approval.approval_id, BOT_TOKEN, { path: statePath }), null);
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("31 choices plus cancel fit the Telegram 8x4 grid", () => {
  const approval = {
    approval_id: "approvalFixture1234567890",
    preview: "선택",
    choice_tokens: Array.from({ length: 31 }, (_, index) => ({
      token: `token${String(index).padStart(3, "0")}`,
      choice_id: `choice_${index}`,
      label: `선택 ${index + 1}`,
    })),
  };
  const card = renderToolApprovalCard(approval);
  assert.equal(card.replyMarkup.inline_keyboard.length, 8);
  assert.equal(card.replyMarkup.inline_keyboard.every((row) => row.length === 4), true);
});
