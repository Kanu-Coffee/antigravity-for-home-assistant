"""Contract tests for Telegram Bot Bridge integration."""

import json
from pathlib import Path
import subprocess

import pytest
import yaml


def test_telegram_options_in_config_yaml(addon_config: dict) -> None:
    """Verify telegram options exist in config.yaml schema."""
    options = addon_config.get("options", {})
    schema = addon_config.get("schema", {})

    assert "telegram_enabled" in options
    assert options["telegram_enabled"] is False
    assert "telegram_bot_token" in options
    assert "telegram_allowed_chat_ids" in options

    assert schema.get("telegram_enabled") == "bool"
    assert schema.get("telegram_bot_token") == "password?"
    assert "telegram_allowed_chat_ids" in schema


def test_telegram_bridge_script_syntax(addon_root: Path) -> None:
    """Verify telegram-bridge.mjs syntax via node --check."""
    script_path = addon_root / "rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs"
    assert script_path.is_file()

    result = subprocess.run(
        ["node", "--check", str(script_path)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"node --check failed: {result.stderr}"


def test_telegram_s6_service_structure(addon_root: Path) -> None:
    """Verify s6-overlay service definition for telegram-bot."""
    s6_dir = addon_root / "rootfs/etc/s6-overlay/s6-rc.d/telegram-bot"
    assert (s6_dir / "type").is_file()
    assert (s6_dir / "type").read_text(encoding="utf-8").strip() == "longrun"

    run_script = s6_dir / "run"
    assert run_script.is_file()
    assert "telegram-bridge.mjs" in run_script.read_text(encoding="utf-8")

    user_contents = addon_root / "rootfs/etc/s6-overlay/s6-rc.d/user/contents.d/telegram-bot"
    assert user_contents.is_file()


def test_telegram_bridge_script_content(addon_root: Path) -> None:
    """Verify telegram-bridge.mjs uses isolated execution, Hermes heartbeats, and inline approvals."""
    script_path = addon_root / "rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs"
    content = script_path.read_text(encoding="utf-8")

    assert "HeartbeatManager" in content
    assert "sendChatAction" in content
    assert "typing" in content
    assert "handleCallbackQuery" in content
    assert "inline_keyboard" in content
    assert "chunkMarkdownSafe" in content
    assert "cleanAiOutput" in content
    assert "stripAnsiCodes" in content
    assert "sendMessage" in content
    assert "pendingApprovals" in content
    assert "tmux new-session" in content
    assert "runAntigravityPrompt" in content


def test_telegram_clean_ai_output_unit(addon_root: Path) -> None:
    """Verify cleanAiOutput strips CLI banners, thoughts, tools, and prompts properly."""
    script_path = addon_root / "rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs"
    test_node_code = f"""
    const fs = require('fs');
    const content = fs.readFileSync('{script_path.as_posix()}', 'utf8');
    // Extract cleanAiOutput function and stripAnsiCodes
    const stripAnsiCodes = (text) => text.replace(/\\x1B\\[[0-?]*[ -/]*[@-~]/g, "").replace(/\\r\\n/g, "\\n").trim();
    eval(content.match(/function cleanAiOutput[\\s\\S]*?\\n\\}}/)[0]);

    const sample = `
▄▀▀▄        Antigravity CLI 1.1.11
     ▀▀▀▀▀▀       kor59lee@gmail.com
    ▀▀▀▀▀▀▀▀      /config
   ▄▀▀    ▀▀▄
  ▄▀▀      ▀▀▄

────────────────────────────────────────────────────────────
> 수신체크

● Bash(ha-config-check)
▸ Thought for 3s, 500 tokens
  Inspecting Home Assistant State
● Read(/config/configuration.yaml) (ctrl+o to expand)

네, 정상적으로 수신되었습니다! Home Assistant 시스템이 원활하게 동작 중입니다.
`;

    const cleaned = cleanAiOutput(sample, "수신체크");
    if (!cleaned.includes("정상적으로 수신되었습니다!")) {{
      console.error("Cleaned text mismatch:", cleaned);
      process.exit(1);
    }}
    if (cleaned.includes("Antigravity CLI") || cleaned.includes("Bash(") || cleaned.includes("Thought")) {{
      console.error("Failed to strip artifacts:", cleaned);
      process.exit(2);
    }}
    process.exit(0);
    """

    result = subprocess.run(
        ["node", "-e", test_node_code],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"cleanAiOutput unit test failed: {result.stderr}"


def test_telegram_extract_response_by_marker(addon_root: Path) -> None:
    """Verify extractResponseByMarker extracts clean content between start and end tags."""
    script_path = addon_root / "rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs"
    test_node_code = f"""
    const fs = require('fs');
    const content = fs.readFileSync('{script_path.as_posix()}', 'utf8');
    const stripAnsiCodes = (text) => text.replace(/\\x1B\\[[0-?]*[ -/]*[@-~]/g, "").replace(/\\r\\n/g, "\\n").trim();
    eval(content.match(/function cleanAiOutput[\\s\\S]*?\\n\\}}/)[0]);
    eval(content.match(/function extractResponseByMarker[\\s\\S]*?\\n\\}}/)[0]);

    const marker = "abcd1234";
    const sample = `
Some pre-banner output...
<<<AGY_OUT_START_${{marker}}>>>
Antigravity CLI 1.1.11
● Bash(ls)
시스템 점검 결과 모든 서비스가 정상 작동 중입니다.
<<<AGY_OUT_END_${{marker}}>>>
Extra trailing log...
`;

    const extracted = extractResponseByMarker(sample, marker);
    if (!extracted || !extracted.includes("시스템 점검 결과")) {{
      console.error("Marker extraction failed:", extracted);
      process.exit(1);
    }}
    if (extracted.includes("Antigravity CLI") || extracted.includes("Bash(ls)")) {{
      console.error("Failed to clean inside markers:", extracted);
      process.exit(2);
    }}
    process.exit(0);
    """

    result = subprocess.run(
        ["node", "-e", test_node_code],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"extractResponseByMarker test failed: {result.stderr}"


def test_telegram_chunk_markdown_safe(addon_root: Path) -> None:
    """Verify chunkMarkdownSafe properly splits text while preserving code fences."""
    script_path = addon_root / "rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs"
    test_node_code = f"""
    const fs = require('fs');
    const content = fs.readFileSync('{script_path.as_posix()}', 'utf8');
    eval(content.match(/function chunkMarkdownSafe[\\s\\S]*?\\n\\}}/)[0]);

    const longText = "안녕하세요! " + "A".repeat(5000) + "\\n```python\\nprint('Hello World')\\n```";
    const chunks = chunkMarkdownSafe(longText, 3900);
    if (chunks.length < 2) {{
      console.error("Failed to chunk large text:", chunks.length);
      process.exit(1);
    }}
    for (const chunk of chunks) {{
      if (chunk.length > 3950) {{
        console.error("Chunk exceeded safe limit:", chunk.length);
        process.exit(2);
      }}
    }}
    process.exit(0);
    """

    result = subprocess.run(
        ["node", "-e", test_node_code],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"chunkMarkdownSafe test failed: {result.stderr}"


