import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const OPTIONS_PATH = "/data/options.json";
const DATA_DIR = "/data/antigravity";
const AUTHORIZED_CHATS_PATH = join(DATA_DIR, "telegram_authorized_chats.json");
const PAIR_INFO_DATA_PATH = join(DATA_DIR, "telegram_pair_info.json");
const PAIR_INFO_PATH = "/run/antigravity-ha/telegram_pair_info.json";

// Map to hold pending interactive approval requests: approvalId -> { sessionName, chatId, expireTimer }
const pendingApprovals = new Map();

function loadOptions() {
  try {
    if (!existsSync(OPTIONS_PATH)) return {};
    return JSON.parse(readFileSync(OPTIONS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function loadAuthorizedChats(staticAllowed = []) {
  const authorized = new Set(staticAllowed.map((id) => String(id).trim()));
  try {
    if (existsSync(AUTHORIZED_CHATS_PATH)) {
      const saved = JSON.parse(readFileSync(AUTHORIZED_CHATS_PATH, "utf8"));
      if (Array.isArray(saved)) {
        saved.forEach((id) => authorized.add(String(id).trim()));
      }
    }
  } catch (err) {
    console.error("[Telegram Bridge] Error reading authorized chats:", err.message);
  }
  return authorized;
}

function saveAuthorizedChats(authorizedSet) {
  try {
    const list = Array.from(authorizedSet);
    writeFileSync(AUTHORIZED_CHATS_PATH, JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    console.error("[Telegram Bridge] Error saving authorized chats:", err.message);
  }
}

function loadOrGeneratePairingSecrets() {
  try {
    if (existsSync(PAIR_INFO_DATA_PATH)) {
      const saved = JSON.parse(readFileSync(PAIR_INFO_DATA_PATH, "utf8"));
      if (saved.pair_token && saved.pin_code) {
        return { pairToken: saved.pair_token, pinCode: saved.pin_code };
      }
    }
  } catch (_) {}

  const num = Math.floor(100000 + Math.random() * 900000);
  const secrets = {
    pairToken: "PAIR_" + randomBytes(4).toString("hex"),
    pinCode: String(num),
  };
  try {
    writeFileSync(
      PAIR_INFO_DATA_PATH,
      JSON.stringify({ pair_token: secrets.pairToken, pin_code: secrets.pinCode }, null, 2),
      "utf8"
    );
  } catch (_) {}
  return secrets;
}

async function telegramApi(botToken, method, body = {}, timeoutMs = 30000, retries = 3) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Telegram API HTTP ${response.status}: ${text}`);
      }
      const data = await response.json();
      if (!data.ok) {
        throw new Error(`Telegram API Error: ${data.description}`);
      }
      return data.result;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries && (err.name === "AbortError" || (err.message && err.message.includes("fetch failed")))) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Strips ANSI terminal escape sequences, cursor movements, and line resets.
 */
function stripAnsiCodes(text) {
  if (!text) return "";
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07\x1B]*[\x07\x1B]/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

/**
 * Splits markdown text into safe chunks under 3900 characters while preserving code block boundaries.
 */
function chunkMarkdownSafe(text, maxLen = 3900) {
  if (!text || text.length <= maxLen) return [text || "*(답변 없음)*"];

  const chunks = [];
  let remaining = text;
  let openCodeLang = null;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      let finalChunk = remaining;
      if (openCodeLang) {
        finalChunk = "```" + openCodeLang + "\n" + finalChunk;
      }
      chunks.push(finalChunk);
      break;
    }

    let splitIndex = maxLen;
    const lastDoubleNewline = remaining.lastIndexOf("\n\n", maxLen);
    const lastSingleNewline = remaining.lastIndexOf("\n", maxLen);

    if (lastDoubleNewline > maxLen * 0.4) {
      splitIndex = lastDoubleNewline + 2;
    } else if (lastSingleNewline > maxLen * 0.3) {
      splitIndex = lastSingleNewline + 1;
    }

    let currentChunk = remaining.slice(0, splitIndex);
    remaining = remaining.slice(splitIndex);

    if (openCodeLang) {
      currentChunk = "```" + openCodeLang + "\n" + currentChunk;
      openCodeLang = null;
    }

    const codeBlockMatches = [...currentChunk.matchAll(/```(\w*)/g)];
    let isBlockOpen = false;
    let currentBlockLang = "";

    for (const match of codeBlockMatches) {
      if (!isBlockOpen) {
        isBlockOpen = true;
        currentBlockLang = match[1] || "";
      } else {
        isBlockOpen = false;
      }
    }

    if (isBlockOpen) {
      currentChunk += "\n```";
      openCodeLang = currentBlockLang;
    }

    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Sends markdown text to Telegram with safe splitting and rate limiting.
 */
async function sendTelegramMessage(botToken, chatId, text, options = {}) {
  const chunks = chunkMarkdownSafe(text);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const body = {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: options.parse_mode || undefined,
      reply_markup: isLast ? options.reply_markup : undefined,
    };
    await telegramApi(botToken, "sendMessage", body);
    if (!isLast) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/**
 * Filters out thoughts, tool call telemetry, CLI headers, banners, prompt echoes, and turn history.
 * Extracts strictly the assistant's final response content for the current prompt.
 */
function cleanAiOutput(rawOutput, promptText = "") {
  if (!rawOutput) return "";
  let text = stripAnsiCodes(rawOutput);

  // 1. If turn separators exist (──────────), extract the last meaningful turn
  const turnSeparatorRegex = /^[─━\-_=]{10,}$/m;
  if (turnSeparatorRegex.test(text)) {
    const turns = text.split(/^[─━\-_=]{10,}$/m);
    for (let i = turns.length - 1; i >= 0; i--) {
      const turnContent = turns[i].trim();
      if (turnContent.length > 0) {
        text = turnContent;
        break;
      }
    }
  }

  // 2. Remove thought blocks
  text = text.replace(/<thought>[\s\S]*?<\/thought>/gi, "");
  text = text.replace(/^▸\s*Thought for\s+\d+s.*$/gim, "");

  // 3. Line-by-line filtering of tools, banners, prompt echo, thoughts, and expand hints
  const lines = text.split("\n");
  const filtered = [];
  let inPrompt = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      if (!inPrompt) filtered.push("");
      continue;
    }

    // Skip prompt echo (starts with >)
    if (trimmed.startsWith(">")) {
      inPrompt = true;
      continue;
    }

    if (inPrompt) {
      // If we encounter a tool call, thought, or clear assistant response start, exit prompt echo mode
      if (
        trimmed.startsWith("●") ||
        trimmed.startsWith("•") ||
        trimmed.startsWith("▸") ||
        trimmed.startsWith("<thought>") ||
        trimmed.startsWith("###") ||
        /^(네|안녕하세요|Home Assistant|확인|시스템|요청하신|죄송|결과|감사|어떤|Hello|Yes|Sure|Here)/i.test(trimmed)
      ) {
        inPrompt = false;
      } else {
        // Still inside multi-line prompt echo
        continue;
      }
    }

    // Filter banners and CLI headers
    if (
      /^[▄▀\s]{4,}$/.test(trimmed) ||
      /Antigravity CLI\s+[\d.]+/i.test(trimmed) ||
      /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(trimmed) ||
      /^\/config\s*$/.test(trimmed) ||
      /^(Loaded configuration|Starting Antigravity|Session initialized|Google Antigravity|\? for shortcuts)/i.test(trimmed) ||
      /^\[antigravi\d+:.*\]\s*$/i.test(trimmed)
    ) {
      continue;
    }

    // Filter tool invocations
    if (
      /^[●•]\s*(Bash|Read|Write|ListDir|Search|Create|ManageTask|Edit|View|Tool|Playwright|Memory)\b/i.test(trimmed) ||
      /^(Running|Executing|Calling|Reading|Writing|Editing|Searching|Tool)\s+[a-zA-Z0-9_\-./]+\b/i.test(trimmed) ||
      /^\[(Tool|Bash|Command|File|Memory|Playwright)\].*$/i.test(trimmed)
    ) {
      continue;
    }

    // Filter thought status lines
    if (/^\s*(Inspecting|Checking|Analyzing|Confirming|Clarifying|Identifying|Exploring|Verifying|Investigating|Searching)\s+[A-Za-z0-9\s"_-]+$/i.test(trimmed)) {
      continue;
    }

    // Skip lone expand hints or tool argument tails
    if (trimmed === "(ctrl+o to expand)") continue;
    if (/^[\/~a-zA-Z0-9_.-]+\.\.\.\)?$/.test(trimmed)) continue;

    filtered.push(line.replace(/\(ctrl\+o to expand\)/gi, "").trimEnd());
  }

  text = filtered.join("\n");
  text = text.replace(/^[>\s:-]+/, "").trim();
  text = text.replace(/\n{3,}/g, "\n\n");

  return text || "요청하신 작업을 완료했습니다.";
}

/**
 * Extracts content surrounded by explicit start and end boundary markers.
 */
function extractResponseByMarker(text, marker) {
  if (!text || !marker) return null;
  const startTag = `<<<AGY_OUT_START_${marker}>>>`;
  const endTag = `<<<AGY_OUT_END_${marker}>>>`;
  const startIdx = text.indexOf(startTag);
  if (startIdx === -1) return null;
  const afterStart = text.slice(startIdx + startTag.length);
  const endIdx = afterStart.indexOf(endTag);
  if (endIdx !== -1) {
    const extracted = afterStart.slice(0, endIdx).trim();
    if (extracted) return cleanAiOutput(extracted);
  } else {
    const extracted = afterStart.trim();
    if (extracted) return cleanAiOutput(extracted);
  }
  return null;
}

/**
 * Hermes-style Heartbeat & Typing Manager.
 * Sends 'typing' chat action every 4 seconds and periodic progress updates (first after 10s).
 */
class HeartbeatManager {
  constructor(botToken, chatId) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.typingTimer = null;
    this.progressTimer = null;
    this.startTime = Date.now();
    this.paused = false;
  }

  start() {
    this.startTime = Date.now();
    this.sendTyping();

    // Telegram typing indicator expires after 5s; re-issue every 4s
    this.typingTimer = setInterval(() => {
      if (!this.paused) {
        this.sendTyping();
      }
    }, 4000);

    // Initial progress notice after 10s, then every 30s thereafter
    const scheduleProgress = (delayMs) => {
      this.progressTimer = setTimeout(async () => {
        if (!this.paused) {
          const elapsedSec = Math.round((Date.now() - this.startTime) / 1000);
          try {
            await telegramApi(this.botToken, "sendMessage", {
              chat_id: this.chatId,
              text: `⏳ AI 에이전트가 답변을 생성 중입니다... (${elapsedSec}초 경과)`,
            });
          } catch (_) {}
          scheduleProgress(30000);
        }
      }, delayMs);
    };

    scheduleProgress(10000);
  }

  async sendTyping() {
    try {
      await telegramApi(this.botToken, "sendChatAction", {
        chat_id: this.chatId,
        action: "typing",
      });
    } catch (_) {}
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.sendTyping();
  }

  stop() {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
  }
}

/**
 * Executes a prompt in a dedicated detached tmux PTY session with full environment sourcing.
 * Uses a temporary runner script to eliminate shell string-escaping issues,
 * handles stdout capture, thought stripping, typing heartbeat, and interactive inline approvals.
 */
async function runAntigravityPrompt(botToken, chatId, promptText) {
  const options = loadOptions();
  const approvalPolicy = (options.antigravity_approval_policy || "on-request").trim();
  const isFullAuto = approvalPolicy === "never";

  const heartbeat = new HeartbeatManager(botToken, chatId);
  heartbeat.start();

  const tempSession = `agy-tg-${randomBytes(3).toString("hex")}`;
  const marker = randomBytes(4).toString("hex");
  const startMarker = `<<<AGY_OUT_START_${marker}>>>`;
  const endMarker = `<<<AGY_OUT_END_${marker}>>>`;
  const scriptPath = `/tmp/${tempSession}.sh`;

  // Create clean runner script to avoid shell escaping / quote mangling issues
  const scriptContent = `#!/usr/bin/env bash
set -e
. /usr/local/lib/antigravity-ha/environment.sh
cd /config
echo '${startMarker}'
antigravity -c approval_policy="never" -c sandbox_mode="danger-full-access" -p ${JSON.stringify(promptText)} || true
echo '${endMarker}'
`;

  try {
    writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

    console.log(`[Telegram Bridge] Spawning detached PTY session '${tempSession}'...`);
    await execAsync(`tmux new-session -d -s ${tempSession} -c /config "${scriptPath}"`);
    await execAsync(`tmux set-option -t ${tempSession} remain-on-exit on 2>/dev/null || true`);

    let activeApprovalId = null;

    // Poll until tmux session finishes or confirmation prompt is detected (up to 120s)
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1000));

      const { stdout: deadCheck } = await execAsync(
        `tmux display-message -p -t ${tempSession} "#{pane_dead}" 2>/dev/null || echo "1"`
      );

      if (deadCheck.trim() === "1") {
        break;
      }

      // Check for interactive approval prompt if not in full-auto mode
      if (!isFullAuto && !activeApprovalId) {
        try {
          const { stdout: paneContent } = await execAsync(
            `tmux capture-pane -p -t ${tempSession} -S -20 2>/dev/null || true`
          );
          const cleanPane = stripAnsiCodes(paneContent);

          if (/\[Y\/n\]|\[y\/N\]|approve\?|allow this action\?|Do you want to continue/i.test(cleanPane)) {
            heartbeat.pause();
            const approvalId = randomBytes(4).toString("hex");
            activeApprovalId = approvalId;

            const expireTimer = setTimeout(async () => {
              if (pendingApprovals.has(approvalId)) {
                try {
                  await execAsync(`tmux send-keys -t ${tempSession} "N" Enter 2>/dev/null || true`);
                } catch (_) {}
                pendingApprovals.delete(approvalId);
                activeApprovalId = null;
                heartbeat.resume();
              }
            }, 180000);

            pendingApprovals.set(approvalId, {
              sessionName: tempSession,
              chatId,
              expireTimer,
              onDecision: () => {
                activeApprovalId = null;
                heartbeat.resume();
              },
            });

            const promptSnippet = cleanPane.split("\n").filter((l) => l.trim()).slice(-3).join("\n");

            telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text: `🔐 *AI 에이전트 승인 요청*\n\n\`\`\`\n${promptSnippet}\n\`\`\`\n이 작업을 승인하시겠습니까?`,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "✅ 승인 (Approve)", callback_data: `appr:${approvalId}` },
                    { text: "❌ 거부 (Deny)", callback_data: `deny:${approvalId}` },
                  ],
                ],
              },
            }).catch((err) => {
              console.error("[Telegram Bridge] Error sending approval prompt:", err.message);
            });
          }
        } catch (_) {}
      }
    }

    heartbeat.stop();

    // Capture complete output from tmux pane scrollback buffer
    let rawOutput = "";
    try {
      const { stdout: pane } = await execAsync(`tmux capture-pane -p -t ${tempSession} -S -3000 2>/dev/null || true`);
      rawOutput = pane;
    } catch (_) {}

    try {
      if (existsSync(scriptPath)) unlinkSync(scriptPath);
    } catch (_) {}

    // Clean up temporary session
    try {
      await execAsync(`tmux kill-session -t ${tempSession} 2>/dev/null || true`);
    } catch (_) {}

    if (rawOutput) {
      // 1. Try marker-based extraction first
      const markerResult = extractResponseByMarker(rawOutput, marker);
      if (markerResult && markerResult.length > 0) return markerResult;

      // 2. Fall back to cleanAiOutput parser
      const cleanResponse = cleanAiOutput(rawOutput, promptText);
      if (cleanResponse && cleanResponse.length > 0) return cleanResponse;
    }
  } catch (err) {
    heartbeat.stop();
    console.error(`[Telegram Bridge] Execution error:`, err.message);
    try {
      if (existsSync(scriptPath)) unlinkSync(scriptPath);
    } catch (_) {}
    try {
      await execAsync(`tmux kill-session -t ${tempSession} 2>/dev/null || true`);
    } catch (_) {}
    return `[Antigravity Execution Error: ${err.message}]`;
  }

  return "Antigravity AI 에이전트가 작업을 완료했습니다.";
}

