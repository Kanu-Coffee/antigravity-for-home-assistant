import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const DEFAULT_STATE_PATH = "/data/antigravity-ha/telegram/bridge-state.json";
const MAX_STATE_BYTES = 3 * 1024 * 1024;
const MAX_SESSIONS = 128;
const MAX_UPDATE_LEDGER_ENTRIES = 128;
const MAX_SEALED_UPDATE_ENTRIES = 128;
const MAX_SEALED_SPOOL_BYTES = 2 * 1024 * 1024;
const MAX_NORMALIZED_UPDATE_BYTES = 20 * 1024;
const MAX_OUTBOX_DELIVERIES = 64;
const MAX_OUTBOX_CHUNKS = 64;
const MAX_OUTBOX_RESPONSE_BYTES = 256 * 1024;
const MAX_OUTBOX_PLAINTEXT_BYTES = MAX_OUTBOX_RESPONSE_BYTES + 16 * 1024;
const MAX_SEALED_OUTBOX_BYTES = 768 * 1024;
const MAX_PENDING_APPROVALS = 128;
const MAX_APPROVAL_PLAINTEXT_BYTES = 8 * 1024;
const MAX_SEALED_APPROVAL_BYTES = 1024 * 1024;
const MAX_TERMINAL_TURNS = 64;
const MAX_TERMINAL_PLAINTEXT_BYTES = 96 * 1024;
const MAX_SEALED_TERMINAL_BYTES = 512 * 1024;
const MAX_CONTROL_EFFECTS = 128;
const MAX_CONTROL_RESULT_BYTES = 2 * 1024;
const REQUIRED_UID = typeof process.getuid === "function" ? process.getuid() : 0;
const SEALED_UPDATE_SCHEMA = "antigravity-ha-telegram-update/v1";
const SEALED_DELIVERY_SCHEMA = "antigravity-ha-telegram-delivery/v1";
const SEALED_APPROVAL_SCHEMA = "antigravity-ha-telegram-approval/v1";
const SEALED_TERMINAL_SCHEMA = "antigravity-ha-telegram-terminal/v1";
const SEALED_UPDATE_ALGORITHM = "aes-256-gcm";
const KEY_DERIVATION_SALT = Buffer.from("antigravity-ha/telegram-spool/salt/v1", "utf8");
const KEY_DERIVATION_INFO = Buffer.from("antigravity-ha/telegram-spool/aes-256-gcm/v1", "utf8");
const OUTBOX_KEY_DERIVATION_SALT = Buffer.from("antigravity-ha/telegram-outbox/salt/v1", "utf8");
const OUTBOX_KEY_DERIVATION_INFO = Buffer.from("antigravity-ha/telegram-outbox/aes-256-gcm/v1", "utf8");
const APPROVAL_KEY_DERIVATION_SALT = Buffer.from("antigravity-ha/telegram-approval/salt/v1", "utf8");
const APPROVAL_KEY_DERIVATION_INFO = Buffer.from("antigravity-ha/telegram-approval/aes-256-gcm/v1", "utf8");
const TERMINAL_KEY_DERIVATION_SALT = Buffer.from("antigravity-ha/telegram-terminal/salt/v1", "utf8");
const TERMINAL_KEY_DERIVATION_INFO = Buffer.from("antigravity-ha/telegram-terminal/aes-256-gcm/v1", "utf8");
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const APPROVAL_CHOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,24}$/u;
const APPROVAL_CHOICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,16}$/u;

function telegramId(value, signed) {
  const text = String(value ?? "");
  const pattern = signed ? /^-?[1-9]\d{0,19}$/ : /^[1-9]\d{0,19}$/;
  if (!pattern.test(text)) throw new Error("invalid Telegram state identity");
  return text;
}

function ensurePrivateDirectory(path, create) {
  if (!existsSync(path)) {
    if (!create) throw new Error("Telegram state directory is missing");
    mkdirSync(path, { mode: 0o700 });
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== REQUIRED_UID ||
      (info.mode & 0o777) !== 0o700) {
    throw new Error("Telegram state directory is unsafe");
  }
}

function ensureStorage(path) {
  const parent = dirname(path);
  const managedRoot = dirname(parent);
  ensurePrivateDirectory(managedRoot, true);
  ensurePrivateDirectory(parent, true);
}

function emptyState() {
  return {
    version: 7,
    update_offset: 0,
    transport_offset: 0,
    update_ledger: [],
    sealed_updates: [],
    sessions: [],
    response_outbox: [],
    sealed_approvals: [],
    terminal_turns: [],
    control_effects: [],
  };
}

function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function canonicalBase64(value, expectedBytes = null) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("invalid Telegram sealed update encoding");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value ||
      (expectedBytes !== null && decoded.length !== expectedBytes)) {
    throw new Error("invalid Telegram sealed update encoding");
  }
  return decoded;
}

function validateChat(value) {
  if (!hasExactKeys(value, ["id", "type"])) throw new Error("invalid normalized Telegram chat");
  const id = telegramId(value.id, true);
  if (typeof value.type !== "string" || !/^[a-z_]{1,32}$/u.test(value.type)) {
    throw new Error("invalid normalized Telegram chat type");
  }
  return { id, type: value.type };
}

function validateFrom(value) {
  if (!hasExactKeys(value, ["id"])) throw new Error("invalid normalized Telegram sender");
  return { id: telegramId(value.id, false) };
}

function validateNormalizedUpdate(value) {
  if (!hasExactKeys(value, ["updateId", "kind", "value"]) ||
      !Number.isSafeInteger(value.updateId) || value.updateId < 0) {
    throw new Error("invalid normalized Telegram update");
  }
  if (value.kind === "message") {
    const message = value.value;
    if (!hasExactKeys(message, ["updateId", "message_id", "from", "chat", "text"]) ||
        message.updateId !== value.updateId ||
        !Number.isSafeInteger(message.message_id) || message.message_id <= 0 ||
        typeof message.text !== "string" ||
        Buffer.byteLength(message.text, "utf8") > 16 * 1024 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message.text)) {
      throw new Error("invalid normalized Telegram message");
    }
    return {
      updateId: value.updateId,
      kind: "message",
      value: {
        updateId: value.updateId,
        message_id: message.message_id,
        from: validateFrom(message.from),
        chat: validateChat(message.chat),
        text: message.text,
      },
    };
  }
  if (value.kind === "callback_query") {
    const callback = value.value;
    if (!hasExactKeys(callback, ["updateId", "id", "from", "message", "data"]) ||
        callback.updateId !== value.updateId ||
        typeof callback.id !== "string" || callback.id.length < 1 || callback.id.length > 128 ||
        typeof callback.data !== "string" || Buffer.byteLength(callback.data, "utf8") > 64 ||
        !hasExactKeys(callback.message, ["chat"])) {
      throw new Error("invalid normalized Telegram callback");
    }
    return {
      updateId: value.updateId,
      kind: "callback_query",
      value: {
        updateId: value.updateId,
        id: callback.id,
        from: validateFrom(callback.from),
        message: { chat: validateChat(callback.message.chat) },
        data: callback.data,
      },
    };
  }
  throw new Error("invalid normalized Telegram update kind");
}

function deriveBotTokenKey(botToken, salt, info) {
  if (typeof botToken !== "string" || !/^[1-9]\d{5,15}:[A-Za-z0-9_-]{30,128}$/u.test(botToken)) {
    throw new Error("Telegram sealed spool key material is invalid");
  }
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(botToken, "utf8"),
    salt,
    info,
    32,
  ));
}

function deriveSealedUpdateKey(botToken) {
  return deriveBotTokenKey(botToken, KEY_DERIVATION_SALT, KEY_DERIVATION_INFO);
}

function deriveSealedOutboxKey(botToken) {
  return deriveBotTokenKey(
    botToken,
    OUTBOX_KEY_DERIVATION_SALT,
    OUTBOX_KEY_DERIVATION_INFO,
  );
}

function deriveSealedApprovalKey(botToken) {
  return deriveBotTokenKey(
    botToken,
    APPROVAL_KEY_DERIVATION_SALT,
    APPROVAL_KEY_DERIVATION_INFO,
  );
}

function deriveSealedTerminalKey(botToken) {
  return deriveBotTokenKey(
    botToken,
    TERMINAL_KEY_DERIVATION_SALT,
    TERMINAL_KEY_DERIVATION_INFO,
  );
}

function sealedUpdateAad(updateId) {
  return Buffer.from(`${SEALED_UPDATE_SCHEMA}\u0000${updateId}`, "utf8");
}

function sealedSpoolFailure(message) {
  const error = new Error(message);
  error.code = "ETELEGRAMSPOOL";
  return error;
}

function outboxFailure(message) {
  const error = new Error(message);
  error.code = "ETELEGRAMOUTBOX";
  return error;
}

function approvalFailure(message) {
  const error = new Error(message);
  error.code = "ETELEGRAMAPPROVAL";
  return error;
}

function terminalFailure(message) {
  const error = new Error(message);
  error.code = "ETELEGRAMTERMINAL";
  return error;
}

function sealNormalizedUpdate(normalized, key) {
  const canonical = validateNormalizedUpdate(normalized);
  const plaintext = Buffer.from(JSON.stringify({
    schema: SEALED_UPDATE_SCHEMA,
    update: canonical,
  }), "utf8");
  if (plaintext.length > MAX_NORMALIZED_UPDATE_BYTES) {
    throw new Error("normalized Telegram update exceeded the sealed record limit");
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv(SEALED_UPDATE_ALGORITHM, key, nonce);
  cipher.setAAD(sealedUpdateAad(canonical.updateId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    update_id: canonical.updateId,
    algorithm: SEALED_UPDATE_ALGORITHM,
    nonce: nonce.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    plaintext_bytes: plaintext.length,
  };
}

function decryptSealedUpdate(record, key) {
  const nonce = canonicalBase64(record.nonce, 12);
  const authTag = canonicalBase64(record.auth_tag, 16);
  const ciphertext = canonicalBase64(record.ciphertext);
  let plaintext;
  try {
    const decipher = createDecipheriv(SEALED_UPDATE_ALGORITHM, key, nonce);
    decipher.setAAD(sealedUpdateAad(record.update_id));
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw sealedSpoolFailure("Telegram sealed spool authentication failed");
  }
  if (plaintext.length !== record.plaintext_bytes || plaintext.length > MAX_NORMALIZED_UPDATE_BYTES) {
    throw sealedSpoolFailure("Telegram sealed spool plaintext length is invalid");
  }
  let document;
  try {
    document = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw sealedSpoolFailure("Telegram sealed spool plaintext is invalid");
  }
  if (!hasExactKeys(document, ["schema", "update"]) || document.schema !== SEALED_UPDATE_SCHEMA) {
    throw sealedSpoolFailure("Telegram sealed spool schema is invalid");
  }
  let normalized;
  try {
    normalized = validateNormalizedUpdate(document.update);
  } catch {
    throw sealedSpoolFailure("Telegram sealed spool update is invalid");
  }
  if (normalized.updateId !== record.update_id) {
    throw sealedSpoolFailure("Telegram sealed spool identity is invalid");
  }
  return normalized;
}

function canonicalGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("invalid Telegram session generation");
  }
  return value;
}

