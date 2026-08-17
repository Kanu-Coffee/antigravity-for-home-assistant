import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  MAX_ACTION_CHOICES,
  MAX_MCP_LINE_BYTES,
  MAX_REGISTER_MESSAGE_BYTES,
  TELEGRAM_ACTION_PROPOSAL_ID_PATTERN,
  bindRegisteredActionProposalToConversation,
  boundedNdjsonLines,
  createTelegramActionMcpHandler,
  executionDigestFor,
  normalizeActionProposal,
  renderTelegramActionPreview,
  sendActionRegisterRequest,
  stableJson,
  telegramBindingFromEnvironment,
  validateRegisteredActionProposal,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-action-proposal-mcp.mjs";
import {
  DEFAULT_ACTION_SHELL,
  MAX_EXECUTOR_STDOUT_BYTES,
  assertNoDetachedShellConstructs,
  executeTelegramActionRequest,
  normalizeTelegramActionExecutionRequest,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-action-executor.mjs";

const NULL_BINDING = Object.freeze({
  surface: "telegram",
  user_id: "123456789",
  chat_id: "-100123456789",
  session_generation: 2,
  update_id: 9001,
  run_nonce: "A".repeat(24),
  conversation_id: null,
});
const LIVE_BINDING = Object.freeze({
  ...NULL_BINDING,
  conversation_id: "conversation-fixture-1",
});
const PROPOSAL_ID = `ta_${"B".repeat(20)}`;

function terminalArguments(overrides = {}) {
  return {
    operation: "terminal_command",
    summary: "승인된 진단 실행",
    ttl_seconds: 120,
    payload: {
      command: "printf '%s' 'safe'",
      cwd: "/config",
      timeout_ms: 2_000,
    },
    ...overrides,
  };
}

function executionRequest(proposal) {
  return {
    schema_version: 1,
    proposal_id: PROPOSAL_ID,
    operation: proposal.operation,
    selection_id: null,
    action: proposal.payload.action,
    execution_digest: proposal.payload.execution_digest,
  };
}

function hostSpawn(file, args, options) {
  return spawn(file, args, { ...options, cwd: process.cwd() });
}

async function withSocketServer(handler, callback) {
  const directory = await mkdtemp(join(tmpdir(), "telegram-action-test-"));
  const socketPath = join(directory, "proposal.sock");
  const server = net.createServer(handler);
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    return await callback(socketPath);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test("terminal proposal binds the complete uninterpreted shell source", () => {
  const source = "printf '%s' '$HOME; $(id); `id`; && |'";
  const proposal = normalizeActionProposal(terminalArguments({
    payload: { command: source, cwd: "/config", timeout_ms: 4_000 },
  }), NULL_BINDING);
  assert.equal(proposal.payload.action.shell_source, source);
  assert.match(proposal.payload.action.source_sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.match(proposal.payload.execution_digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(validateRegisteredActionProposal(proposal).request_digest, proposal.request_digest);
  assert.match(renderTelegramActionPreview(proposal), /원문 SHA-256/u);
  assert.ok(Buffer.byteLength(stableJson(proposal)) <= MAX_REGISTER_MESSAGE_BYTES);
});

test("approval preview contains the complete executable source with no hidden suffix", () => {
  const visiblePrefix = "printf x;".repeat(180);
  const source = `${visiblePrefix} printf 'VISIBLE_FINAL_SUFFIX\\n'`;
  const proposal = normalizeActionProposal(terminalArguments({
    payload: { command: source, cwd: "/config", timeout_ms: 4_000 },
  }), NULL_BINDING);
  assert.equal(proposal.preview.action.source_preview, source);
  const card = renderTelegramActionPreview(proposal);
  assert.match(card, /VISIBLE_FINAL_SUFFIX/u);
  assert.equal(card.includes("…"), false);
});

test("first-turn proposal is rebound to the live conversation and every digest changes", () => {
  const provisional = normalizeActionProposal(terminalArguments(), NULL_BINDING);
  const bound = bindRegisteredActionProposalToConversation(
    provisional,
    LIVE_BINDING.conversation_id,
  );
  assert.equal(bound.binding.conversation_id, LIVE_BINDING.conversation_id);
  assert.notEqual(bound.request_digest, provisional.request_digest);
  assert.notEqual(bound.payload.execution_digest, provisional.payload.execution_digest);
  assert.equal(
    bound.payload.execution_digest,
    executionDigestFor(LIVE_BINDING, "terminal_command", null, bound.payload.action),
  );
  assert.deepEqual(
    bindRegisteredActionProposalToConversation(bound, LIVE_BINDING.conversation_id),
    bound,
  );
  assert.throws(
    () => bindRegisteredActionProposalToConversation(bound, "other-conversation"),
    /live Telegram run/u,
  );
});

test("strict proposal validation rejects sensitive data, unsafe cwd, and extra fields", () => {
  for (const command of [
    "cat secrets.yaml",
    "cat .storage/auth",
    "cat /config/./secrets.yaml",
    "/usr/bin/env",
    "printf 'Authorization: synthetic-credential-canary'",
  ]) {
    assert.throws(
      () => normalizeActionProposal(terminalArguments({
        payload: { command, cwd: "/config" },
      }), NULL_BINDING),
    );
  }
  for (const cwd of ["config", "/tmp", "/config/../data", "/config//nested"]) {
    assert.throws(
      () => normalizeActionProposal(terminalArguments({
        payload: { command: "true", cwd },
      }), NULL_BINDING),
    );
  }
  assert.throws(() => normalizeActionProposal({
    ...terminalArguments(),
    payload: { ...terminalArguments().payload, environment: { access_token: "synthetic" } },
  }, NULL_BINDING));
  assert.throws(() => normalizeActionProposal({
    ...terminalArguments(),
    unsupported: true,
  }, NULL_BINDING));
});

test("multi-choice and question proposals enforce 1..31 unique choices and 24-byte ids", () => {
  const choices = Array.from({ length: MAX_ACTION_CHOICES }, (_, index) => ({
    choice_id: `choice_${index + 1}`,
    label: `선택 ${index + 1}`,
    command: `printf '%s' '${index + 1}'`,
    cwd: "/config",
  }));
  const proposal = normalizeActionProposal({
    operation: "multi_choice_terminal",
    summary: "진단 대상 선택",
    payload: { prompt: "대상을 고르세요", choices },
  }, NULL_BINDING);
  assert.equal(proposal.payload.choices.length, MAX_ACTION_CHOICES);
  const card = renderTelegramActionPreview(proposal);
  assert.match(card, /제한 시간: 30000ms/u);
  assert.equal((card.match(/제한 시간:/gu) ?? []).length, MAX_ACTION_CHOICES);
  assert.throws(() => normalizeActionProposal({
    operation: "multi_choice_terminal",
    summary: "없음",
    payload: { prompt: "고르세요", choices: [] },
  }, NULL_BINDING));
  assert.throws(() => normalizeActionProposal({
    operation: "multi_choice_terminal",
    summary: "너무 많음",
    payload: { prompt: "고르세요", choices: [...choices, choices[0]] },
  }, NULL_BINDING));
  assert.throws(() => normalizeActionProposal({
    operation: "multi_choice_terminal",
    summary: "중복",
    payload: { prompt: "고르세요", choices: [choices[0], { ...choices[1], choice_id: "choice_1" }] },
  }, NULL_BINDING));
  assert.throws(() => normalizeActionProposal({
    operation: "question",
    summary: "긴 ID",
    payload: {
      prompt: "고르세요",
      choices: [{ choice_id: "x".repeat(25), label: "아니오" }],
    },
  }, NULL_BINDING));
  const question = normalizeActionProposal({
    operation: "question",
    summary: "계속할까요",
    payload: {
      prompt: "방식을 고르세요",
      choices: [{ choice_id: "yes", label: "계속" }],
    },
  }, NULL_BINDING);
  assert.equal(question.payload.choices[0].action.kind, "question_selection");
});

test("cumulative multi-choice payload is capped below durable state limits", () => {
  const choices = Array.from({ length: MAX_ACTION_CHOICES }, (_, index) => ({
    choice_id: `large_${index}`,
    label: `큰 선택 ${index}`,
    script: `# ${index}\n${"x".repeat(700)}`,
    cwd: "/config",
  }));
  assert.throws(() => normalizeActionProposal({
    operation: "multi_choice_terminal",
    summary: "너무 큰 요청",
    payload: { prompt: "고르세요", choices },
  }, NULL_BINDING), /size limit/u);
});

test("register socket receives one canonical request and returns the live-bound digest", async () => {
  const provisional = normalizeActionProposal(terminalArguments(), NULL_BINDING);
  let received;
  await withSocketServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      received = JSON.parse(input.slice(0, input.indexOf("\n")));
      const bound = bindRegisteredActionProposalToConversation(
        received.payload,
        LIVE_BINDING.conversation_id,
      );
      socket.end(`${JSON.stringify({
        id: received.id,
        ok: true,
        result: {
          proposal_id: PROPOSAL_ID,
          request_digest: bound.request_digest,
          preview: bound.preview,
        },
      })}\n`);
    });
  }, async (socketPath) => {
    const result = await sendActionRegisterRequest(provisional, { socketPath });
    assert.match(result.proposal_id, TELEGRAM_ACTION_PROPOSAL_ID_PATTERN);
    assert.notEqual(result.request_digest, provisional.request_digest);
    assert.deepEqual(result.preview, provisional.preview);
  });
  assert.deepEqual(Object.keys(received).sort(), ["action", "id", "payload"]);
  assert.equal(received.action, "register");
  assert.deepEqual(validateRegisteredActionProposal(received.payload), provisional);
});

