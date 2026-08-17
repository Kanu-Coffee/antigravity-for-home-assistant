import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, normalize } from "node:path";

import {
  DEFAULT_TELEGRAM_ACTION_PROPOSAL_SOCKET,
  MAX_REGISTER_MESSAGE_BYTES,
  TelegramActionError,
  bindRegisteredActionProposalToConversation,
  normalizeTelegramBinding,
  stableJson,
  validateRegisteredActionProposal,
} from "./telegram-action-proposal-mcp.mjs";

const SOCKET_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/u;
const PROPOSAL_ID_PATTERN = /^ta_[A-Za-z0-9_-]{20,48}$/u;
const SOCKET_TIMEOUT_MS = 5_000;
// Stay below the proposal client's 5 s absolute socket deadline while giving
// a loaded HA host enough time to deliver and parse the CLI init event.
const CONVERSATION_BIND_WAIT_MS = 4_000;

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key));
}

function canonicalSocketPath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 220 ||
      !isAbsolute(value) || normalize(value) !== value) {
    throw new Error("Telegram action proposal socket path is invalid");
  }
  return value;
}

function safeSocketUnlink(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isSocket()) {
      throw new Error("Telegram action proposal path is not a socket");
    }
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function publicError(error) {
  if (error instanceof TelegramActionError &&
      /^[a-z][a-z0-9_]{2,63}$/u.test(error.code)) {
    return error.code;
  }
  if (typeof error?.code === "string" &&
      /^[a-z][a-z0-9_]{2,63}$/u.test(error.code)) {
    return error.code;
  }
  return "proposal_rejected";
}

function bindingMatchesRun(candidate, expected) {
  return candidate.surface === "telegram" &&
    candidate.user_id === expected.user_id &&
    candidate.chat_id === expected.chat_id &&
    candidate.session_generation === expected.session_generation &&
    candidate.update_id === expected.update_id &&
    candidate.run_nonce === expected.run_nonce &&
    (candidate.conversation_id === null ||
      candidate.conversation_id === expected.conversation_id);
}

export class TelegramActionCoordinator {
  #socketPath;
  #server = null;
  #runs = new Map();
  #proposalIndex = new Map();
  #bindingWaiters = new Map();
  #now;
  #randomBytes;

  constructor({
    socketPath = DEFAULT_TELEGRAM_ACTION_PROPOSAL_SOCKET,
    now = Date.now,
    random = randomBytes,
  } = {}) {
    this.#socketPath = canonicalSocketPath(socketPath);
    this.#now = now;
    this.#randomBytes = random;
  }

  get socketPath() {
    return this.#socketPath;
  }