function canonicalDeliveryId(value) {
  if (typeof value !== "string" || !DELIVERY_ID_PATTERN.test(value)) {
    throw new Error("invalid Telegram response delivery id");
  }
  return value;
}

function canonicalDeliveryStage(value) {
  const stage = value ?? "assistant";
  if (typeof stage !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/u.test(stage)) {
    throw new Error("invalid Telegram response delivery stage");
  }
  return stage;
}

function validateReplyMarkup(value) {
  if (value === undefined || value === null) return null;
  if (!hasExactKeys(value, ["inline_keyboard"]) ||
      !Array.isArray(value.inline_keyboard) || value.inline_keyboard.length < 1 ||
      value.inline_keyboard.length > 8) {
    throw new Error("invalid Telegram response delivery reply markup");
  }
  const inlineKeyboard = value.inline_keyboard.map((row) => {
    if (!Array.isArray(row) || row.length < 1 || row.length > 4) {
      throw new Error("invalid Telegram response delivery reply markup");
    }
    return row.map((button) => {
      if (!hasExactKeys(button, ["text", "callback_data"]) ||
          typeof button.text !== "string" || button.text.length < 1 ||
          Buffer.byteLength(button.text, "utf8") > 64 ||
          typeof button.callback_data !== "string" || button.callback_data.length < 1 ||
          Buffer.byteLength(button.callback_data, "utf8") > 64 ||
          /[\u0000-\u001f\u007f]/u.test(button.text) ||
          /[\u0000-\u001f\u007f]/u.test(button.callback_data)) {
        throw new Error("invalid Telegram response delivery reply markup");
      }
      return { text: button.text, callback_data: button.callback_data };
    });
  });
  return { inline_keyboard: inlineKeyboard };
}

function validateResponseDelivery(value) {
  const legacyShape = hasExactKeys(value, [
    "delivery_id",
    "update_id",
    "user_id",
    "chat_id",
    "generation",
    "chunks",
  ]);
  const currentShape = hasExactKeys(value, [
    "delivery_id",
    "update_id",
    "user_id",
    "chat_id",
    "generation",
    "stage",
    "chunks",
    "reply_markup",
  ]);
  if ((!legacyShape && !currentShape) ||
      !Number.isSafeInteger(value.update_id) || value.update_id < 0 ||
      !Array.isArray(value.chunks) || value.chunks.length < 1 ||
      value.chunks.length > MAX_OUTBOX_CHUNKS) {
    throw new Error("invalid Telegram response delivery");
  }
  let responseBytes = 0;
  const chunks = value.chunks.map((chunk) => {
    if (typeof chunk !== "string" || chunk.length < 1 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(chunk)) {
      throw new Error("invalid Telegram response delivery chunk");
    }
    responseBytes += Buffer.byteLength(chunk, "utf8");
    if (responseBytes > MAX_OUTBOX_RESPONSE_BYTES) {
      throw new Error("Telegram response delivery exceeded its byte limit");
    }
    return chunk;
  });
  return {
    delivery_id: canonicalDeliveryId(value.delivery_id),
    update_id: value.update_id,
    user_id: telegramId(value.user_id, false),
    chat_id: telegramId(value.chat_id, true),
    generation: canonicalGeneration(value.generation),
    stage: canonicalDeliveryStage(value.stage),
    chunks,
    reply_markup: validateReplyMarkup(value.reply_markup),
  };
}

function sealedDeliveryAad(record) {
  return Buffer.from([
    SEALED_DELIVERY_SCHEMA,
    record.delivery_id,
    record.update_id,
    record.user_id,
    record.chat_id,
    record.generation,
    record.chunk_count,
  ].join("\u0000"), "utf8");
}

function sealResponseDelivery(delivery, key) {
  const canonical = validateResponseDelivery(delivery);
  const plaintext = Buffer.from(JSON.stringify({
    schema: SEALED_DELIVERY_SCHEMA,
    delivery: canonical,
  }), "utf8");
  if (plaintext.length > MAX_OUTBOX_PLAINTEXT_BYTES) {
    throw new Error("Telegram response delivery exceeded its sealed record limit");
  }
  const record = {
    delivery_id: canonical.delivery_id,
    update_id: canonical.update_id,
    user_id: canonical.user_id,
    chat_id: canonical.chat_id,
    generation: canonical.generation,
    stage: canonical.stage,
    status: "pending",
    attempt_count: 0,
    next_chunk_index: 0,
    chunk_count: canonical.chunks.length,
    algorithm: SEALED_UPDATE_ALGORITHM,
  };
  const nonce = randomBytes(12);
  const cipher = createCipheriv(SEALED_UPDATE_ALGORITHM, key, nonce);
  cipher.setAAD(sealedDeliveryAad(record));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ...record,
    nonce: nonce.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    plaintext_bytes: plaintext.length,
  };
}

function decryptSealedDelivery(record, key) {
  const nonce = canonicalBase64(record.nonce, 12);
  const authTag = canonicalBase64(record.auth_tag, 16);
  const ciphertext = canonicalBase64(record.ciphertext);
  let plaintext;
  try {
    const decipher = createDecipheriv(SEALED_UPDATE_ALGORITHM, key, nonce);
    decipher.setAAD(sealedDeliveryAad(record));
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw outboxFailure("Telegram response outbox authentication failed");
  }
  if (plaintext.length !== record.plaintext_bytes ||
      plaintext.length > MAX_OUTBOX_PLAINTEXT_BYTES) {
    throw outboxFailure("Telegram response outbox plaintext length is invalid");
  }
  let document;
  try {
    document = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw outboxFailure("Telegram response outbox plaintext is invalid");
  }
  if (!hasExactKeys(document, ["schema", "delivery"]) ||
      document.schema !== SEALED_DELIVERY_SCHEMA) {
    throw outboxFailure("Telegram response outbox schema is invalid");
  }
  let delivery;
  try {
    delivery = validateResponseDelivery(document.delivery);
  } catch {
    throw outboxFailure("Telegram response outbox delivery is invalid");
  }
  if (delivery.delivery_id !== record.delivery_id ||
      delivery.update_id !== record.update_id ||
      delivery.user_id !== record.user_id ||
      delivery.chat_id !== record.chat_id ||
      delivery.generation !== record.generation ||
      delivery.stage !== record.stage ||
      delivery.chunks.length !== record.chunk_count) {
    throw outboxFailure("Telegram response outbox identity is invalid");
  }
  return {
    ...delivery,
    status: record.status,
    attempt_count: record.attempt_count,
    next_chunk_index: record.next_chunk_index,
  };
}

function validateTerminalTurn(value) {
  if (!hasExactKeys(value, [
    "turn_id",
    "update_id",
    "user_id",
    "chat_id",
    "generation",
    "conversation_id",
    "response",
    "proposal_id",
  ]) || !Number.isSafeInteger(value.update_id) || value.update_id < 0 ||
      typeof value.conversation_id !== "string" ||
      !CONVERSATION_ID_PATTERN.test(value.conversation_id) ||
      typeof value.response !== "string" || value.response.trim().length < 1 ||
      Buffer.byteLength(value.response, "utf8") > MAX_OUTBOX_RESPONSE_BYTES ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.response) ||
      (value.proposal_id !== null &&
        (typeof value.proposal_id !== "string" ||
          !/^[A-Za-z0-9_-]{1,64}$/u.test(value.proposal_id)))) {
    throw new Error("invalid Telegram terminal turn");
  }
  return {
    turn_id: canonicalDeliveryId(value.turn_id),
    update_id: value.update_id,
    user_id: telegramId(value.user_id, false),
    chat_id: telegramId(value.chat_id, true),
    generation: canonicalGeneration(value.generation),
    conversation_id: value.conversation_id,
    response: value.response,
    proposal_id: value.proposal_id,
  };
}

function sealedTerminalAad(record) {
  return Buffer.from([
    SEALED_TERMINAL_SCHEMA,
    record.turn_id,
    record.update_id,
    record.user_id,
    record.chat_id,
    record.generation,
    record.conversation_id,
  ].join("\u0000"), "utf8");
}

function sealTerminalTurn(turn, key) {
  const canonical = validateTerminalTurn(turn);
  const plaintext = Buffer.from(JSON.stringify({
    schema: SEALED_TERMINAL_SCHEMA,
    turn: canonical,
  }), "utf8");
  if (plaintext.length > MAX_TERMINAL_PLAINTEXT_BYTES) {
    throw new Error("Telegram terminal turn exceeded its sealed record limit");
  }
  const record = {
    turn_id: canonical.turn_id,
    update_id: canonical.update_id,
    user_id: canonical.user_id,
    chat_id: canonical.chat_id,
    generation: canonical.generation,
    conversation_id: canonical.conversation_id,
    algorithm: SEALED_UPDATE_ALGORITHM,
  };
  const nonce = randomBytes(12);
  const cipher = createCipheriv(SEALED_UPDATE_ALGORITHM, key, nonce);
  cipher.setAAD(sealedTerminalAad(record));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ...record,
    nonce: nonce.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    plaintext_bytes: plaintext.length,
  };
}

function decryptSealedTerminal(record, key) {
  const nonce = canonicalBase64(record.nonce, 12);
  const authTag = canonicalBase64(record.auth_tag, 16);
  const ciphertext = canonicalBase64(record.ciphertext);
  let plaintext;
  try {
    const decipher = createDecipheriv(SEALED_UPDATE_ALGORITHM, key, nonce);
    decipher.setAAD(sealedTerminalAad(record));
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw terminalFailure("Telegram terminal turn authentication failed");
  }
  if (plaintext.length !== record.plaintext_bytes ||
      plaintext.length > MAX_TERMINAL_PLAINTEXT_BYTES) {
    throw terminalFailure("Telegram terminal turn plaintext length is invalid");
  }
  let document;
  try {
    document = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw terminalFailure("Telegram terminal turn plaintext is invalid");
  }
  if (!hasExactKeys(document, ["schema", "turn"]) ||
      document.schema !== SEALED_TERMINAL_SCHEMA) {
    throw terminalFailure("Telegram terminal turn schema is invalid");
  }
  let turn;
  try {
    turn = validateTerminalTurn(document.turn);
  } catch {
    throw terminalFailure("Telegram terminal turn payload is invalid");
  }
  if (turn.turn_id !== record.turn_id || turn.update_id !== record.update_id ||
      turn.user_id !== record.user_id || turn.chat_id !== record.chat_id ||
      turn.generation !== record.generation ||
      turn.conversation_id !== record.conversation_id) {
    throw terminalFailure("Telegram terminal turn identity is invalid");
  }
  return turn;
}