test("register socket rejects altered live digest and premature close", async () => {
  const live = normalizeActionProposal(terminalArguments(), LIVE_BINDING);
  await withSocketServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n")));
      socket.end(`${JSON.stringify({
        id: request.id,
        ok: true,
        result: {
          proposal_id: PROPOSAL_ID,
          request_digest: `sha256:${"0".repeat(64)}`,
          preview: live.preview,
        },
      })}\n`);
    });
  }, async (socketPath) => {
    await assert.rejects(
      sendActionRegisterRequest(live, { socketPath }),
      (error) => error.code === "invalid_response",
    );
  });
  await withSocketServer((socket) => socket.end(), async (socketPath) => {
    await assert.rejects(
      sendActionRegisterRequest(live, { socketPath, timeoutMs: 500 }),
      (error) => error.code === "invalid_response",
    );
  });
});

test("register socket uses an absolute deadline and rejects trailing response data", async () => {
  const live = normalizeActionProposal(terminalArguments(), LIVE_BINDING);
  await withSocketServer((socket) => {
    socket.on("data", () => socket.write("{"));
  }, async (socketPath) => {
    const started = Date.now();
    await assert.rejects(
      sendActionRegisterRequest(live, { socketPath, timeoutMs: 50 }),
      (error) => error.code === "proposal_timeout",
    );
    assert.ok(Date.now() - started < 1_000);
  });
  await withSocketServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n")));
      socket.end(`${JSON.stringify({
        id: request.id,
        ok: true,
        result: {
          proposal_id: PROPOSAL_ID,
          request_digest: live.request_digest,
          preview: live.preview,
        },
      })}\njunk\n`);
    });
  }, async (socketPath) => {
    await assert.rejects(
      sendActionRegisterRequest(live, { socketPath }),
      (error) => error.code === "invalid_response",
    );
  });
});

