import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import {
  MAX_REGISTER_MESSAGE_BYTES,
  TELEGRAM_ACTION_PROPOSAL_ID_PATTERN,
  TelegramActionError,
  executionDigestFor,
  isPlainObject,
  normalizeActionCwd,
  normalizeTelegramBinding,
  normalizeTerminalAction,
  redactText,
  safeDigestEqual,
  telegramBindingFromEnvironment,
} from "./telegram-action-proposal-mcp.mjs";

export const TELEGRAM_ACTION_EXECUTOR_SCHEMA_VERSION = 1;
export const DEFAULT_ACTION_SHELL =
  "/usr/local/libexec/antigravity-command-bin/bash";
export const MAX_EXECUTOR_STDIN_BYTES = MAX_REGISTER_MESSAGE_BYTES;
export const MAX_EXECUTOR_STDOUT_BYTES = 4 * 1024;
export const MAX_EXECUTOR_STDERR_BYTES = 2 * 1024;
export const MAX_EXECUTOR_OUTPUT_BYTES =
  MAX_EXECUTOR_STDOUT_BYTES + MAX_EXECUTOR_STDERR_BYTES;
export const EXECUTOR_KILL_GRACE_MS = 250;

const CHOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,24}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const BACKGROUND_AMPERSAND_PATTERN = /(^|[^&<>])&($|[^&>0-9])/u;
const DAEMON_CONSTRUCT_PATTERN =
  /(^|[^A-Za-z0-9_-])(?:nohup|setsid|disown|daemonize|start-stop-daemon|systemd-run|at|batch|crontab|tmux|screen|coproc)(?=$|[^A-Za-z0-9_-])/iu;
const SHELL_JOB_CONTROL_PATTERN = /(^|[;|&()\n])\s*(?:fg|bg|jobs)\b/iu;

const CLEAN_EXECUTION_ENVIRONMENT = Object.freeze({
  HOME: "/tmp",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  PAGER: "cat",
  GIT_PAGER: "cat",
  SYSTEMD_PAGER: "cat",
  TERM: "dumb",
});

function fail(code, message) {
  throw new TelegramActionError(code, message);
}