function validatePendingApproval(value) {
  const legacyKeys = [
    "approval_id",
    "user_id",
    "chat_id",
    "generation",
    "conversation_id",
    "proposal_id",
    "preview_digest",
    "risk",
    "idempotency_key",
    "expires_at",
  ];
  const currentKeys = [...legacyKeys, "approved_update_id"];
  const choiceKeys = [
    ...currentKeys,
    "choice_tokens",
    "choice_prompt",
    "cancel_label",
    "selected_choice_id",
  ];
  const approvedUpdateId = Object.hasOwn(value ?? {}, "approved_update_id")
    ? value.approved_update_id
    : null;
  const hasChoices = hasExactKeys(value, choiceKeys);
  if ((!hasExactKeys(value, legacyKeys) && !hasExactKeys(value, currentKeys) && !hasChoices) ||
      typeof value.approval_id !== "string" ||
      !DELIVERY_ID_PATTERN.test(value.approval_id) ||
      typeof value.conversation_id !== "string" ||
      !CONVERSATION_ID_PATTERN.test(value.conversation_id) ||
      typeof value.proposal_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(value.proposal_id) ||
      typeof value.preview_digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(value.preview_digest) ||
      !["low", "high"].includes(value.risk) ||
      typeof value.idempotency_key !== "string" ||
      value.idempotency_key.length < 8 || value.idempotency_key.length > 128 ||
      !/^[A-Za-z0-9._:@+-]+$/u.test(value.idempotency_key) ||
      !Number.isSafeInteger(value.expires_at) || value.expires_at < 1 ||
      (approvedUpdateId !== null &&
        (!Number.isSafeInteger(approvedUpdateId) || approvedUpdateId < 0))) {
    throw new Error("invalid Telegram pending approval");
  }
  let choiceTokens;
  let choicePrompt;
  let cancelLabel;
  let selectedChoiceId;
  if (hasChoices) {
    if (!Array.isArray(value.choice_tokens) || value.choice_tokens.length < 1 ||
        value.choice_tokens.length > 31 ||
        typeof value.choice_prompt !== "string" || value.choice_prompt.length < 1 ||
        value.choice_prompt.length > 500 ||
        Buffer.byteLength(value.choice_prompt, "utf8") > 1_024 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.choice_prompt) ||
        typeof value.cancel_label !== "string" || value.cancel_label.length < 1 ||
        Buffer.byteLength(value.cancel_label, "utf8") > 64 ||
        /[\u0000-\u001f\u007f]/u.test(value.cancel_label) ||
        (value.selected_choice_id !== null &&
          (typeof value.selected_choice_id !== "string" ||
            !APPROVAL_CHOICE_ID_PATTERN.test(value.selected_choice_id)))) {
      throw new Error("invalid Telegram pending approval choices");
    }
    const seenTokens = new Set();
    const seenChoiceIds = new Set();
    choiceTokens = value.choice_tokens.map((choice) => {
      if (!hasExactKeys(choice, ["token", "choice_id", "label"]) ||
          typeof choice.token !== "string" ||
          !APPROVAL_CHOICE_TOKEN_PATTERN.test(choice.token) ||
          typeof choice.choice_id !== "string" ||
          !APPROVAL_CHOICE_ID_PATTERN.test(choice.choice_id) ||
          typeof choice.label !== "string" || choice.label.length < 1 ||
          Buffer.byteLength(choice.label, "utf8") > 64 ||
          /[\u0000-\u001f\u007f]/u.test(choice.label) ||
          seenTokens.has(choice.token) || seenChoiceIds.has(choice.choice_id)) {
        throw new Error("invalid Telegram pending approval choices");
      }
      seenTokens.add(choice.token);
      seenChoiceIds.add(choice.choice_id);
      return { token: choice.token, choice_id: choice.choice_id, label: choice.label };
    });
    choicePrompt = value.choice_prompt;
    cancelLabel = value.cancel_label;
    selectedChoiceId = value.selected_choice_id;
    if ((selectedChoiceId === null) !== (approvedUpdateId === null) ||
        (selectedChoiceId !== null && !seenChoiceIds.has(selectedChoiceId))) {
      throw new Error("invalid Telegram pending approval choice selection");
    }
  }
  const canonical = {
    approval_id: value.approval_id,
    user_id: telegramId(value.user_id, false),
    chat_id: telegramId(value.chat_id, true),
    generation: canonicalGeneration(value.generation),
    conversation_id: value.conversation_id,
    proposal_id: value.proposal_id,
    preview_digest: value.preview_digest,
    risk: value.risk,
    idempotency_key: value.idempotency_key,
    expires_at: value.expires_at,
    approved_update_id: approvedUpdateId,
  };
  if (hasChoices) {
    canonical.choice_tokens = choiceTokens;
    canonical.choice_prompt = choicePrompt;
    canonical.cancel_label = cancelLabel;
    canonical.selected_choice_id = selectedChoiceId;
  }
  return canonical;
}

function sealedApprovalAad(approvalId) {
  return Buffer.from(`${SEALED_APPROVAL_SCHEMA}\u0000${approvalId}`, "utf8");
}

function sealPendingApproval(approval, key) {
  const canonical = validatePendingApproval(approval);
  const plaintext = Buffer.from(JSON.stringify({
    schema: SEALED_APPROVAL_SCHEMA,
    approval: canonical,
  }), "utf8");
  if (plaintext.length > MAX_APPROVAL_PLAINTEXT_BYTES) {
    throw new Error("Telegram pending approval exceeded its sealed record limit");
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv(SEALED_UPDATE_ALGORITHM, key, nonce);
  cipher.setAAD(sealedApprovalAad(canonical.approval_id));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    approval_id: canonical.approval_id,
    algorithm: SEALED_UPDATE_ALGORITHM,
    nonce: nonce.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    plaintext_bytes: plaintext.length,
  };
}

function decryptSealedApproval(record, key) {
  const nonce = canonicalBase64(record.nonce, 12);
  const authTag = canonicalBase64(record.auth_tag, 16);
  const ciphertext = canonicalBase64(record.ciphertext);
  let plaintext;
  try {
    const decipher = createDecipheriv(SEALED_UPDATE_ALGORITHM, key, nonce);
    decipher.setAAD(sealedApprovalAad(record.approval_id));
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw approvalFailure("Telegram pending approval authentication failed");
  }
  if (plaintext.length !== record.plaintext_bytes ||
      plaintext.length > MAX_APPROVAL_PLAINTEXT_BYTES) {
    throw approvalFailure("Telegram pending approval plaintext length is invalid");
  }
  let document;
  try {
    document = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw approvalFailure("Telegram pending approval plaintext is invalid");
  }
  if (!hasExactKeys(document, ["schema", "approval"]) ||
      document.schema !== SEALED_APPROVAL_SCHEMA) {
    throw approvalFailure("Telegram pending approval schema is invalid");
  }
  let approval;
  try {
    approval = validatePendingApproval(document.approval);
  } catch {
    throw approvalFailure("Telegram pending approval payload is invalid");
  }
  if (approval.approval_id !== record.approval_id) {
    throw approvalFailure("Telegram pending approval identity is invalid");
  }
  return approval;
}

function sealedSpoolBytes(records) {
  return records.reduce(
    (total, record) => total + canonicalBase64(record.ciphertext).length + 28,
    0,
  );
}

function sealedOutboxBytes(records) {
  return records.reduce(
    (total, record) => total + canonicalBase64(record.ciphertext).length + 28,
    0,
  );
}

function sealedApprovalBytes(records) {
  return records.reduce(
    (total, record) => total + canonicalBase64(record.ciphertext).length + 28,
    0,
  );
}

function sealedTerminalBytes(records) {
  return records.reduce(
    (total, record) => total + canonicalBase64(record.ciphertext).length + 28,
    0,
  );
}