test("MCP result exposes only proposal id, final digest, and bounded preview", async () => {
  const handler = createTelegramActionMcpHandler({
    binding: NULL_BINDING,
    register: async (provisional) => {
      const bound = bindRegisteredActionProposalToConversation(
        provisional,
        LIVE_BINDING.conversation_id,
      );
      return {
        proposal_id: PROPOSAL_ID,
        request_digest: bound.request_digest,
        preview: bound.preview,
      };
    },
  });
  const response = await handler({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "telegram_action_propose",
      arguments: terminalArguments({
        payload: { command: `printf '%s' '${"z".repeat(2_000)}'`, cwd: "/config" },
      }),
    },
  });
  assert.equal(response.result.isError, false);
  assert.deepEqual(Object.keys(response.result.structuredContent).sort(), [
    "preview",
    "proposal_id",
    "request_digest",
  ]);
  assert.doesNotMatch(JSON.stringify(response.result), /shell_source/u);
  assert.ok(Buffer.byteLength(JSON.stringify(response.result)) < MAX_REGISTER_MESSAGE_BYTES);
});

test("bounded NDJSON framing rejects a newline-free oversized request", async () => {
  const frames = [];
  for await (const frame of boundedNdjsonLines(
    Readable.from([Buffer.alloc(MAX_MCP_LINE_BYTES + 1, 0x78)]),
  )) frames.push(frame);
  assert.deepEqual(frames, [{ oversized: true, line: null }]);
  assert.throws(() => telegramBindingFromEnvironment({
    ANTIGRAVITY_HA_CHANNEL: "telegram",
    HA_TELEGRAM_USER_ID: "123",
    HA_TELEGRAM_CHAT_ID: "123",
    HA_TELEGRAM_SESSION_GENERATION: "01",
    HA_TELEGRAM_UPDATE_ID: "1e3",
    HA_TELEGRAM_RUN_NONCE: "A".repeat(24),
    HA_ANTIGRAVITY_CONVERSATION_ID: "conversation",
  }));
});