function assertOnlyKeys(value, keys, label) {
  if (!isPlainObject(value)) fail("invalid_request", `${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) fail("invalid_request", `${label} contains an unsupported field`);
  }
}

function requireChoiceId(value, label) {
  if (typeof value !== "string" || !CHOICE_ID_PATTERN.test(value)) {
    fail("invalid_request", `${label} is invalid`);
  }
  return value;
}

export function normalizeTelegramActionExecutionRequest(value, bindingValue) {
  const binding = normalizeTelegramBinding(bindingValue);
  if (binding.conversation_id === null) {
    fail("invalid_binding", "execution requires a live Antigravity conversation binding");
  }
  assertOnlyKeys(
    value,
    new Set([
      "schema_version",
      "proposal_id",
      "operation",
      "selection_id",
      "action",
      "execution_digest",
    ]),
    "execution request",
  );
  if (value.schema_version !== TELEGRAM_ACTION_EXECUTOR_SCHEMA_VERSION) {
    fail("invalid_request", "execution schema version is invalid");
  }
  if (typeof value.proposal_id !== "string" ||
      !TELEGRAM_ACTION_PROPOSAL_ID_PATTERN.test(value.proposal_id)) {
    fail("invalid_request", "proposal_id is invalid");
  }
  if (!["terminal_command", "multi_choice_terminal"].includes(value.operation)) {
    fail("invalid_request", "execution operation is invalid");
  }
  let selectionId;
  let action;
  if (value.operation === "terminal_command") {
    if (value.selection_id !== null) {
      fail("invalid_request", "terminal_command selection_id must be null");
    }
    selectionId = null;
    action = normalizeTerminalAction(value.action);
  } else {
    selectionId = requireChoiceId(value.selection_id, "selection_id");
    action = normalizeTerminalAction(value.action);
  }
  if (typeof value.execution_digest !== "string" ||
      !DIGEST_PATTERN.test(value.execution_digest)) {
    fail("invalid_request", "execution_digest is invalid");
  }
  const expectedDigest = executionDigestFor(binding, value.operation, selectionId, action);
  if (!safeDigestEqual(value.execution_digest, expectedDigest)) {
    fail("digest_mismatch", "selected action does not match the approved Telegram proposal");
  }
  return {
    schema_version: TELEGRAM_ACTION_EXECUTOR_SCHEMA_VERSION,
    proposal_id: value.proposal_id,
    operation: value.operation,
    selection_id: selectionId,
    action,
    execution_digest: expectedDigest,
  };
}

export function assertNoDetachedShellConstructs(shellSource) {
  if (BACKGROUND_AMPERSAND_PATTERN.test(shellSource) ||
      DAEMON_CONSTRUCT_PATTERN.test(shellSource) ||
      SHELL_JOB_CONTROL_PATTERN.test(shellSource)) {
    fail(
      "detached_execution_forbidden",
      "background, daemon, and shell job-control constructs are not supported",
    );
  }
  return shellSource;
}

async function canonicalExistingCwd(cwd, realpathImpl) {
  const normalized = normalizeActionCwd(cwd);
  let resolved;
  try {
    resolved = await realpathImpl(normalized);
  } catch {
    fail("invalid_cwd", "execution cwd does not exist or is not accessible");
  }
  if (resolved !== normalized) {
    fail("invalid_cwd", "execution cwd must not traverse a symbolic link");
  }
  return normalized;
}

function appendBounded(chunks, chunk, state, limit) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, limit - state.bytes);
  if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
  state.bytes += bytes.length;
  return state.bytes > limit;
}

function truncateUtf8Text(value, limit) {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limit) break;
    output += character;
    bytes += size;
  }
  return output;
}

function safeOutput(chunks, limit) {
  const redacted = redactText(Buffer.concat(chunks).toString("utf8"));
  return truncateUtf8Text(redacted, limit);
}

function terminateProcessGroup(child, signal, killImpl) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) return;
  try {
    killImpl(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited. Execution settlement is event-driven.
    }
  }
}

export async function executeTerminalAction(
  actionValue,
  {
    shellPath = DEFAULT_ACTION_SHELL,
    spawnImpl = spawn,
    realpathImpl = realpath,
    killImpl = process.kill.bind(process),
    killGraceMs = EXECUTOR_KILL_GRACE_MS,
    signal = null,
  } = {},
) {
  const action = normalizeTerminalAction(actionValue);
  assertNoDetachedShellConstructs(action.shell_source);
  if (signal?.aborted === true) {
    fail("execution_cancelled", "approved action was cancelled before execution");
  }
  const cwd = await canonicalExistingCwd(action.cwd, realpathImpl);
  const startedAt = performance.now();

  return new Promise((resolveExecution, rejectExecution) => {
    let child;
    try {
      child = spawnImpl(shellPath, ["-c", action.shell_source, "--"], {
        cwd,
        detached: true,
        env: { ...CLEAN_EXECUTION_ENVIRONMENT },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      rejectExecution(new TelegramActionError("spawn_failed", "approved action could not be started"));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let timedOut = false;
    let outputLimited = false;
    let spawnError = false;
    let settlementUncertain = false;
    let cancelled = false;
    let settled = false;
    let killTimer;
    let hardSettlementTimer;
    let abortExecution = () => {};

    const beginTermination = (reason) => {
      if (reason === "timeout") timedOut = true;
      if (reason === "output_limit") outputLimited = true;
      if (reason === "cancelled") cancelled = true;
      terminateProcessGroup(child, "SIGTERM", killImpl);
      if (killTimer === undefined) {
        killTimer = setTimeout(() => {
          terminateProcessGroup(child, "SIGKILL", killImpl);
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, killGraceMs);
        killTimer.unref?.();
      }
    };

    const timeoutTimer = setTimeout(() => beginTermination("timeout"), action.timeout_ms);
    timeoutTimer.unref?.();

    const finish = (exitCode, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (hardSettlementTimer !== undefined) clearTimeout(hardSettlementTimer);
      signal?.removeEventListener?.("abort", abortExecution);
      const stdout = safeOutput(stdoutChunks, MAX_EXECUTOR_STDOUT_BYTES);
      const stderr = safeOutput(stderrChunks, MAX_EXECUTOR_STDERR_BYTES);
      resolveExecution({
        status: cancelled
          ? "in_doubt"
          : timedOut
          ? settlementUncertain
            ? "in_doubt"
            : "timeout"
          : outputLimited
            ? settlementUncertain
              ? "in_doubt"
              : "output_limit"
            : spawnError
              ? "spawn_error"
              : exitCode === 0
                ? "completed"
                : "failed",
        exit_code: Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255
          ? exitCode
          : null,
        signal: typeof childSignal === "string" ? childSignal : null,
        timed_out: timedOut,
        output_limited: outputLimited,
        stdout,
        stderr,
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    };

    child.stdout?.on("data", (chunk) => {
      if (appendBounded(stdoutChunks, chunk, stdoutState, MAX_EXECUTOR_STDOUT_BYTES)) {
        beginTermination("output_limit");
      }
    });
    child.stderr?.on("data", (chunk) => {
      if (appendBounded(stderrChunks, chunk, stderrState, MAX_EXECUTOR_STDERR_BYTES)) {
        beginTermination("output_limit");
      }
    });
    child.once("error", () => {
      spawnError = true;
    });
    child.once("close", finish);
    abortExecution = () => beginTermination("cancelled");
    signal?.addEventListener?.("abort", abortExecution, { once: true });
    if (signal?.aborted === true) abortExecution();

    hardSettlementTimer = setTimeout(() => {
      settlementUncertain = true;
      beginTermination(timedOut ? "timeout" : "output_limit");
      finish(null, "SIGKILL");
    }, action.timeout_ms + killGraceMs + 1_000);
    hardSettlementTimer.unref?.();
  });
}

export async function executeTelegramActionRequest(
  requestValue,
  bindingValue,
  options = {},
) {
  const request = normalizeTelegramActionExecutionRequest(requestValue, bindingValue);
  const result = await executeTerminalAction(request.action, options);
  const completed = result.status === "completed";
  const inDoubt = result.status === "in_doubt";
  const genericError = result.status === "timeout"
    ? "Approved action timed out."
    : result.status === "output_limit"
      ? "Approved action output exceeded the limit."
      : result.status === "spawn_error"
        ? "Approved action could not be started."
        : result.status === "in_doubt"
          ? "Approved action completion could not be determined."
        : result.stderr;
  return {
    status: completed ? "completed" : inDoubt ? "in_doubt" : "failed",
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: genericError,
    timed_out: result.timed_out,
    duration_ms: result.duration_ms,
  };
}

async function readBoundedJson(input) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_EXECUTOR_STDIN_BYTES) {
      fail("input_too_large", "executor input exceeded the size limit");
    }
    chunks.push(buffer);
  }
  if (bytes === 0) fail("invalid_request", "executor requires one JSON request");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("invalid_request", "executor input is not valid JSON");
  }
  if (!isPlainObject(parsed)) fail("invalid_request", "executor input must be one JSON object");
  return parsed;
}

function executorError(error) {
  const rejected = error instanceof TelegramActionError;
  return {
    status: "failed",
    exit_code: null,
    stdout: "",
    stderr: rejected
      ? "Approved action request was rejected."
      : "Approved action executor failed.",
    timed_out: false,
    duration_ms: 0,
  };
}

export async function runTelegramActionExecutor({
  input = process.stdin,
  output = process.stdout,
  environment = process.env,
  executeOptions = {},
} = {}) {
  let response;
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  process.once("SIGHUP", abort);
  try {
    const binding = telegramBindingFromEnvironment(environment);
    if (binding.conversation_id === null) {
      fail("invalid_binding", "executor requires the live conversation binding");
    }
    const request = await readBoundedJson(input);
    response = await executeTelegramActionRequest(request, binding, {
      ...executeOptions,
      signal: cancellation.signal,
    });
  } catch (error) {
    response = executorError(error);
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGHUP", abort);
  }
  output.write(`${JSON.stringify(response)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTelegramActionExecutor()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