/**
 * Handles Telegram Inline Keyboard button clicks for approvals via tmux send-keys.
 */
async function handleCallbackQuery(botToken, callbackQuery) {
  const queryId = callbackQuery.id;
  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  const [action, approvalId] = data.split(":");
  if (!approvalId || !pendingApprovals.has(approvalId)) {
    await telegramApi(botToken, "answerCallbackQuery", {
      callback_query_id: queryId,
      text: "이미 처리되었거나 만료된 승인 요청입니다.",
      show_alert: true,
    });
    return;
  }

  const { sessionName, expireTimer, onDecision } = pendingApprovals.get(approvalId);
  clearTimeout(expireTimer);
  pendingApprovals.delete(approvalId);

  const isApproved = action === "appr";
  const key = isApproved ? "Y" : "N";
  try {
    await execAsync(`tmux send-keys -t ${sessionName} "${key}" Enter 2>/dev/null || true`);
  } catch (err) {
    console.error("[Telegram Bridge] Error sending decision key to tmux:", err.message);
  }

  if (onDecision) onDecision();

  await telegramApi(botToken, "answerCallbackQuery", {
    callback_query_id: queryId,
    text: isApproved ? "✅ 작업이 승인되었습니다." : "❌ 작업이 거부되었습니다.",
  });

  // Edit original approval message to reflect final decision
  if (chatId && messageId) {
    try {
      await telegramApi(botToken, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: isApproved
          ? "✅ *승인 완료*: AI 에이전트가 작업을 계속 진행합니다."
          : "❌ *거부 완료*: 해당 작업이 취소되었습니다.",
        parse_mode: "Markdown",
      });
    } catch (_) {}
  }
}