test("executor validates the exact selected action digest before spawn", async () => {
  const proposal = normalizeActionProposal(terminalArguments(), LIVE_BINDING);
  const request = executionRequest(proposal);
  let spawnCalls = 0;
  await assert.rejects(
    executeTelegramActionRequest({
      ...request,
      action: { ...request.action, shell_source: "printf tampered" },
    }, LIVE_BINDING, {
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error("must not spawn");
      },
      realpathImpl: async (cwd) => cwd,
    }),
  );
  assert.equal(spawnCalls, 0);
  assert.throws(
    () => normalizeTelegramActionExecutionRequest({
      ...request,
      operation: "question",
    }, LIVE_BINDING),
  );
});

test("executor passes source as one bash argument in a credential-free environment", async () => {
  const literal = "$HOME; $(id); `id`; && |";
  const source = `printf '%s|%s' '${literal}' "\${UNTRUSTED_PARENT_VALUE-unset}"`;
  const proposal = normalizeActionProposal(terminalArguments({
    payload: { command: source, cwd: "/config", timeout_ms: 2_000 },
  }), LIVE_BINDING);
  let captured;
  const result = await executeTelegramActionRequest(executionRequest(proposal), LIVE_BINDING, {
    shellPath: "/bin/bash",
    realpathImpl: async (cwd) => cwd,
    spawnImpl: (file, args, options) => {
      captured = { file, args, options };
      return hostSpawn(file, args, options);
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.stdout, `${literal}|unset`);
  assert.equal(captured.file, "/bin/bash");
  assert.deepEqual(captured.args, ["-c", source, "--"]);
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.detached, true);
  assert.deepEqual(Object.keys(captured.options.env).sort(), [
    "GIT_PAGER", "HOME", "LANG", "LC_ALL", "PAGER", "PATH", "SYSTEMD_PAGER", "TERM",
  ]);
});

test("executor rejects symlink cwd and detached or daemon constructs before spawn", async () => {
  for (const source of [
    "sleep 2 &",
    "nohup sleep 2",
    "python3 -c 'import os; os.setsid()'",
    "jobs",
  ]) assert.throws(() => assertNoDetachedShellConstructs(source));
  assert.doesNotThrow(() => assertNoDetachedShellConstructs("true && printf x 2>&1"));

  const proposal = normalizeActionProposal(terminalArguments(), LIVE_BINDING);
  let spawnCalls = 0;
  await assert.rejects(
    executeTelegramActionRequest(executionRequest(proposal), LIVE_BINDING, {
      realpathImpl: async () => "/elsewhere/config",
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error("must not spawn");
      },
    }),
    /symbolic link/u,
  );
  assert.equal(spawnCalls, 0);
});