  beginRun({ user_id, chat_id, session_generation, update_id, conversation_id = null }) {
    let runNonce;
    do {
      runNonce = this.#randomBytes(24).toString("base64url");
    } while (this.#runs.has(runNonce));
    const binding = normalizeTelegramBinding({
      surface: "telegram",
      user_id: String(user_id),
      chat_id: String(chat_id),
      session_generation,
      update_id,
      run_nonce: runNonce,
      conversation_id,
    });
    this.#runs.set(runNonce, {
      binding,
      proposals: new Map(),
      proposalByClientDigest: new Map(),
    });
    return { ...binding };
  }

  bindConversation(runNonce, conversationId) {
    const run = this.#runs.get(runNonce);
    if (!run) throw new Error("Telegram action run is unavailable");
    const rebound = normalizeTelegramBinding({
      ...run.binding,
      conversation_id: conversationId,
    });
    if (run.binding.conversation_id !== null &&
        run.binding.conversation_id !== rebound.conversation_id) {
      throw new Error("Telegram action run conversation changed");
    }
    run.binding = rebound;
    const waiters = this.#bindingWaiters.get(runNonce) ?? [];
    this.#bindingWaiters.delete(runNonce);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    return { ...rebound };
  }

  async #waitForConversationBinding(runNonce) {
    const run = this.#runs.get(runNonce);
    if (!run) {
      throw new TelegramActionError(
        "binding_mismatch",
        "Telegram action run binding is unavailable",
      );
    }
    if (run.binding.conversation_id !== null) return;
    await new Promise((resolve, reject) => {
      const waiters = this.#bindingWaiters.get(runNonce) ?? new Set();
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        if (waiters.size === 0) this.#bindingWaiters.delete(runNonce);
        reject(new TelegramActionError(
          "binding_mismatch",
          "Telegram action run conversation binding timed out",
        ));
      }, CONVERSATION_BIND_WAIT_MS);
      waiters.add(waiter);
      this.#bindingWaiters.set(runNonce, waiters);
    });
  }

  async registerAfterConversationBinding(value) {
    const proposal = validateRegisteredActionProposal(value);
    await this.#waitForConversationBinding(proposal.binding.run_nonce);
    return this.register(proposal);
  }

  register(value) {
    const proposal = validateRegisteredActionProposal(value);
    const run = this.#runs.get(proposal.binding.run_nonce);
    if (!run || run.binding.conversation_id === null ||
        !bindingMatchesRun(proposal.binding, run.binding)) {
      throw new TelegramActionError("binding_mismatch", "Telegram action run binding is unavailable");
    }
    const existingId = run.proposalByClientDigest.get(proposal.request_digest);
    if (existingId) {
      const existing = run.proposals.get(existingId);
      if (stableJson(existing.client_proposal) !== stableJson(proposal)) {
        throw new TelegramActionError("digest_conflict", "Telegram action proposal digest was reused");
      }
      return {
        proposal_id: existing.proposal_id,
        request_digest: existing.proposal.request_digest,
        preview: existing.proposal.preview,
      };
    }
    const rebound = bindRegisteredActionProposalToConversation(
      proposal,
      run.binding.conversation_id,
    );
    let proposalId;
    do {
      proposalId = `ta_${this.#randomBytes(18).toString("base64url")}`;
    } while (this.#proposalIndex.has(proposalId));
    if (!PROPOSAL_ID_PATTERN.test(proposalId)) {
      throw new Error("Telegram action proposal identifier generation failed");
    }
    const record = {
      proposal_id: proposalId,
      proposal: rebound,
      client_proposal: proposal,
      registered_at: this.#now(),
      run_nonce: run.binding.run_nonce,
    };
    run.proposals.set(proposalId, record);
    run.proposalByClientDigest.set(proposal.request_digest, proposalId);
    this.#proposalIndex.set(proposalId, record);
    return {
      proposal_id: proposalId,
      request_digest: rebound.request_digest,
      preview: rebound.preview,
    };
  }

  getProposal(proposalId, { run_nonce = null, consume = false } = {}) {
    if (typeof proposalId !== "string" || !PROPOSAL_ID_PATTERN.test(proposalId)) {
      throw new Error("Telegram action proposal identifier is invalid");
    }
    const record = this.#proposalIndex.get(proposalId);
    if (!record || (run_nonce !== null && record.run_nonce !== run_nonce)) return null;
    if (consume) {
      const run = this.#runs.get(record.run_nonce);
      run?.proposals.delete(proposalId);
      this.#proposalIndex.delete(proposalId);
    }
    return {
      proposal_id: record.proposal_id,
      proposal: record.proposal,
      registered_at: record.registered_at,
      run_nonce: record.run_nonce,
    };
  }

  finishRun(runNonce) {
    const run = this.#runs.get(runNonce);
    if (!run) return false;
    const waiters = this.#bindingWaiters.get(runNonce) ?? [];
    this.#bindingWaiters.delete(runNonce);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new TelegramActionError(
        "binding_mismatch",
        "Telegram action run ended before conversation binding",
      ));
    }
    for (const proposalId of run.proposals.keys()) this.#proposalIndex.delete(proposalId);
    this.#runs.delete(runNonce);
    return true;
  }

  #handleConnection(socket) {
    socket.setEncoding("utf8");
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    let buffer = "";
    let bytes = 0;
    let answered = false;
    const respond = (value) => {
      if (answered) return;
      answered = true;
      socket.end(`${JSON.stringify(value)}\n`);
    };
    socket.once("timeout", () => {
      answered = true;
      socket.destroy();
    });
    socket.once("error", () => {});
    socket.on("data", (chunk) => {
      if (answered) return;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_REGISTER_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch {
        respond({ id: null, ok: false, error: { code: "invalid_request" } });
        return;
      }
      const requestId = exactKeys(request, ["id", "action", "payload"]) &&
        typeof request.id === "string" && SOCKET_REQUEST_ID_PATTERN.test(request.id)
        ? request.id
        : null;
      if (requestId === null || request.action !== "register") {
        respond({ id: requestId, ok: false, error: { code: "invalid_request" } });
        return;
      }
      void this.registerAfterConversationBinding(request.payload)
        .then((result) => respond({ id: requestId, ok: true, result }))
        .catch((error) => {
          respond({ id: requestId, ok: false, error: { code: publicError(error) } });
        });
    });
  }

  async start() {
    if (this.#server !== null) return this;
    mkdirSync(dirname(this.#socketPath), { recursive: true, mode: 0o700 });
    safeSocketUnlink(this.#socketPath);
    const server = createServer((socket) => this.#handleConnection(socket));
    this.#server = server;
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.#socketPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      chmodSync(this.#socketPath, 0o600);
      return this;
    } catch (error) {
      this.#server = null;
      try {
        server.close();
      } catch {}
      safeSocketUnlink(this.#socketPath);
      throw error;
    }
  }

  async close() {
    const server = this.#server;
    this.#server = null;
    if (server !== null) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    safeSocketUnlink(this.#socketPath);
    for (const runNonce of [...this.#bindingWaiters.keys()]) this.finishRun(runNonce);
    this.#bindingWaiters.clear();
    this.#runs.clear();
    this.#proposalIndex.clear();
  }
}

export const telegramActionCoordinator = new TelegramActionCoordinator();
