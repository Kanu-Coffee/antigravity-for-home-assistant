import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, lstat, readFile } from "node:fs/promises";
import { constants } from "node:fs";

import {
  TelegramActionCoordinator,
} from "/usr/local/share/antigravity-ha/telegram-action-coordinator.mjs";

const PROPOSAL_WRAPPER = "/usr/local/bin/telegram-action-proposal-mcp";
const EXECUTOR_WRAPPER = "/usr/local/bin/telegram-action-executor";
const PROPOSAL_SOCKET = "/run/antigravity-ha/telegram-action-proposal.sock";
const FIRST_MARKER = "/config/telegram-universal-first.marker";
const SELECTED_MARKER = "/config/telegram-universal-selected.marker";
const OUTPUT_MARKER = "TELEGRAM_UNIVERSAL_ACTION_IMAGE_SMOKE_EXECUTED";
const CONVERSATION_ID = "conversation.image-smoke-1";

function childEnvironment(binding, { conversationId }) {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    ANTIGRAVITY_HA_CHANNEL: "telegram",
    HA_TELEGRAM_USER_ID: binding.user_id,
    HA_TELEGRAM_CHAT_ID: binding.chat_id,
    HA_TELEGRAM_SESSION_GENERATION: String(binding.session_generation),
    HA_TELEGRAM_UPDATE_ID: String(binding.update_id),
    HA_TELEGRAM_RUN_NONCE: binding.run_nonce,
    HA_ANTIGRAVITY_CONVERSATION_ID: conversationId ?? "",
    HA_TELEGRAM_ACTION_PROPOSAL_SOCKET: PROPOSAL_SOCKET,
    SMOKE_PARENT_ENV: "must-not-cross-the-executor-wrapper",
    // The wrappers must discard process-injection variables before Node starts.
    NODE_OPTIONS: "--telegram-universal-smoke-invalid-option",
  };
}

function runChild(command, { environment, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(input);
  });
}

