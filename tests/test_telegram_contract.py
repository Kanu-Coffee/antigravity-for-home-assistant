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
    """Verify telegram-bridge.mjs uses approval_policy=never and cleans response."""
    script_path = addon_root / "rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs"
    content = script_path.read_text(encoding="utf-8")

    assert 'approval_policy="never"' in content
    assert "cleanAiOutput" in content
    assert "stripAnsiCodes" in content
    assert "sendMessage" in content
