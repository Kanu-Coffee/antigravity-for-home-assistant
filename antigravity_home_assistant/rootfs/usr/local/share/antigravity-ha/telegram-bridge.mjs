import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OPTIONS_PATH = "/data/options.json";
const DATA_DIR = "/data/antigravity";
const AUTHORIZED_CHATS_PATH = join(DATA_DIR, "telegram_authorized_chats.json");
const PAIR_INFO_PATH = "/run/antigravity-ha/telegram_pair_info.json";

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

function generatePinCode() {
  const num = Math.floor(100000 + Math.random() * 900000);
  return String(num);
}

function generatePairToken() {
  return "PAIR_" + randomBytes(4).toString("hex");
}

async function telegramApi(botToken, method, body = {}, timeoutMs = 30000) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
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
    throw err;
  }
}

async function sendTelegramMessage(botToken, chatId, text) {
  const maxLen = 4000;
  if (text.length <= maxLen) {
    await telegramApi(botToken, "sendMessage", {
      chat_id: chatId,
      text,
    });
    return;
  }

  // Split long messages by paragraphs or length
  for (let i = 0; i < text.length; i += maxLen) {
    const chunk = text.slice(i, i + maxLen);
    await telegramApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: chunk,
    });
  }
}

async function runAntigravityPrompt(promptText) {
  return new Promise((resolve) => {
    const child = spawn("antigravity", ["-p", promptText], {
      cwd: "/config",
      env: { ...process.env, HOME: "/data/home" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else if (stdout.trim()) {
        resolve(stdout.trim());
      } else if (stderr.trim()) {
        resolve(`[Error exit code ${code}]: ${stderr.trim()}`);
      } else {
        resolve(`[Antigravity completed with code ${code}]`);
      }
    });

    child.on("error", (err) => {
      resolve(`[Failed to launch Antigravity: ${err.message}]`);
    });
  });
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

  let botInfo;
  try {
    botInfo = await telegramApi(botToken, "getMe", {}, 15000);
    console.log(`[Telegram Bridge] Connected to Telegram Bot: @${botInfo.username} (${botInfo.first_name})`);
  } catch (err) {
    console.error("[Telegram Bridge] ERROR connecting to Telegram Bot:", err.message);
    process.exit(1);
  }

  const pairToken = generatePairToken();
  const pinCode = generatePinCode();
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
  } catch (e) {
    // Ignore runtime dir write error
  }

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
        30000
      );

      for (const update of updates) {
        offset = update.update_id + 1;
        if (!update.message || !update.message.text) continue;

        const chatId = String(update.message.chat.id);
        const text = update.message.text.trim();
        const isAuthorized = authorizedChats.has(chatId);

        // Method 1: 1-Click Deep Link token match (/start PAIR_xxxx)
        if (text === `/start ${pairToken}` || text.startsWith(`/start ${pairToken}`)) {
          authorizedChats.add(chatId);
          saveAuthorizedChats(authorizedChats);
          await sendTelegramMessage(
            botToken,
            chatId,
            `🎉 Antigravity HA와 성공적으로 연동되었습니다!\n\n질문이나 명령을 전송하면 Antigravity AI 에이전트가 처리합니다.\n(도움말: /help)`
          );
          continue;
        }

        // Method 2: 6-Digit PIN Code match
        const cleanText = text.replace(/[^0-9]/g, "");
        if (cleanText === pinCode || text === `/pair ${pinCode}`) {
          authorizedChats.add(chatId);
          saveAuthorizedChats(authorizedChats);
          await sendTelegramMessage(
            botToken,
            chatId,
            `🎉 핀 코드 인증 완료! Antigravity HA와 성공적으로 연동되었습니다.\n\n질문이나 명령을 전송해주세요.\n(도움말: /help)`
          );
          continue;
        }

        // Method 3: Un-authorized user check
        if (!isAuthorized) {
          await sendTelegramMessage(
            botToken,
            chatId,
            `🔒 Antigravity HA 인증이 필요합니다.\n\n` +
              `아래 3가지 방법 중 하나로 연동하실 수 있습니다:\n\n` +
              `1️⃣ 1-Click 딥링크 클릭:\n${deepLinkUrl}\n\n` +
              `2️⃣ 핀 코드 입력:\n하단의 핀 번호를 이 차트에 입력하세요: ${pinCode.slice(0, 3)}-${pinCode.slice(3)}\n\n` +
              `3️⃣ HA 애드온 설정에서 Chat ID 등록:\nChat ID: ${chatId}`
          );
          continue;
        }

        // Handle commands for authorized users
        if (text === "/start" || text === "/help") {
          await sendTelegramMessage(
            botToken,
            chatId,
            `🤖 Antigravity HA 에이전트 도우미\n\n` +
              `사용법:\n` +
              `- 자연어로 질문이나 명령을 보내시면 Antigravity AI 에이전트가 실행합니다.\n` +
              `- /status : 시스템 및 HA 설정 검사\n` +
              `- /unpair : 이 계정의 텔레그램 연동 해제`
          );
          continue;
        }

        if (text === "/status") {
          await telegramApi(botToken, "sendChatAction", { chat_id: chatId, action: "typing" });
          const statusOutput = await runAntigravityPrompt("ha-config-check 결과를 확인하고 Home Assistant 시스템 상태를 간략히 요약해줘.");
          await sendTelegramMessage(botToken, chatId, statusOutput);
          continue;
        }

        if (text === "/unpair") {
          authorizedChats.delete(chatId);
          saveAuthorizedChats(authorizedChats);
          await sendTelegramMessage(botToken, chatId, "👋 Antigravity HA 연동이 해제되었습니다.");
          continue;
        }

        // Process AI prompt
        try {
          await telegramApi(botToken, "sendChatAction", { chat_id: chatId, action: "typing" });
          const aiResponse = await runAntigravityPrompt(text);
          await sendTelegramMessage(botToken, chatId, aiResponse);
        } catch (err) {
          await sendTelegramMessage(botToken, chatId, `⚠️ 처리 중 오류가 발생했습니다: ${err.message}`);
        }
      }
    } catch (err) {
      if (err.name === "AbortError" || (err.message && err.message.includes("fetch failed"))) {
        // Quietly handle routine network idle/timeout during long-polling and retry after 1s
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