function parseNdjson(value) {
  return value.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function assertInstalledRuntime() {
  for (const path of [
    PROPOSAL_WRAPPER,
    EXECUTOR_WRAPPER,
    "/usr/local/share/antigravity-ha/telegram-action-coordinator.mjs",
    "/usr/local/share/antigravity-ha/telegram-action-proposal-mcp.mjs",
    "/usr/local/share/antigravity-ha/telegram-action-executor.mjs",
  ]) {
    const metadata = await lstat(path);
    assert.equal(metadata.isFile(), true, `${path} is not a regular installed file`);
    assert.equal(metadata.isSymbolicLink(), false, `${path} must not be a symlink`);
  }
  await access(PROPOSAL_WRAPPER, constants.X_OK);
  await access(EXECUTOR_WRAPPER, constants.X_OK);
}

async function main() {
  await assertInstalledRuntime();
  const coordinator = new TelegramActionCoordinator({ socketPath: PROPOSAL_SOCKET });
  try {
    const firstTurnBinding = coordinator.beginRun({
      user_id: "10001",
      chat_id: "-20002",
      session_generation: 3,
      update_id: 77,
      conversation_id: null,
    });
    coordinator.bindConversation(firstTurnBinding.run_nonce, CONVERSATION_ID);
    await coordinator.start();
    const socketMetadata = await lstat(PROPOSAL_SOCKET);
    assert.equal(socketMetadata.isSocket(), true);
    assert.equal(socketMetadata.mode & 0o777, 0o600);

    const unselectedSource =
      `printf '%s\\n' 'UNSELECTED' > ${FIRST_MARKER}`;
    const selectedSource = [
      "test \"$PWD\" = /config",
      "test -z \"${SMOKE_PARENT_ENV+x}\"",
      `printf '%s\\n' '${OUTPUT_MARKER}' > ${SELECTED_MARKER}`,
      `printf '%s\\n' '${OUTPUT_MARKER}'`,
    ].join(" && ");
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "telegram_action_propose",
          arguments: {
            operation: "multi_choice_terminal",
            summary: "Installed-image universal Telegram approval smoke",
            payload: {
              prompt: "Select the synthetic action",
              choices: [
                {
                  choice_id: "first",
                  label: "Do not select",
                  command: unselectedSource,
                  cwd: "/config",
                  timeout_ms: 5_000,
                },
                {
                  choice_id: "selected",
                  label: "Execute selected action",
                  script: selectedSource,
                  cwd: "/config",
                  timeout_ms: 5_000,
                },
              ],
              cancel_label: "Cancel",
            },
          },
        },
      },
    ];
    const proposalProcess = await runChild(PROPOSAL_WRAPPER, {
      environment: childEnvironment(firstTurnBinding, { conversationId: null }),
      input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    });
    assert.equal(proposalProcess.code, 0, proposalProcess.stderr);
    assert.equal(proposalProcess.signal, null);
    assert.equal(proposalProcess.stderr, "");
    const responses = parseNdjson(proposalProcess.stdout);
    assert.equal(responses.length, 2);
    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.serverInfo.name,
      "antigravity-telegram-action-proposal");
    const toolResponse = responses[1];
    assert.equal(toolResponse.id, 2);
    assert.equal(toolResponse.result.isError, false);
    const receipt = toolResponse.result.structuredContent;
    assert.match(receipt.proposal_id, /^ta_[A-Za-z0-9_-]{20,48}$/u);
    assert.match(receipt.request_digest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(receipt.preview.choices[0].action.source_preview, unselectedSource);
    assert.equal(receipt.preview.choices[1].action.source_preview, selectedSource);

    const stored = coordinator.getProposal(receipt.proposal_id, {
      run_nonce: firstTurnBinding.run_nonce,
    });
    assert.ok(stored);
    assert.equal(stored.proposal.binding.conversation_id, CONVERSATION_ID);
    assert.equal(stored.proposal.request_digest, receipt.request_digest);
    assert.equal(stored.proposal.operation, "multi_choice_terminal");
    const selected = stored.proposal.payload.choices.find(
      (choice) => choice.choice_id === "selected",
    );
    assert.ok(selected);

    const executionRequest = {
      schema_version: 1,
      proposal_id: receipt.proposal_id,
      operation: stored.proposal.operation,
      selection_id: selected.choice_id,
      action: selected.action,
      execution_digest: selected.execution_digest,
    };
    const executionProcess = await runChild(EXECUTOR_WRAPPER, {
      environment: childEnvironment(firstTurnBinding, {
        conversationId: CONVERSATION_ID,
      }),
      input: `${JSON.stringify(executionRequest)}\n`,
    });
    assert.equal(executionProcess.code, 0, executionProcess.stderr);
    assert.equal(executionProcess.signal, null);
    assert.equal(executionProcess.stderr, "");
    const executionLines = parseNdjson(executionProcess.stdout);
    assert.equal(executionLines.length, 1);
    assert.deepEqual(
      Object.keys(executionLines[0]).sort(),
      ["duration_ms", "exit_code", "status", "stderr", "stdout", "timed_out"],
    );
    assert.equal(executionLines[0].status, "completed");
    assert.equal(executionLines[0].exit_code, 0);
    assert.equal(executionLines[0].stdout, `${OUTPUT_MARKER}\n`);
    assert.equal(executionLines[0].stderr, "");
    assert.equal(executionLines[0].timed_out, false);
    assert.equal(await readFile(SELECTED_MARKER, "utf8"), `${OUTPUT_MARKER}\n`);
    await assert.rejects(access(FIRST_MARKER, constants.F_OK));

    const consumed = coordinator.getProposal(receipt.proposal_id, {
      run_nonce: firstTurnBinding.run_nonce,
      consume: true,
    });
    assert.ok(consumed);
    assert.equal(coordinator.getProposal(receipt.proposal_id), null);
    assert.equal(coordinator.finishRun(firstTurnBinding.run_nonce), true);
  } finally {
    await coordinator.close();
  }
}

main().then(
  () => process.stdout.write("Telegram universal action image smoke passed\n"),
  (error) => {
    process.stderr.write(`Telegram universal action image smoke failed: ${error?.message ?? "unknown error"}\n`);
    process.exitCode = 1;
  },
);