test("executor returns bounded failed results for timeout and output overflow", async () => {
  const timeoutProposal = normalizeActionProposal(terminalArguments({
    payload: { command: "sleep 2", cwd: "/config", timeout_ms: 100 },
  }), LIVE_BINDING);
  const timeoutResult = await executeTelegramActionRequest(
    executionRequest(timeoutProposal),
    LIVE_BINDING,
    { shellPath: "/bin/bash", realpathImpl: async (cwd) => cwd, spawnImpl: hostSpawn },
  );
  assert.deepEqual(Object.keys(timeoutResult).sort(), [
    "duration_ms", "exit_code", "status", "stderr", "stdout", "timed_out",
  ]);
  assert.equal(timeoutResult.status, "failed");
  assert.equal(timeoutResult.timed_out, true);
  assert.match(timeoutResult.stderr, /timed out/u);

  const outputProposal = normalizeActionProposal(terminalArguments({
    payload: { command: "yes x", cwd: "/config", timeout_ms: 2_000 },
  }), LIVE_BINDING);
  const outputResult = await executeTelegramActionRequest(
    executionRequest(outputProposal),
    LIVE_BINDING,
    { shellPath: "/bin/bash", realpathImpl: async (cwd) => cwd, spawnImpl: hostSpawn },
  );
  assert.equal(outputResult.status, "failed");
  assert.equal(outputResult.timed_out, false);
  assert.ok(Buffer.byteLength(outputResult.stdout) <= MAX_EXECUTOR_STDOUT_BYTES);
  assert.match(outputResult.stderr, /output exceeded/u);
});

test("executor cancellation terminates the command group and reports in_doubt", async () => {
  const proposal = normalizeActionProposal(terminalArguments({
    payload: { command: "sleep 2", cwd: "/config", timeout_ms: 2_000 },
  }), LIVE_BINDING);
  const cancellation = new AbortController();
  setTimeout(() => cancellation.abort(), 20);
  const result = await executeTelegramActionRequest(
    executionRequest(proposal),
    LIVE_BINDING,
    {
      shellPath: "/bin/bash",
      realpathImpl: async (cwd) => cwd,
      spawnImpl: hostSpawn,
      signal: cancellation.signal,
    },
  );
  assert.equal(result.status, "in_doubt");
  assert.equal(result.timed_out, false);
  assert.match(result.stderr, /could not be determined/u);
  assert.ok(result.duration_ms < 1_000);
});

test("executor redacts credential-shaped command output", async () => {
  const proposal = normalizeActionProposal(terminalArguments({
    payload: {
      command: "printf '%b' '\\101uthorization: \\102earer abcdefghijklmnop'",
      cwd: "/config",
      timeout_ms: 2_000,
    },
  }), LIVE_BINDING);
  const result = await executeTelegramActionRequest(executionRequest(proposal), LIVE_BINDING, {
    shellPath: "/bin/bash",
    realpathImpl: async (cwd) => cwd,
    spawnImpl: hostSpawn,
  });
  assert.equal(result.status, "completed");
  assert.doesNotMatch(result.stdout, /abcdefghijklmnop/u);
  assert.match(result.stdout, /redacted/u);
});

test("installed wrappers are env-clean and executor uses the protected absolute shell", async () => {
  const root = new URL("../antigravity_home_assistant/rootfs/", import.meta.url);
  const proposalWrapper = await readFile(
    new URL("usr/local/bin/telegram-action-proposal-mcp", root),
    "utf8",
  );
  const executorWrapper = await readFile(
    new URL("usr/local/bin/telegram-action-executor", root),
    "utf8",
  );
  for (const wrapper of [proposalWrapper, executorWrapper]) {
    assert.match(wrapper, /exec \/usr\/bin\/env -i/u);
    assert.match(wrapper, /HA_TELEGRAM_RUN_NONCE/u);
    assert.doesNotMatch(wrapper, /SUPERVISOR_TOKEN=/u);
  }
  assert.equal(DEFAULT_ACTION_SHELL, "/usr/local/libexec/antigravity-command-bin/bash");
});