function validateControlEffect(value) {
  if (!hasExactKeys(value, ["update_id", "user_id", "chat_id", "command", "result"]) ||
      !Number.isSafeInteger(value.update_id) || value.update_id < 0 ||
      !["cancel", "new"].includes(value.command) ||
      typeof value.result !== "string" || value.result.length < 1 ||
      Buffer.byteLength(value.result, "utf8") > MAX_CONTROL_RESULT_BYTES ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.result)) {
    throw new Error("invalid Telegram control effect");
  }
  return {
    update_id: value.update_id,
    user_id: telegramId(value.user_id, false),
    chat_id: telegramId(value.chat_id, true),
    command: value.command,
    result: value.result,
  };
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![2, 3, 4, 5, 6, 7].includes(value.version) ||
      !Number.isSafeInteger(value.update_offset) || value.update_offset < 0) {
    throw new Error("unsupported Telegram bridge state");
  }
  const rawLedger = value.version === 2 ? [] : value.update_ledger;
  if (!Array.isArray(rawLedger) || rawLedger.length > MAX_UPDATE_LEDGER_ENTRIES) {
    throw new Error("unsupported Telegram update acknowledgement ledger");
  }
  let previousUpdateId = -1;
  const updateLedger = rawLedger.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        !Number.isSafeInteger(entry.update_id) || entry.update_id < value.update_offset ||
        entry.update_id <= previousUpdateId || typeof entry.acknowledged !== "boolean") {
      throw new Error("invalid Telegram update acknowledgement ledger");
    }
    previousUpdateId = entry.update_id;
    return { update_id: entry.update_id, acknowledged: entry.acknowledged };
  });
  const transportOffset = value.version >= 4 ? value.transport_offset : value.update_offset;
  if (!Number.isSafeInteger(transportOffset) || transportOffset < value.update_offset) {
    throw new Error("invalid Telegram transport offset");
  }
  const rawSealedUpdates = value.version >= 4 ? value.sealed_updates : [];
  if (!Array.isArray(rawSealedUpdates) ||
      rawSealedUpdates.length > MAX_SEALED_UPDATE_ENTRIES) {
    throw new Error("unsupported Telegram sealed update spool");
  }
  const ledgerById = new Map(updateLedger.map((entry) => [entry.update_id, entry]));
  let previousSealedId = -1;
  const sealedUpdates = rawSealedUpdates.map((entry) => {
    if (!hasExactKeys(entry, [
      "update_id",
      "algorithm",
      "nonce",
      "auth_tag",
      "ciphertext",
      "plaintext_bytes",
    ]) || !Number.isSafeInteger(entry.update_id) || entry.update_id < value.update_offset ||
        entry.update_id >= transportOffset || entry.update_id <= previousSealedId ||
        entry.algorithm !== SEALED_UPDATE_ALGORITHM ||
        !Number.isSafeInteger(entry.plaintext_bytes) || entry.plaintext_bytes < 1 ||
        entry.plaintext_bytes > MAX_NORMALIZED_UPDATE_BYTES) {
      throw new Error("invalid Telegram sealed update spool");
    }
    canonicalBase64(entry.nonce, 12);
    canonicalBase64(entry.auth_tag, 16);
    const ciphertext = canonicalBase64(entry.ciphertext);
    if (ciphertext.length !== entry.plaintext_bytes) {
      throw new Error("invalid Telegram sealed update ciphertext length");
    }
    const ledgerEntry = ledgerById.get(entry.update_id);
    if (!ledgerEntry || ledgerEntry.acknowledged) {
      throw new Error("Telegram sealed update is not pending acknowledgement");
    }
    previousSealedId = entry.update_id;
    return {
      update_id: entry.update_id,
      algorithm: entry.algorithm,
      nonce: entry.nonce,
      auth_tag: entry.auth_tag,
      ciphertext: entry.ciphertext,
      plaintext_bytes: entry.plaintext_bytes,
    };
  });
  if (sealedSpoolBytes(sealedUpdates) > MAX_SEALED_SPOOL_BYTES) {
    throw new Error("Telegram sealed update spool exceeded its byte limit");
  }
  const sealedIds = new Set(sealedUpdates.map((entry) => entry.update_id));
  for (const entry of updateLedger) {
    if (!entry.acknowledged && entry.update_id < transportOffset && !sealedIds.has(entry.update_id)) {
      throw new Error("confirmed Telegram update is missing from the sealed spool");
    }
  }
  // v5 was an unpublished shared-runtime development schema, so its conversation
  // ids have shared-HOME provenance. Published v2-v4 ids came from the removed
  // isolated Telegram HOME and must never be resumed in the shared runtime.
  const rawSessions = value.version >= 5 ? value.sessions : value.conversations;
  if (!Array.isArray(rawSessions) || rawSessions.length > MAX_SESSIONS) {
    throw new Error("unsupported Telegram session state");
  }
  const seenSessions = new Set();
  const sessions = rawSessions.map((entry) => {
    const legacy = value.version < 5;
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        (legacy && !Number.isSafeInteger(entry.last_used_at)) ||
        (!legacy && !hasExactKeys(entry, [
          "user_id",
          "chat_id",
          "generation",
          "conversation_id",
        ]))) {
      throw new Error("invalid Telegram session binding");
    }
    const userId = telegramId(entry.user_id, false);
    const chatId = telegramId(entry.chat_id, true);
    const key = `${userId}:${chatId}`;
    if (seenSessions.has(key)) throw new Error("duplicate Telegram session binding");
    seenSessions.add(key);
    const generation = legacy ? 1 : canonicalGeneration(entry.generation);
    const storedConversationId = entry.conversation_id;
    if (storedConversationId !== null &&
        (typeof storedConversationId !== "string" ||
          !CONVERSATION_ID_PATTERN.test(storedConversationId))) {
      throw new Error("invalid Telegram session conversation binding");
    }
    const conversationId = legacy ? null : storedConversationId;
    return {
      user_id: userId,
      chat_id: chatId,
      generation,
      conversation_id: conversationId,
    };
  });

  const rawOutbox = value.version >= 5 ? value.response_outbox : [];
  if (!Array.isArray(rawOutbox) || rawOutbox.length > MAX_OUTBOX_DELIVERIES) {
    throw new Error("unsupported Telegram response outbox");
  }
  const seenDeliveryIds = new Set();
  const seenDeliveryKeys = new Set();
  const responseOutbox = rawOutbox.map((entry) => {
    const legacyShape = value.version === 5 && hasExactKeys(entry, [
      "delivery_id",
      "update_id",
      "user_id",
      "chat_id",
      "generation",
      "status",
      "next_chunk_index",
      "chunk_count",
      "algorithm",
      "nonce",
      "auth_tag",
      "ciphertext",
      "plaintext_bytes",
    ]);
    const currentShape = value.version >= 6 && hasExactKeys(entry, [
      "delivery_id",
      "update_id",
      "user_id",
      "chat_id",
      "generation",
      "stage",
      "status",
      "attempt_count",
      "next_chunk_index",
      "chunk_count",
      "algorithm",
      "nonce",
      "auth_tag",
      "ciphertext",
      "plaintext_bytes",
    ]);
    if ((!legacyShape && !currentShape) ||
        !Number.isSafeInteger(entry.update_id) || entry.update_id < 0 ||
        !["pending", "attempting", "ambiguous"].includes(entry.status) ||
        (value.version === 5 && !["pending", "ambiguous"].includes(entry.status)) ||
        (value.version >= 6 && (!Number.isSafeInteger(entry.attempt_count) ||
          entry.attempt_count < 0 || entry.attempt_count > Number.MAX_SAFE_INTEGER)) ||
        !Number.isSafeInteger(entry.next_chunk_index) || entry.next_chunk_index < 0 ||
        !Number.isSafeInteger(entry.chunk_count) || entry.chunk_count < 1 ||
        entry.chunk_count > MAX_OUTBOX_CHUNKS ||
        entry.next_chunk_index >= entry.chunk_count ||
        entry.algorithm !== SEALED_UPDATE_ALGORITHM ||
        !Number.isSafeInteger(entry.plaintext_bytes) || entry.plaintext_bytes < 1 ||
        entry.plaintext_bytes > MAX_OUTBOX_PLAINTEXT_BYTES) {
      throw new Error("invalid Telegram response outbox");
    }
    const deliveryId = canonicalDeliveryId(entry.delivery_id);
    const userId = telegramId(entry.user_id, false);
    const chatId = telegramId(entry.chat_id, true);
    const generation = canonicalGeneration(entry.generation);
    const stage = canonicalDeliveryStage(entry.stage);
    canonicalBase64(entry.nonce, 12);
    canonicalBase64(entry.auth_tag, 16);
    const ciphertext = canonicalBase64(entry.ciphertext);
    if (ciphertext.length !== entry.plaintext_bytes) {
      throw new Error("invalid Telegram response outbox ciphertext length");
    }
    const deliveryKey = `${entry.update_id}:${userId}:${chatId}:${generation}:${stage}`;
    if (seenDeliveryIds.has(deliveryId) || seenDeliveryKeys.has(deliveryKey)) {
      throw new Error("duplicate Telegram response delivery");
    }
    seenDeliveryIds.add(deliveryId);
    seenDeliveryKeys.add(deliveryKey);
    return {
      delivery_id: deliveryId,
      update_id: entry.update_id,
      user_id: userId,
      chat_id: chatId,
      generation,
      stage,
      status: entry.status,
      attempt_count: value.version === 5 ? 0 : entry.attempt_count,
      next_chunk_index: entry.next_chunk_index,
      chunk_count: entry.chunk_count,
      algorithm: entry.algorithm,
      nonce: entry.nonce,
      auth_tag: entry.auth_tag,
      ciphertext: entry.ciphertext,
      plaintext_bytes: entry.plaintext_bytes,
    };
  });
  if (sealedOutboxBytes(responseOutbox) > MAX_SEALED_OUTBOX_BYTES) {
    throw new Error("Telegram response outbox exceeded its byte limit");
  }
  const rawApprovals = value.version >= 5 ? value.sealed_approvals : [];
  if (!Array.isArray(rawApprovals) || rawApprovals.length > MAX_PENDING_APPROVALS) {
    throw new Error("unsupported Telegram pending approval store");
  }
  const seenApprovalIds = new Set();
  const sealedApprovals = rawApprovals.map((entry) => {
    if (!hasExactKeys(entry, [
      "approval_id",
      "algorithm",
      "nonce",
      "auth_tag",
      "ciphertext",
      "plaintext_bytes",
    ]) || typeof entry.approval_id !== "string" ||
        !DELIVERY_ID_PATTERN.test(entry.approval_id) ||
        entry.algorithm !== SEALED_UPDATE_ALGORITHM ||
        !Number.isSafeInteger(entry.plaintext_bytes) || entry.plaintext_bytes < 1 ||
        entry.plaintext_bytes > MAX_APPROVAL_PLAINTEXT_BYTES) {
      throw new Error("invalid Telegram pending approval store");
    }
    canonicalBase64(entry.nonce, 12);
    canonicalBase64(entry.auth_tag, 16);
    const ciphertext = canonicalBase64(entry.ciphertext);
    if (ciphertext.length !== entry.plaintext_bytes ||
        seenApprovalIds.has(entry.approval_id)) {
      throw new Error("invalid Telegram pending approval store");
    }
    seenApprovalIds.add(entry.approval_id);
    return {
      approval_id: entry.approval_id,
      algorithm: entry.algorithm,
      nonce: entry.nonce,
      auth_tag: entry.auth_tag,
      ciphertext: entry.ciphertext,
      plaintext_bytes: entry.plaintext_bytes,
    };
  });
  if (sealedApprovalBytes(sealedApprovals) > MAX_SEALED_APPROVAL_BYTES) {
    throw new Error("Telegram pending approval store exceeded its byte limit");
  }
  const rawTerminals = value.version >= 7 ? value.terminal_turns : [];
  if (!Array.isArray(rawTerminals) || rawTerminals.length > MAX_TERMINAL_TURNS) {
    throw new Error("unsupported Telegram terminal turn journal");
  }
  const seenTerminalIds = new Set();
  const seenTerminalKeys = new Set();
  const terminalTurns = rawTerminals.map((entry) => {
    if (!hasExactKeys(entry, [
      "turn_id",
      "update_id",
      "user_id",
      "chat_id",
      "generation",
      "conversation_id",
      "algorithm",
      "nonce",
      "auth_tag",
      "ciphertext",
      "plaintext_bytes",
    ]) || !Number.isSafeInteger(entry.update_id) || entry.update_id < 0 ||
        typeof entry.conversation_id !== "string" ||
        !CONVERSATION_ID_PATTERN.test(entry.conversation_id) ||
        entry.algorithm !== SEALED_UPDATE_ALGORITHM ||
        !Number.isSafeInteger(entry.plaintext_bytes) || entry.plaintext_bytes < 1 ||
        entry.plaintext_bytes > MAX_TERMINAL_PLAINTEXT_BYTES) {
      throw new Error("invalid Telegram terminal turn journal");
    }
    const turnId = canonicalDeliveryId(entry.turn_id);
    const userId = telegramId(entry.user_id, false);
    const chatId = telegramId(entry.chat_id, true);
    const generation = canonicalGeneration(entry.generation);
    canonicalBase64(entry.nonce, 12);
    canonicalBase64(entry.auth_tag, 16);
    const ciphertext = canonicalBase64(entry.ciphertext);
    const terminalKey = `${entry.update_id}:${userId}:${chatId}:${generation}`;
    if (ciphertext.length !== entry.plaintext_bytes || seenTerminalIds.has(turnId) ||
        seenTerminalKeys.has(terminalKey)) {
      throw new Error("invalid Telegram terminal turn journal");
    }
    seenTerminalIds.add(turnId);
    seenTerminalKeys.add(terminalKey);
    return {
      turn_id: turnId,
      update_id: entry.update_id,
      user_id: userId,
      chat_id: chatId,
      generation,
      conversation_id: entry.conversation_id,
      algorithm: entry.algorithm,
      nonce: entry.nonce,
      auth_tag: entry.auth_tag,
      ciphertext: entry.ciphertext,
      plaintext_bytes: entry.plaintext_bytes,
    };
  });
  if (sealedTerminalBytes(terminalTurns) > MAX_SEALED_TERMINAL_BYTES) {
    throw new Error("Telegram terminal turn journal exceeded its byte limit");
  }
  const rawControlEffects = value.version >= 7 ? (value.control_effects ?? []) : [];
  if (!Array.isArray(rawControlEffects) || rawControlEffects.length > MAX_CONTROL_EFFECTS) {
    throw new Error("unsupported Telegram control effect ledger");
  }
  const seenControlUpdates = new Set();
  const controlEffects = rawControlEffects.map((entry) => {
    const effect = validateControlEffect(entry);
    if (effect.update_id < value.update_offset || seenControlUpdates.has(effect.update_id)) {
      throw new Error("invalid Telegram control effect ledger");
    }
    seenControlUpdates.add(effect.update_id);
    return effect;
  });
  return {
    version: 7,
    update_offset: value.update_offset,
    transport_offset: transportOffset,
    update_ledger: updateLedger,
    sealed_updates: sealedUpdates,
    sessions,
    response_outbox: responseOutbox,
    sealed_approvals: sealedApprovals,
    terminal_turns: terminalTurns,
    control_effects: controlEffects,
  };
}

