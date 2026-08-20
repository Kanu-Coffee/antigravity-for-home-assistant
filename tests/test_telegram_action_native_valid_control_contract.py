from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_native_telegram_action_valid_control_uses_the_real_shipped_chain() -> None:
    smoke = (ROOT / "tests/telegram-action-native-valid-control.sh").read_text(
        encoding="utf-8"
    )
    probe = (
        ROOT / "tests/fixtures/telegram-action-native-valid-control.mjs"
    ).read_text(encoding="utf-8")

    assert "--network none" in smoke
    assert "--tmpfs /config:rw,nosuid,nodev,noexec" in smoke
    assert "--tmpfs /data:rw,nosuid,nodev,noexec" in smoke
    assert "--tmpfs /run:rw,nosuid,nodev,noexec" in smoke
    assert "/usr/local/libexec/antigravity-real" in probe
    assert "/usr/local/bin/telegram-action-proposal-mcp" in probe
    assert "TelegramActionCoordinator" in probe
    assert "--conversation" in probe
    assert "parseStreamResult" in probe
    assert "coordinator.getProposal" in probe
    assert "registered.proposal.request_digest" in probe
    assert "registered.proposal.binding" in probe


def test_native_telegram_action_valid_control_is_proposal_only() -> None:
    probe = (
        ROOT / "tests/fixtures/telegram-action-native-valid-control.mjs"
    ).read_text(encoding="utf-8")

    assert 'ToolName: "telegram_action_propose"' in probe
    assert 'step.tool_name === "run_command"' in probe
    assert "terminal-action-executor" not in probe
    assert "telegram-action-executor" not in probe
    assert "SUPERVISOR_TOKEN" not in probe
    assert "botToken" not in probe
