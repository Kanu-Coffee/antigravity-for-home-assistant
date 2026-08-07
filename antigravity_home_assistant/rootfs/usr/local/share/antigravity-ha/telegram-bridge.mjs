import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OPTIONS_PATH = "/data/options.json";
const DATA_DIR = "/data/antigravity";
const AUTHORIZED_CHATS_PATH = join(DATA_DIR, "telegram_authorized_chats.json");
const PAIR_INFO_DATA_PATH = join(DATA_DIR, "telegram_pair_info.json");
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

function loadOrGeneratePairingSecrets() {
  try {
    if (existsSync(PAIR_INFO_DATA_PATH)) {
      const saved = JSON.parse(readFileSync(PAIR_INFO_DATA_PATH, "utf8"));
      if (saved.pair_token && saved.pin_code) {
        return { pairToken: saved.pair_token, pinCode: saved.pin_code };
      }
    }
  } catch (e) {
    // Fallback
  }

  const num = Math.floor(100000 + Math.random() * 900000);
  const secrets = {
    pairToken: "PAIR_" + randomBytes(4).toString("hex"),
    pinCode: String(num),
  };
  try {
    writeFileSync(PAIR_INFO_DATA_PATH, JSON.stringify({ pair_token: secrets.pairToken, pin_code: secrets.pinCode }, null, 2), "utf8");
  } catch (e) {
    // Ignore data write errors
  }
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
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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

  for (let i = 0; i < text.length; i += maxLen) {
    const chunk = text.slice(i, i + maxLen);
    await telegramApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: chunk,
    });
  }
}

function stripAnsiCodes(text) {
  return text
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

async function runAntigravityPrompt(promptText) {
  return new Promise((resolve) => {
    const safePrompt = promptText.replace(/'/g, "'\\''");
    // Run via pseudo-TTY using script command to satisfy bubbletea TTY requirement
    const child = spawn(
      "script",
      ["-q", "-c", `antigravity --dangerously-skip-permissions -p '${safePrompt}'`, "/dev/null"],
      {
        cwd: "/config",
        env: { ...process.env, HOME: "/data/home" },
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      const combinedOutput = stripAnsiCodes(stdout || stderr);
      if (combinedOutput) {
        resolve(combinedOutput);
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

  // Clear any existing Webhook to ensure getUpdates Long Polling works
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
        30000,
        1
      );

      for (const update of updates) {
        offset = update.update_id + 1;
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
            `🤖 Antigravity HA 에이전트 도우미\n\n` +
              `사용법:\n` +
              `- 자연어로 질문이나 명령을 보내시면 Antigravity AI 에이전트가 실행합니다.\n` +
              `- /status : 시스템 및 HA 설정 검사\n` +
              `- /unpair : 이 계정의 텔레그램 연동 해제`
          );
          continue;
        }

        if (text === "/status") {
          console.log(`[Telegram Bridge] Processing /status check for Chat ID ${chatId}...`);
          (async () => {
            try {
              try {
                await telegramApi(botToken, "sendChatAction", { chat_id: chatId, action: "typing" });
              } catch (_) {}
              const statusOutput = await runAntigravityPrompt("ha-config-check 결과를 확인하고 Home Assistant 시스템 상태를 간략히 요약해줘.");
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
            try {
              await telegramApi(botToken, "sendChatAction", { chat_id: chatId, action: "typing" });
            } catch (_) {}
            const aiResponse = await runAntigravityPrompt(text);
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