function loadBridgeState(path = DEFAULT_STATE_PATH) {
  ensureStorage(path);
  if (!existsSync(path)) return emptyState();
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== REQUIRED_UID || info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 || info.size > MAX_STATE_BYTES) {
    throw new Error("Telegram bridge state file is unsafe");
  }
  return validateState(JSON.parse(readFileSync(path, "utf8")));
}

function writeBridgeState(state, path = DEFAULT_STATE_PATH) {
  ensureStorage(path);
  const validated = validateState(state);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new Error("Telegram bridge state exceeded its byte limit");
  }
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}`,
  );
  let fd;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    const parentFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function getSession(userId, chatId, { path = DEFAULT_STATE_PATH } = {}) {
  const canonicalUser = telegramId(userId, false);
  const canonicalChat = telegramId(chatId, true);
  const session = loadBridgeState(path).sessions.find(
    (entry) => entry.user_id === canonicalUser && entry.chat_id === canonicalChat,
  );
  return session ? { ...session } : null;
}

function ensureSession(userId, chatId, { path = DEFAULT_STATE_PATH } = {}) {
  const canonicalUser = telegramId(userId, false);
  const canonicalChat = telegramId(chatId, true);
  const state = loadBridgeState(path);
  const existing = state.sessions.find(
    (entry) => entry.user_id === canonicalUser && entry.chat_id === canonicalChat,
  );
  if (existing) return { ...existing };
  if (state.sessions.length >= MAX_SESSIONS) {
    throw new Error("Telegram session capacity is full; reset or remove a session explicitly");
  }
  const session = {
    user_id: canonicalUser,
    chat_id: canonicalChat,
    generation: 1,
    conversation_id: null,
  };
  writeBridgeState({ ...state, sessions: [...state.sessions, session] }, path);
  return { ...session };
}

function bindSessionConversation(userId, chatId, generation, conversationId, {
  path = DEFAULT_STATE_PATH,
} = {}) {
  const canonicalUser = telegramId(userId, false);
  const canonicalChat = telegramId(chatId, true);
  const canonicalGenerationValue = canonicalGeneration(generation);
  if (typeof conversationId !== "string" || !CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new Error("invalid Antigravity conversation id");
  }
  const state = loadBridgeState(path);
  const index = state.sessions.findIndex(
    (entry) => entry.user_id === canonicalUser && entry.chat_id === canonicalChat,
  );
  if (index < 0) throw new Error("Telegram session was not initialized");
  const current = state.sessions[index];
  if (current.generation !== canonicalGenerationValue) {
    throw new Error("stale Telegram session generation");
  }
  if (current.conversation_id !== null && current.conversation_id !== conversationId) {
    throw new Error("Telegram session conversation is already bound");
  }
  if (current.conversation_id === conversationId) return { ...current };
  const bound = { ...current, conversation_id: conversationId };
  state.sessions[index] = bound;
  writeBridgeState(state, path);
  return { ...bound };
}

function resetSession(userId, chatId, { path = DEFAULT_STATE_PATH } = {}) {
  const canonicalUser = telegramId(userId, false);
  const canonicalChat = telegramId(chatId, true);
  const state = loadBridgeState(path);
  const index = state.sessions.findIndex(
    (entry) => entry.user_id === canonicalUser && entry.chat_id === canonicalChat,
  );
  if (index < 0) return ensureSession(canonicalUser, canonicalChat, { path });
  const current = state.sessions[index];
  if (current.generation === Number.MAX_SAFE_INTEGER) {
    throw new Error("Telegram session generation is exhausted");
  }
  const reset = {
    ...current,
    generation: current.generation + 1,
    conversation_id: null,
  };
  state.sessions[index] = reset;
  state.response_outbox = state.response_outbox.filter((entry) =>
    entry.user_id !== canonicalUser || entry.chat_id !== canonicalChat ||
    entry.generation !== current.generation,
  );
  state.terminal_turns = state.terminal_turns.filter((entry) =>
    entry.user_id !== canonicalUser || entry.chat_id !== canonicalChat ||
    entry.generation !== current.generation,
  );
  writeBridgeState(state, path);
  return { ...reset };
}

function getControlEffect(updateId, userId, chatId, command, {
  path = DEFAULT_STATE_PATH,
} = {}) {
  if (!Number.isSafeInteger(updateId) || updateId < 0 ||
      !["cancel", "new"].includes(command)) {
    throw new Error("invalid Telegram control effect lookup");
  }
  const canonicalUser = telegramId(userId, false);
  const canonicalChat = telegramId(chatId, true);
  const effect = loadBridgeState(path).control_effects.find(
    (entry) => entry.update_id === updateId,
  );
  if (!effect) return null;
  if (effect.user_id !== canonicalUser || effect.chat_id !== canonicalChat ||
      effect.command !== command) {
    throw new Error("Telegram control update identity changed after durable registration");
  }
  return { ...effect };
}

function saveControlEffect(effect, { path = DEFAULT_STATE_PATH } = {}) {
  const canonical = validateControlEffect(effect);
  const state = loadBridgeState(path);
  const existing = state.control_effects.find(
    (entry) => entry.update_id === canonical.update_id,
  );
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(canonical)) {
      throw new Error("Telegram control effect changed after durable registration");
    }
    return { ...existing };
  }
  if (state.control_effects.length >= MAX_CONTROL_EFFECTS) {
    throw new Error("Telegram control effect ledger is full");
  }
  writeBridgeState({
    ...state,
    control_effects: [...state.control_effects, canonical],
  }, path);
  return canonical;
}

function applyNewSessionControl(effect, botToken, { path = DEFAULT_STATE_PATH } = {}) {
  const canonical = validateControlEffect(effect);
  if (canonical.command !== "new") {
    throw new Error("invalid Telegram new-session control effect");
  }
  const state = loadBridgeState(path);
  const existing = state.control_effects.find(
    (entry) => entry.update_id === canonical.update_id,
  );
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(canonical)) {
      throw new Error("Telegram control effect changed after durable registration");
    }
    const session = state.sessions.find(
      (entry) => entry.user_id === canonical.user_id && entry.chat_id === canonical.chat_id,
    );
    if (!session) throw new Error("Telegram new-session control lost its session binding");
    return { effect: { ...existing }, session: { ...session }, applied: false };
  }
  if (state.control_effects.length >= MAX_CONTROL_EFFECTS) {
    throw new Error("Telegram control effect ledger is full");
  }
  let sessionIndex = state.sessions.findIndex(
    (entry) => entry.user_id === canonical.user_id && entry.chat_id === canonical.chat_id,
  );
  if (sessionIndex < 0) {
    if (state.sessions.length >= MAX_SESSIONS) {
      throw new Error("Telegram session capacity is full; reset or remove a session explicitly");
    }
    state.sessions.push({
      user_id: canonical.user_id,
      chat_id: canonical.chat_id,
      generation: 1,
      conversation_id: null,
    });
    sessionIndex = state.sessions.length - 1;
  }
  const previous = state.sessions[sessionIndex];
  if (previous.generation === Number.MAX_SAFE_INTEGER) {
    throw new Error("Telegram session generation is exhausted");
  }
  const session = {
    ...previous,
    generation: previous.generation + 1,
    conversation_id: null,
  };
  state.sessions[sessionIndex] = session;
  state.response_outbox = state.response_outbox.filter((entry) =>
    entry.user_id !== canonical.user_id || entry.chat_id !== canonical.chat_id ||
    entry.generation !== previous.generation,
  );
  state.terminal_turns = state.terminal_turns.filter((entry) =>
    entry.user_id !== canonical.user_id || entry.chat_id !== canonical.chat_id ||
    entry.generation !== previous.generation,
  );
  if (state.sealed_approvals.length > 0) {
    const key = deriveSealedApprovalKey(botToken);
    state.sealed_approvals = state.sealed_approvals.filter((entry) => {
      const approval = decryptSealedApproval(entry, key);
      return approval.user_id !== canonical.user_id ||
        approval.chat_id !== canonical.chat_id ||
        approval.generation !== previous.generation;
    });
  }
  state.control_effects.push(canonical);
  writeBridgeState(state, path);
  return { effect: canonical, session: { ...session }, applied: true };
}

function getConversation(userId, chatId, options = {}) {
  return getSession(userId, chatId, options)?.conversation_id ?? null;
}

function setConversation(userId, chatId, conversationId, options = {}) {
  const session = ensureSession(userId, chatId, options);
  return bindSessionConversation(
    userId,
    chatId,
    session.generation,
    conversationId,
    options,
  );
}

function clearConversation(userId, chatId, { path = DEFAULT_STATE_PATH } = {}) {
  if (getSession(userId, chatId, { path }) === null) return false;
  resetSession(userId, chatId, { path });
  return true;
}

function deliveryMetadata(record) {
  return {
    delivery_id: record.delivery_id,
    update_id: record.update_id,
    user_id: record.user_id,
    chat_id: record.chat_id,
    generation: record.generation,
    stage: record.stage,
    status: record.status,
    attempt_count: record.attempt_count,
    next_chunk_index: record.next_chunk_index,
    chunk_count: record.chunk_count,
  };
}

function queueResponseDeliveriesInState(state, canonicalDeliveries, key) {
  const responseOutbox = [...state.response_outbox];
  const results = [];
  let changed = false;
  for (const canonical of canonicalDeliveries) {
    const session = state.sessions.find(
      (entry) => entry.user_id === canonical.user_id && entry.chat_id === canonical.chat_id,
    );
    if (!session) throw new Error("Telegram response delivery session was not initialized");
    if (session.generation !== canonical.generation) {
      throw new Error("stale Telegram response delivery session generation");
    }
    const deliveryKey = [
      canonical.update_id,
      canonical.user_id,
      canonical.chat_id,
      canonical.generation,
      canonical.stage,
    ].join(":");
    const byId = responseOutbox.find(
      (entry) => entry.delivery_id === canonical.delivery_id,
    );
    const byKey = responseOutbox.find((entry) => [
      entry.update_id,
      entry.user_id,
      entry.chat_id,
      entry.generation,
      entry.stage,
    ].join(":") === deliveryKey);
    const existing = byId ?? byKey;
    if (existing) {
      const decrypted = decryptSealedDelivery(existing, key);
      const sameIdentity = byId
        ? JSON.stringify({
          delivery_id: decrypted.delivery_id,
          update_id: decrypted.update_id,
          user_id: decrypted.user_id,
          chat_id: decrypted.chat_id,
          generation: decrypted.generation,
          stage: decrypted.stage,
          chunks: decrypted.chunks,
          reply_markup: decrypted.reply_markup,
        }) === JSON.stringify(canonical)
        : decrypted.update_id === canonical.update_id &&
          decrypted.user_id === canonical.user_id &&
          decrypted.chat_id === canonical.chat_id &&
          decrypted.generation === canonical.generation &&
          decrypted.stage === canonical.stage &&
          JSON.stringify(decrypted.chunks) === JSON.stringify(canonical.chunks) &&
          JSON.stringify(decrypted.reply_markup) === JSON.stringify(canonical.reply_markup);
      if (!sameIdentity) {
        throw new Error("Telegram response delivery changed after durable registration");
      }
      results.push(decrypted);
      continue;
    }
    if (responseOutbox.length >= MAX_OUTBOX_DELIVERIES) {
      throw new Error("Telegram response outbox is full");
    }
    const sealed = sealResponseDelivery(canonical, key);
    responseOutbox.push(sealed);
    results.push(decryptSealedDelivery(sealed, key));
    changed = true;
  }
  if (sealedOutboxBytes(responseOutbox) > MAX_SEALED_OUTBOX_BYTES) {
    throw new Error("Telegram response outbox exceeded its byte limit");
  }
  return { responseOutbox, results, changed };
}

function queueResponseDeliveryBatch(deliveries, botToken, {
  path = DEFAULT_STATE_PATH,
} = {}) {
  if (!Array.isArray(deliveries) || deliveries.length < 1 ||
      deliveries.length > MAX_OUTBOX_DELIVERIES) {
    throw new Error("invalid Telegram response delivery batch");
  }
  const canonicalDeliveries = deliveries.map(validateResponseDelivery);
  const state = loadBridgeState(path);
  const key = deriveSealedOutboxKey(botToken);
  const { responseOutbox, results, changed } = queueResponseDeliveriesInState(
    state,
    canonicalDeliveries,
    key,
  );
  if (changed) writeBridgeState({ ...state, response_outbox: responseOutbox }, path);
  return results;
}

function queueResponseDelivery(delivery, botToken, options = {}) {
  return queueResponseDeliveryBatch([delivery], botToken, options)[0];
}

function saveTerminalTurn(turn, botToken, { path = DEFAULT_STATE_PATH } = {}) {
  const canonical = validateTerminalTurn(turn);
  const state = loadBridgeState(path);
  const session = state.sessions.find(
    (entry) => entry.user_id === canonical.user_id && entry.chat_id === canonical.chat_id,
  );
  if (!session || session.generation !== canonical.generation ||
      session.conversation_id !== canonical.conversation_id) {
    throw new Error("stale Telegram terminal turn session binding");
  }
  const key = deriveSealedTerminalKey(botToken);
  const existing = state.terminal_turns.find((entry) =>
    entry.turn_id === canonical.turn_id || (
      entry.update_id === canonical.update_id && entry.user_id === canonical.user_id &&
      entry.chat_id === canonical.chat_id && entry.generation === canonical.generation
    ),
  );
  if (existing) {
    const decrypted = decryptSealedTerminal(existing, key);
    if (JSON.stringify(decrypted) !== JSON.stringify(canonical)) {
      throw new Error("Telegram terminal turn changed after durable registration");
    }
    return decrypted;
  }
  if (state.terminal_turns.length >= MAX_TERMINAL_TURNS) {
    throw new Error("Telegram terminal turn journal is full");
  }
  const sealed = sealTerminalTurn(canonical, key);
  const terminalTurns = [...state.terminal_turns, sealed];
  if (sealedTerminalBytes(terminalTurns) > MAX_SEALED_TERMINAL_BYTES) {
    throw new Error("Telegram terminal turn journal exceeded its byte limit");
  }
  writeBridgeState({ ...state, terminal_turns: terminalTurns }, path);
  return canonical;
}

function getTerminalTurn(turnId, botToken, { path = DEFAULT_STATE_PATH } = {}) {
  const canonicalId = canonicalDeliveryId(turnId);
  const state = loadBridgeState(path);
  const record = state.terminal_turns.find((entry) => entry.turn_id === canonicalId);
  if (!record) return null;
  return decryptSealedTerminal(record, deriveSealedTerminalKey(botToken));
}

function deleteTerminalTurn(turnId, { path = DEFAULT_STATE_PATH } = {}) {
  const canonicalId = canonicalDeliveryId(turnId);
  const state = loadBridgeState(path);
  const terminalTurns = state.terminal_turns.filter((entry) => entry.turn_id !== canonicalId);
  if (terminalTurns.length === state.terminal_turns.length) return false;
  writeBridgeState({ ...state, terminal_turns: terminalTurns }, path);
  return true;
}

function finalizeTerminalTurn(turnId, deliveries, botToken, {
  path = DEFAULT_STATE_PATH,
} = {}) {
  const canonicalId = canonicalDeliveryId(turnId);
  if (!Array.isArray(deliveries) || deliveries.length < 1 ||
      deliveries.length > MAX_OUTBOX_DELIVERIES) {
    throw new Error("invalid Telegram terminal delivery batch");
  }
  const canonicalDeliveries = deliveries.map(validateResponseDelivery);
  const state = loadBridgeState(path);
  const terminalIndex = state.terminal_turns.findIndex(
    (entry) => entry.turn_id === canonicalId,
  );
  if (terminalIndex < 0) throw new Error("Telegram terminal turn is not pending");
  const terminal = decryptSealedTerminal(
    state.terminal_turns[terminalIndex],
    deriveSealedTerminalKey(botToken),
  );
  const session = state.sessions.find(
    (entry) => entry.user_id === terminal.user_id && entry.chat_id === terminal.chat_id,
  );
  if (!session || session.generation !== terminal.generation ||
      session.conversation_id !== terminal.conversation_id ||
      !canonicalDeliveries.some((delivery) => delivery.stage === "assistant") ||
      canonicalDeliveries.some((delivery) =>
        delivery.update_id !== terminal.update_id || delivery.user_id !== terminal.user_id ||
        delivery.chat_id !== terminal.chat_id || delivery.generation !== terminal.generation)) {
    throw new Error("stale Telegram terminal turn finalization binding");
  }
  const { responseOutbox, results } = queueResponseDeliveriesInState(
    state,
    canonicalDeliveries,
    deriveSealedOutboxKey(botToken),
  );
  const terminalTurns = [...state.terminal_turns];
  terminalTurns.splice(terminalIndex, 1);
  writeBridgeState({
    ...state,
    response_outbox: responseOutbox,
    terminal_turns: terminalTurns,
  }, path);
  return results;
}

function listPendingDeliveries(botToken, { path = DEFAULT_STATE_PATH } = {}) {
  const state = loadBridgeState(path);
  if (state.response_outbox.length === 0) return [];
  const key = deriveSealedOutboxKey(botToken);
  return state.response_outbox.map((entry) => decryptSealedDelivery(entry, key));
}

function getPendingDelivery(deliveryId, botToken, { path = DEFAULT_STATE_PATH } = {}) {
  const canonicalId = canonicalDeliveryId(deliveryId);
  const state = loadBridgeState(path);
  const record = state.response_outbox.find((entry) => entry.delivery_id === canonicalId);
  if (!record) return null;
  return decryptSealedDelivery(record, deriveSealedOutboxKey(botToken));
}

function discardResponseDelivery(deliveryId, { path = DEFAULT_STATE_PATH } = {}) {
  const canonicalId = canonicalDeliveryId(deliveryId);
  const state = loadBridgeState(path);
  const responseOutbox = state.response_outbox.filter(
    (entry) => entry.delivery_id !== canonicalId,
  );
  if (responseOutbox.length === state.response_outbox.length) return false;
  writeBridgeState({ ...state, response_outbox: responseOutbox }, path);
  return true;
}

function markDeliveryAttempting(deliveryId, expectedChunkIndex, {
  path = DEFAULT_STATE_PATH,
} = {}) {
  const canonicalId = canonicalDeliveryId(deliveryId);
  if (!Number.isSafeInteger(expectedChunkIndex) || expectedChunkIndex < 0) {
    throw new Error("invalid Telegram response delivery chunk index");
  }
  const state = loadBridgeState(path);
  const index = state.response_outbox.findIndex((entry) => entry.delivery_id === canonicalId);
  if (index < 0) throw new Error("Telegram response delivery is not pending");
  const record = state.response_outbox[index];
  if (record.next_chunk_index !== expectedChunkIndex || record.status !== "pending") {
    throw new Error("Telegram response delivery is not ready for an attempt");
  }
  if (record.attempt_count === Number.MAX_SAFE_INTEGER) {
    throw new Error("Telegram response delivery attempt counter is exhausted");
  }
  state.response_outbox[index] = {
    ...record,
    status: "attempting",
    attempt_count: record.attempt_count + 1,
  };
  writeBridgeState(state, path);
  return deliveryMetadata(state.response_outbox[index]);
}

function markDeliveryPending(deliveryId, expectedChunkIndex, {
  path = DEFAULT_STATE_PATH,
} = {}) {
  const canonicalId = canonicalDeliveryId(deliveryId);
  if (!Number.isSafeInteger(expectedChunkIndex) || expectedChunkIndex < 0) {
    throw new Error("invalid Telegram response delivery chunk index");
  }
  const state = loadBridgeState(path);
  const index = state.response_outbox.findIndex((entry) => entry.delivery_id === canonicalId);
  if (index < 0) throw new Error("Telegram response delivery is not pending");
  const record = state.response_outbox[index];
  if (record.next_chunk_index !== expectedChunkIndex || record.status !== "attempting") {
    throw new Error("Telegram response delivery attempt state is stale");
  }
  state.response_outbox[index] = { ...record, status: "pending" };
  writeBridgeState(state, path);
  return deliveryMetadata(state.response_outbox[index]);
}

function markDeliveryAmbiguous(deliveryId, expectedChunkIndex, {
  path = DEFAULT_STATE_PATH,
} = {}) {
  const canonicalId = canonicalDeliveryId(deliveryId);
  if (!Number.isSafeInteger(expectedChunkIndex) || expectedChunkIndex < 0) {
    throw new Error("invalid Telegram response delivery chunk index");
  }
  const state = loadBridgeState(path);
  const index = state.response_outbox.findIndex((entry) => entry.delivery_id === canonicalId);
  if (index < 0) throw new Error("Telegram response delivery is not pending");
  const record = state.response_outbox[index];
  if (record.next_chunk_index !== expectedChunkIndex) {
    throw new Error("stale Telegram response delivery chunk index");
  }
  if (record.status === "ambiguous") return deliveryMetadata(record);
  if (!["pending", "attempting"].includes(record.status)) {
    throw new Error("Telegram response delivery attempt state is stale");
  }
  state.response_outbox[index] = { ...record, status: "ambiguous" };
  writeBridgeState(state, path);
  return deliveryMetadata(state.response_outbox[index]);
}

function recoverAttemptingDeliveries({ path = DEFAULT_STATE_PATH } = {}) {
  const state = loadBridgeState(path);
  let recovered = 0;
  state.response_outbox = state.response_outbox.map((entry) => {
    if (entry.status !== "attempting") return entry;
    recovered += 1;
    return { ...entry, status: "ambiguous" };
  });
  if (recovered > 0) writeBridgeState(state, path);
  return recovered;
}

function resetDeliveryForRetry(deliveryId, userId, chatId, generation, {
  path = DEFAULT_STATE_PATH,
} = {}) {
  const canonicalId = canonicalDeliveryId(deliveryId);
  const canonicalUser = telegramId(userId, false);
  const canonicalChat = telegramId(chatId, true);
  const canonicalGenerationValue = canonicalGeneration(generation);
  const state = loadBridgeState(path);
  const session = state.sessions.find(
    (entry) => entry.user_id === canonicalUser && entry.chat_id === canonicalChat,
  );
  if (!session || session.generation !== canonicalGenerationValue) {
    throw new Error("stale Telegram response delivery session generation");
  }
  const index = state.response_outbox.findIndex((entry) => entry.delivery_id === canonicalId);
  if (index < 0) throw new Error("Telegram response delivery is not pending");
  const record = state.response_outbox[index];
  if (record.user_id !== canonicalUser || record.chat_id !== canonicalChat ||
      record.generation !== canonicalGenerationValue || record.status === "attempting") {
    throw new Error("stale Telegram response delivery retry binding");
  }
  state.response_outbox[index] = {
    ...record,
    status: "pending",
    attempt_count: 0,
  };
  writeBridgeState(state, path);
  return deliveryMetadata(state.response_outbox[index]);
}

function acknowledgeDeliveryChunk(deliveryId, chunkIndex, {
  path = DEFAULT_STATE_PATH,
} = {}) {
  const canonicalId = canonicalDeliveryId(deliveryId);
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error("invalid Telegram response delivery chunk index");
  }
  const state = loadBridgeState(path);
  const index = state.response_outbox.findIndex((entry) => entry.delivery_id === canonicalId);
  if (index < 0) throw new Error("Telegram response delivery is not pending");
  const record = state.response_outbox[index];
  if (record.next_chunk_index !== chunkIndex) {
    throw new Error("Telegram response delivery chunks must be acknowledged in order");
  }
  if (record.status !== "attempting") {
    throw new Error("Telegram response delivery chunk was not durably attempted");
  }
  if (chunkIndex + 1 === record.chunk_count) {
    state.response_outbox.splice(index, 1);
    writeBridgeState(state, path);
    return { completed: true, next_chunk_index: null };
  }
  const nextChunkIndex = chunkIndex + 1;
  state.response_outbox[index] = {
    ...record,
    status: "pending",
    attempt_count: 0,
    next_chunk_index: nextChunkIndex,
  };
  writeBridgeState(state, path);
  return { completed: false, next_chunk_index: nextChunkIndex };
}

function savePendingApproval(approval, botToken, { path = DEFAULT_STATE_PATH } = {}) {
  const canonical = validatePendingApproval(approval);
  const state = loadBridgeState(path);
  const session = state.sessions.find(
    (entry) => entry.user_id === canonical.user_id && entry.chat_id === canonical.chat_id,
  );
  if (!session || session.generation !== canonical.generation ||
      session.conversation_id !== canonical.conversation_id) {
    throw new Error("stale Telegram pending approval session binding");
  }
  const key = deriveSealedApprovalKey(botToken);
  const existing = state.sealed_approvals.find(
    (entry) => entry.approval_id === canonical.approval_id,
  );
  if (existing) {
    const decrypted = decryptSealedApproval(existing, key);
    if (JSON.stringify(decrypted) !== JSON.stringify(canonical)) {
      throw new Error("Telegram pending approval changed after durable registration");
    }
    return decrypted;
  }
  if (state.sealed_approvals.length >= MAX_PENDING_APPROVALS) {
    throw new Error("Telegram pending approval store is full");
  }
  const sealed = sealPendingApproval(canonical, key);
  const sealedApprovals = [...state.sealed_approvals, sealed];
  if (sealedApprovalBytes(sealedApprovals) > MAX_SEALED_APPROVAL_BYTES) {
    throw new Error("Telegram pending approval store exceeded its byte limit");
  }
  writeBridgeState({ ...state, sealed_approvals: sealedApprovals }, path);
  return canonical;
}

function markPendingApprovalApproved(approvalId, updateId, botToken, {
  path = DEFAULT_STATE_PATH,
  choiceToken = null,
} = {}) {
  const canonicalId = canonicalDeliveryId(approvalId);
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    throw new Error("invalid Telegram approval update id");
  }
  const state = loadBridgeState(path);
  const index = state.sealed_approvals.findIndex(
    (entry) => entry.approval_id === canonicalId,
  );
  if (index < 0) throw new Error("Telegram pending approval is not available");
  const key = deriveSealedApprovalKey(botToken);
  const approval = decryptSealedApproval(state.sealed_approvals[index], key);
  const isChoiceApproval = Array.isArray(approval.choice_tokens);
  const selectedChoice = isChoiceApproval
    ? approval.choice_tokens.find((choice) => choice.token === choiceToken)
    : null;
  if ((isChoiceApproval && !selectedChoice) || (!isChoiceApproval && choiceToken !== null)) {
    throw new Error("Telegram approval choice is invalid");
  }
  if (approval.approved_update_id !== null) {
    if (approval.approved_update_id !== updateId ||
        (isChoiceApproval && approval.selected_choice_id !== selectedChoice.choice_id)) {
      throw new Error("Telegram approval was already consumed by another update");
    }
    return approval;
  }
  const approved = {
    ...approval,
    approved_update_id: updateId,
    ...(isChoiceApproval ? { selected_choice_id: selectedChoice.choice_id } : {}),
  };
  state.sealed_approvals[index] = sealPendingApproval(approved, key);
  writeBridgeState(state, path);
  return approved;
}

function getPendingApproval(approvalId, botToken, { path = DEFAULT_STATE_PATH } = {}) {
  const canonicalId = canonicalDeliveryId(approvalId);
  const state = loadBridgeState(path);
  const record = state.sealed_approvals.find((entry) => entry.approval_id === canonicalId);
  if (!record) return null;
  return decryptSealedApproval(record, deriveSealedApprovalKey(botToken));
}

function listPendingApprovals(botToken, { path = DEFAULT_STATE_PATH } = {}) {
  const state = loadBridgeState(path);
  if (state.sealed_approvals.length === 0) return [];
  const key = deriveSealedApprovalKey(botToken);
  return state.sealed_approvals.map((entry) => decryptSealedApproval(entry, key));
}

function deletePendingApproval(approvalId, { path = DEFAULT_STATE_PATH } = {}) {
  const canonicalId = canonicalDeliveryId(approvalId);
  const state = loadBridgeState(path);
  const sealedApprovals = state.sealed_approvals.filter(
    (entry) => entry.approval_id !== canonicalId,
  );
  if (sealedApprovals.length === state.sealed_approvals.length) return false;
  writeBridgeState({ ...state, sealed_approvals: sealedApprovals }, path);
  return true;
}

function deletePendingApprovalsForSession(userId, chatId, generation, botToken, {
  path = DEFAULT_STATE_PATH,
  includeApproved = true,
} = {}) {
  const canonicalUser = telegramId(userId, false);
  const canonicalChat = telegramId(chatId, true);
  const canonicalGenerationValue = canonicalGeneration(generation);
  if (typeof includeApproved !== "boolean") {
    throw new Error("invalid Telegram pending approval deletion policy");
  }
  const state = loadBridgeState(path);
  if (state.sealed_approvals.length === 0) return 0;
  const key = deriveSealedApprovalKey(botToken);
  const retained = [];
  let deleted = 0;
  for (const entry of state.sealed_approvals) {
    const approval = decryptSealedApproval(entry, key);
    if (approval.user_id === canonicalUser && approval.chat_id === canonicalChat &&
        approval.generation === canonicalGenerationValue &&
        (includeApproved || approval.approved_update_id === null)) {
      deleted += 1;
    } else {
      retained.push(entry);
    }
  }
  if (deleted > 0) writeBridgeState({ ...state, sealed_approvals: retained }, path);
  return deleted;
}

function cleanupPendingApprovals(botToken, {
  path = DEFAULT_STATE_PATH,
  now = Date.now(),
} = {}) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("invalid Telegram pending approval cleanup time");
  }
  const state = loadBridgeState(path);
  if (state.sealed_approvals.length === 0) {
    return { expired: 0, stale: 0, duplicate: 0 };
  }
  const key = deriveSealedApprovalKey(botToken);
  const sessions = new Map(state.sessions.map((session) => [
    `${session.user_id}:${session.chat_id}`,
    session,
  ]));
  const valid = [];
  let expired = 0;
  let stale = 0;
  for (const entry of state.sealed_approvals) {
    const approval = decryptSealedApproval(entry, key);
    const session = sessions.get(`${approval.user_id}:${approval.chat_id}`);
    if (approval.approved_update_id === null && approval.expires_at <= now) {
      expired += 1;
      continue;
    }
    if (!session || session.generation !== approval.generation ||
        session.conversation_id !== approval.conversation_id) {
      stale += 1;
      continue;
    }
    valid.push({ entry, approval });
  }
  const winnerByRequester = new Map();
  for (const candidate of valid) {
    const binding = [
      candidate.approval.user_id,
      candidate.approval.chat_id,
      candidate.approval.generation,
      candidate.approval.conversation_id,
    ].join(":");
    const existing = winnerByRequester.get(binding);
    if (!existing ||
        (candidate.approval.approved_update_id !== null &&
          existing.approval.approved_update_id === null) ||
        (candidate.approval.approved_update_id === existing.approval.approved_update_id &&
          candidate.approval.expires_at > existing.approval.expires_at) ||
        (candidate.approval.approved_update_id === existing.approval.approved_update_id &&
          candidate.approval.expires_at === existing.approval.expires_at &&
          candidate.approval.approval_id > existing.approval.approval_id)) {
      winnerByRequester.set(binding, candidate);
    }
  }
  const winners = new Set([...winnerByRequester.values()].map(
    (candidate) => candidate.approval.approval_id,
  ));
  const retained = valid
    .filter((candidate) => winners.has(candidate.approval.approval_id))
    .map((candidate) => candidate.entry);
  const duplicate = valid.length - retained.length;
  if (expired + stale + duplicate > 0) {
    writeBridgeState({ ...state, sealed_approvals: retained }, path);
  }
  return { expired, stale, duplicate };
}

function commitUpdateOffset(offset, { path = DEFAULT_STATE_PATH } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid Telegram update offset");
  const state = loadBridgeState(path);
  if (offset < state.update_offset) throw new Error("Telegram update offset cannot move backwards");
  if (offset === state.update_offset) return;
  if (state.update_ledger.some((entry) => entry.update_id < offset && !entry.acknowledged)) {
    throw new Error("Telegram update offset cannot pass an unacknowledged update");
  }
  writeBridgeState({
    ...state,
    update_offset: offset,
    transport_offset: Math.max(state.transport_offset, offset),
    update_ledger: state.update_ledger.filter((entry) => entry.update_id >= offset),
    sealed_updates: state.sealed_updates.filter((entry) => entry.update_id >= offset),
    control_effects: state.control_effects.filter((entry) => entry.update_id >= offset),
  }, path);
}

function collapseAcknowledgedPrefix(updateOffset, ledger) {
  let nextOffset = updateOffset;
  while (ledger[0]?.acknowledged === true) {
    nextOffset = ledger.shift().update_id + 1;
  }
  return nextOffset;
}

function loadSealedUpdates(botToken, { path = DEFAULT_STATE_PATH } = {}) {
  const state = loadBridgeState(path);
  if (state.sealed_updates.length === 0) return [];
  const key = deriveSealedUpdateKey(botToken);
  return state.sealed_updates.map((entry) => decryptSealedUpdate(entry, key));
}

function registerSealedUpdateBatch(records, botToken, { path = DEFAULT_STATE_PATH } = {}) {
  if (!Array.isArray(records) || records.length > 100) {
    throw new Error("invalid Telegram sealed update batch");
  }
  let previousUpdateId = -1;
  const canonicalRecords = records.map((record) => {
    if (!hasExactKeys(record, ["update_id", "normalized"]) ||
        !Number.isSafeInteger(record.update_id) || record.update_id < 0 ||
        record.update_id <= previousUpdateId) {
      throw new Error("invalid Telegram sealed update batch");
    }
    previousUpdateId = record.update_id;
    const normalized = record.normalized === null
      ? null
      : validateNormalizedUpdate(record.normalized);
    if (normalized !== null && normalized.updateId !== record.update_id) {
      throw new Error("Telegram update envelope and normalized identity differ");
    }
    return { update_id: record.update_id, normalized };
  });

  const state = loadBridgeState(path);
  const key = deriveSealedUpdateKey(botToken);
  const ledger = new Map(state.update_ledger.map((entry) => [entry.update_id, entry.acknowledged]));
  const sealed = new Map(state.sealed_updates.map((entry) => [entry.update_id, entry]));
  const decrypted = new Map();
  for (const entry of state.sealed_updates) {
    decrypted.set(entry.update_id, decryptSealedUpdate(entry, key));
  }

  let transportOffset = state.transport_offset;
  for (const record of canonicalRecords) {
    const { update_id: updateId, normalized } = record;
    if (updateId < state.update_offset) continue;
    const acknowledged = ledger.get(updateId) === true;
    if (normalized === null) {
      if (sealed.has(updateId)) {
        throw new Error("Telegram update normalization changed after durable registration");
      }
      if (!ledger.has(updateId)) ledger.set(updateId, true);
      else if (!acknowledged) ledger.set(updateId, true);
    } else if (!acknowledged) {
      if (!ledger.has(updateId)) ledger.set(updateId, false);
      if (sealed.has(updateId)) {
        if (JSON.stringify(decrypted.get(updateId)) !== JSON.stringify(normalized)) {
          throw new Error("Telegram update changed after durable registration");
        }
      } else {
        const encrypted = sealNormalizedUpdate(normalized, key);
        sealed.set(updateId, encrypted);
        decrypted.set(updateId, normalized);
      }
    }
    transportOffset = Math.max(transportOffset, updateId + 1);
  }

  const updateLedger = [...ledger]
    .sort(([left], [right]) => left - right)
    .map(([updateId, acknowledged]) => ({ update_id: updateId, acknowledged }));
  if (updateLedger.length > MAX_UPDATE_LEDGER_ENTRIES) {
    throw new Error("Telegram update acknowledgement ledger is full");
  }
  const sealedUpdates = [...sealed.values()].sort(
    (left, right) => left.update_id - right.update_id,
  );
  if (sealedUpdates.length > MAX_SEALED_UPDATE_ENTRIES) {
    throw new Error("Telegram sealed update spool is full");
  }
  if (sealedSpoolBytes(sealedUpdates) > MAX_SEALED_SPOOL_BYTES) {
    throw new Error("Telegram sealed update spool exceeded its byte limit");
  }
  const updateOffset = collapseAcknowledgedPrefix(state.update_offset, updateLedger);
  transportOffset = Math.max(transportOffset, updateOffset);
  const pendingIds = new Set(updateLedger.filter((entry) => !entry.acknowledged)
    .map((entry) => entry.update_id));
  const retainedSealed = sealedUpdates.filter((entry) => pendingIds.has(entry.update_id));
  writeBridgeState({
    ...state,
    update_offset: updateOffset,
    transport_offset: transportOffset,
    update_ledger: updateLedger,
    sealed_updates: retainedSealed,
    control_effects: state.control_effects.filter((entry) => entry.update_id >= updateOffset),
  }, path);
  return {
    update_offset: updateOffset,
    transport_offset: transportOffset,
    entries: canonicalRecords.map((record) => ({
      update_id: record.update_id,
      acknowledged: record.update_id < updateOffset ||
        updateLedger.find((entry) => entry.update_id === record.update_id)?.acknowledged === true,
    })),
    updates: canonicalRecords
      .filter((record) => record.normalized !== null && pendingIds.has(record.update_id))
      .map((record) => decrypted.get(record.update_id)),
  };
}

function acknowledgeUpdate(updateId, { path = DEFAULT_STATE_PATH } = {}) {
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    throw new Error("invalid Telegram update acknowledgement");
  }
  const state = loadBridgeState(path);
  if (updateId < state.update_offset) return state.update_offset;
  const ledger = state.update_ledger.map((entry) => ({ ...entry }));
  const target = ledger.find((entry) => entry.update_id === updateId);
  if (!target) throw new Error("Telegram update was not durably registered");
  target.acknowledged = true;
  const updateOffset = collapseAcknowledgedPrefix(state.update_offset, ledger);
  writeBridgeState({
    ...state,
    update_offset: updateOffset,
    transport_offset: Math.max(state.transport_offset, updateOffset),
    update_ledger: ledger,
    sealed_updates: state.sealed_updates.filter((entry) => entry.update_id !== updateId),
    control_effects: state.control_effects.filter((entry) => entry.update_id !== updateId),
  }, path);
  return updateOffset;
}

export {
  DEFAULT_STATE_PATH,
  MAX_CONTROL_EFFECTS,
  MAX_OUTBOX_DELIVERIES,
  MAX_PENDING_APPROVALS,
  MAX_SEALED_SPOOL_BYTES,
  MAX_SEALED_UPDATE_ENTRIES,
  MAX_SESSIONS,
  MAX_TERMINAL_TURNS,
  MAX_UPDATE_LEDGER_ENTRIES,
  acknowledgeDeliveryChunk,
  acknowledgeUpdate,
  applyNewSessionControl,
  bindSessionConversation,
  cleanupPendingApprovals,
  clearConversation,
  commitUpdateOffset,
  deletePendingApproval,
  deletePendingApprovalsForSession,
  discardResponseDelivery,
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
  validateNormalizedUpdate,
};