async function main() {
  const options = loadOptions();
  if (!options.telegram_enabled) {
    console.log("[Telegram Bridge] Disabled in options (telegram_enabled: false). Exiting.");
    process.exit(0);
  }

  const botToken = (options.telegram_bot_token || "").trim();
  if (!botToken) {
    console.error("[Telegram Bridge] ERROR: telegram_bot_token is missing in add-on options.");
    process.exit(1);
  }

  const staticAllowed = options.telegram_allowed_chat_ids || [];
  const authorizedChats = loadAuthorizedChats(staticAllowed);

  // Clear any existing Webhook to ensure getUpdates Long Polling works flawlessly
  try {
    await telegramApi(botToken, "deleteWebhook", { drop_pending_updates: false }, 15000, 2);
  } catch (err) {
    console.warn("[Telegram Bridge] Webhook clear notice:", err.message);
  }

  let botInfo;
  try {
    botInfo = await telegramApi(botToken, "getMe", {}, 15000, 3);
    console.log(`[Telegram Bridge] Connected to Telegram Bot: @${botInfo.username} (${botInfo.first_name})`);
  } catch (err) {
    console.error("[Telegram Bridge] ERROR connecting to Telegram Bot:", err.message);
    process.exit(1);
  }

  const { pairToken, pinCode } = loadOrGeneratePairingSecrets();
  const deepLinkUrl = `https://t.me/${botInfo.username}?start=${pairToken}`;

  console.log("==========================================================");
  console.log(" 📲 Antigravity Telegram Bot Pair Info");
  console.log("==========================================================");
  console.log(`🔗 1-Click Deep Link: ${deepLinkUrl}`);
  console.log(`🔑 6-Digit Pairing PIN: ${pinCode.slice(0, 3)}-${pinCode.slice(3)}`);
  console.log(`👥 Currently Authorized Chats: ${Array.from(authorizedChats).join(", ") || "None"}`);
  console.log("==========================================================");

  try {
    writeFileSync(
      PAIR_INFO_PATH,
      JSON.stringify(
        {
          bot_username: botInfo.username,
          deep_link: deepLinkUrl,
          pair_token: pairToken,
          pin_code: pinCode,
          authorized_chats: Array.from(authorizedChats),
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (_) {}

  let offset = 0;

  while (true) {
    try {
      const updates = await telegramApi(
        botToken,
        "getUpdates",
        {
          offset,
          timeout: 15,
        },
        30000,
        1
      );

      for (const update of updates) {
        offset = update.update_id + 1;

        // 1. Handle Inline Keyboard callback queries
        if (update.callback_query) {
          await handleCallbackQuery(botToken, update.callback_query);
          continue;
        }

        if (!update.message || !update.message.text) continue;

        const chatId = String(update.message.chat.id);
        const text = update.message.text.trim();
        const isAuthorized = authorizedChats.has(chatId);

        console.log(`[Telegram Bridge] Message from Chat ID ${chatId}: "${text}"`);

        // Method 1: 1-Click Deep Link token match (/start PAIR_xxxx)
        if (text === `/start ${pairToken}` || text.includes(pairToken)) {
          authorizedChats.add(chatId);
          saveAuthorizedChats(authorizedChats);
          console.log(`[Telegram Bridge] 🎉 Authorized new user Chat ID ${chatId} via Deep Link!`);
          await sendTelegramMessage(
            botToken,
            chatId,
            `🎉 Antigravity HA와 성공적으로 연동되었습니다!\n\n질문이나 명령을 전송하면 Antigravity AI 에이전트가 처리합니다.\n(도움말: /help)`
          );
          continue;
        }

        // Method 2: 6-Digit PIN Code match
        const cleanText = text.replace(/[^0-9]/g, "");
        const cleanPin = pinCode.replace(/[^0-9]/g, "");
        if (cleanText === cleanPin || text.includes(pinCode) || text.includes(`${pinCode.slice(0, 3)}-${pinCode.slice(3)}`)) {
          authorizedChats.add(chatId);
          saveAuthorizedChats(authorizedChats);
          console.log(`[Telegram Bridge] 🎉 Authorized new user Chat ID ${chatId} via PIN code!`);
          await sendTelegramMessage(
            botToken,
            chatId,
            `🎉 핀 코드 인증 완료! Antigravity HA와 성공적으로 연동되었습니다.\n\n질문이나 명령을 전송해주세요.\n(도움말: /help)`
          );
          continue;
        }

        // Method 3: Un-authorized user check
        if (!isAuthorized) {
          console.log(`[Telegram Bridge] Unauthorized attempt from Chat ID ${chatId}`);
          await sendTelegramMessage(
            botToken,
            chatId,
            `🔒 Antigravity HA 인증이 필요합니다.\n\n` +
              `아래 3가지 방법 중 하나로 연동하실 수 있습니다:\n\n` +
              `1️⃣ 1-Click 딥링크 클릭:\n${deepLinkUrl}\n\n` +
              `2️⃣ 핀 코드 입력:\n이 대화창에 핀 번호를 전송하세요: ${pinCode.slice(0, 3)}-${pinCode.slice(3)}\n\n` +
              `3️⃣ HA 애드온 설정에서 Chat ID 등록:\nChat ID: ${chatId}`
          );
          continue;
        }

        // Handle commands for authorized users
        if (text === "/start" || text === "/help") {
          await sendTelegramMessage(
            botToken,
            chatId,
            `🤖 *Antigravity HA 에이전트 도우미*\n\n` +
              `사용법:\n` +
              `- 자연어로 질문이나 명령을 보내시면 Antigravity AI 에이전트가 분석 및 실행합니다.\n` +
              `- /status : 시스템 및 HA 설정 검사\n` +
              `- /unpair : 이 계정의 텔레그램 연동 해제`
          );
          continue;
        }

        if (text === "/status") {
          console.log(`[Telegram Bridge] Processing /status check for Chat ID ${chatId}...`);
          (async () => {
            try {
              const statusOutput = await runAntigravityPrompt(
                botToken,
                chatId,
                "ha-config-check 결과를 확인하고 Home Assistant 시스템 상태를 간략히 요약해줘."
              );
              await sendTelegramMessage(botToken, chatId, statusOutput);
            } catch (err) {
              await sendTelegramMessage(botToken, chatId, `⚠️ 상태 검사 실패: ${err.message}`);
            }
          })();
          continue;
        }

        if (text === "/unpair") {
          authorizedChats.delete(chatId);
          saveAuthorizedChats(authorizedChats);
          console.log(`[Telegram Bridge] Unpaired Chat ID ${chatId}`);
          await sendTelegramMessage(botToken, chatId, "👋 Antigravity HA 연동이 해제되었습니다.");
          continue;
        }

        // Process AI prompt asynchronously
        console.log(`[Telegram Bridge] Processing AI prompt for Chat ID ${chatId}: "${text}"`);
        (async () => {
          try {
            const aiResponse = await runAntigravityPrompt(botToken, chatId, text);
            console.log(`[Telegram Bridge] AI response generated (${aiResponse.length} chars), sending to Telegram...`);
            await sendTelegramMessage(botToken, chatId, aiResponse);
          } catch (err) {
            console.error(`[Telegram Bridge] AI execution error:`, err.stack || err.message);
            try {
              await sendTelegramMessage(botToken, chatId, `⚠️ 처리 중 오류가 발생했습니다: ${err.message}`);
            } catch (_) {}
          }
        })();
      }
    } catch (err) {
      if (err.name === "AbortError" || (err.message && err.message.includes("fetch failed"))) {
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        console.error("[Telegram Bridge] Polling notice:", err.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}

main().catch((err) => {
  console.error("[Telegram Bridge] Fatal error:", err);
  process.exit(1);
});
