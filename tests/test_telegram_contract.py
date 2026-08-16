"""Security and packaging contracts for the Telegram bridge v2."""

from pathlib import Path
import os
import stat
import subprocess


def test_telegram_options_in_config_yaml(addon_config: dict) -> None:
    options = addon_config.get("options", {})
    schema = addon_config.get("schema", {})

    assert options["telegram_enabled"] is False
    assert options["telegram_bot_token"] == ""
    assert options["telegram_allowed_user_ids"] == []
    assert options["telegram_allowed_chat_ids"] == []
    assert schema["telegram_enabled"] == "bool"
    assert schema["telegram_bot_token"] == "password?"
    assert "telegram_access_mode" not in options
    assert "telegram_access_mode" not in schema


def test_telegram_bridge_syntax_and_unit_suite(repository_root: Path, addon_root: Path) -> None:
    bridge = addon_root / "rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs"
    assert bridge.is_file()

    syntax = subprocess.run(["node", "--check", str(bridge)], capture_output=True, text=True)
    assert syntax.returncode == 0, syntax.stderr

    suite = subprocess.run(
        ["node", str(repository_root / "tests/telegram_bridge_test.mjs")],
        capture_output=True,
        text=True,
    )
    assert suite.returncode == 0, suite.stderr

    broker_suite = subprocess.run(
        [
            "node",
            str(repository_root / "tests/telegram_broker_integration_test.mjs"),
        ],
        capture_output=True,
        text=True,
    )
    assert broker_suite.returncode == 0, broker_suite.stderr

    pairing_suite = subprocess.run(
        ["node", "--test", str(repository_root / "tests/telegram_pairing_test.mjs")],
        capture_output=True,
        text=True,
    )
    assert pairing_suite.returncode == 0, pairing_suite.stderr

    state_suite = subprocess.run(
        ["node", "--test", str(repository_root / "tests/telegram_state_test.mjs")],
        capture_output=True,
        text=True,
    )
    assert state_suite.returncode == 0, state_suite.stderr

    session_delivery_suite = subprocess.run(
        [
            "node",
            str(repository_root / "tests/telegram_bridge_session_delivery_test.mjs"),
        ],
        capture_output=True,
        text=True,
    )
    assert session_delivery_suite.returncode == 0, session_delivery_suite.stderr


def test_ci_runs_shared_context_session_delivery_gate(repository_root: Path) -> None:
    workflow = (repository_root / ".github/workflows/ci.yaml").read_text(
        encoding="utf-8"
    )
    assert "Telegram shared context, session, delivery, and broker contracts" in workflow
    assert "tests/telegram_bridge_session_delivery_test.mjs" in workflow


def test_telegram_local_pairing_helper_is_packaged(addon_root: Path) -> None:
    rootfs = addon_root / "rootfs"
    helper = rootfs / "usr/local/bin/ha-telegram-pair"
    pairing = rootfs / "usr/local/share/antigravity-ha/telegram-pairing.mjs"
    state = rootfs / "usr/local/share/antigravity-ha/telegram-state.mjs"
    assert helper.is_file()
    assert pairing.is_file()
    assert state.is_file()
    if os.name != "nt":
        assert helper.stat().st_mode & stat.S_IXUSR
    wrapper = helper.read_text(encoding="utf-8")
    assert wrapper.splitlines()[:3] == [
        "#!/bin/bash -p",
        "set -Eeuo pipefail",
        "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN",
    ]
    assert "exec /usr/bin/env -i" in wrapper
    assert "/usr/local/share/antigravity-ha/ha-telegram-pair.mjs" in wrapper
    command = rootfs / "usr/local/share/antigravity-ha/ha-telegram-pair.mjs"
    assert command.is_file()
    assert "createPairing" in command.read_text(encoding="utf-8")
    source = pairing.read_text(encoding="utf-8")
    assert 'randomBytes(24)' in source
    assert 'createHash("sha256")' in source
    assert "timingSafeEqual" in source
    assert 'authorizations.json' in source


def test_telegram_service_depends_on_init(addon_root: Path) -> None:
    service = addon_root / "rootfs/etc/s6-overlay/s6-rc.d/telegram-bot"
    assert (service / "type").read_text(encoding="utf-8").strip() == "longrun"
    assert (service / "dependencies.d/antigravity-ha-init").is_file()
    assert (service / "dependencies.d/ha-change-broker").is_file()
    run = (service / "run").read_text(encoding="utf-8")
    assert "exec /usr/local/libexec/ha-telegram-runtime" in run
    runtime = (
        addon_root / "rootfs/usr/local/libexec/ha-telegram-runtime"
    ).read_text(encoding="utf-8")
    assert runtime.splitlines()[:3] == [
        "#!/bin/bash -p",
        "set -Eeuo pipefail",
        "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN",
    ]
    assert "AGY_CLI_DISABLE_AUTO_UPDATE=true" in runtime
    assert runtime.rstrip().endswith(
        "  /usr/bin/node \\\n"
        "  --network-family-autoselection-attempt-timeout=1500 \\\n"
        "  /usr/local/share/antigravity-ha/telegram-bridge.mjs"
    )
    assert "--no-network-family-autoselection" not in runtime
    assert "telegram-bridge.mjs" in runtime
    assert "s6-svwait" not in run
    bridge = (
        addon_root / "rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs"
    ).read_text(encoding="utf-8")
    assert 'audit("waiting_for_authorization"' in bridge
    assert "await waitForTelegramAuthorization(config)" in bridge
    assert bridge.index("await waitForTelegramAuthorization(config)") < bridge.index(
        "await connectTelegram(config)"
    )
    assert 'sendBrokerRequest("health"' not in bridge
    assert 'api(config.botToken, "deleteWebhook"' in bridge
    assert 'api(config.botToken, "getMe"' in bridge
    assert 'auditEvent("connect_retry", fields)' in bridge
    assert 'auditEvent("connect_blocked"' in bridge
    assert "if (isPermanentTelegramApiError(error))" in bridge
    assert "await hold()" in bridge
    assert "while (true) await wait(TELEGRAM_PERMANENT_HOLD_MS)" in bridge
    assert 'if (!isTransientTelegramApiError(error)) throw error' in bridge
    assert 'fields.transport_code = telegramTransportErrorCode(error)' in bridge
    assert '"EAI_AGAIN"' in bridge
    assert '"UNABLE_TO_VERIFY_LEAF_SIGNATURE"' in bridge
    assert (
        'throw new Error("Telegram requires both static allowlists or one local '
        'pairing token/authorization")' not in bridge
    )


def test_telegram_bridge_has_no_legacy_shell_or_pairing_surface(addon_root: Path) -> None:
    bridge = (
        addon_root / "rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs"
    ).read_text(encoding="utf-8")

    forbidden = (
        "execAsync",
        "tmux new-session",
        "capture-pane",
        "writeFileSync",
        "PAIR_INFO",
        "pin_code",
        "pairToken",
        "--dangerously-skip-permissions",
        'approval_policy="never"',
        'sandbox_mode="danger-full-access"',
    )
    for marker in forbidden:
        assert marker not in bridge

    assert 'spawn(binary, args' in bridge
    assert 'DEFAULT_AGY_BIN = "/usr/local/bin/antigravity"' in bridge
    assert 'SHARED_ANTIGRAVITY_HOME = "/data/home"' in bridge
    assert 'SHARED_ANTIGRAVITY_WORKSPACE = "/config"' in bridge
    assert "cwd = SHARED_ANTIGRAVITY_WORKSPACE" in bridge
    assert "HOME: SHARED_ANTIGRAVITY_HOME" in bridge
    assert 'ANTIGRAVITY_HA_CHANNEL = "telegram"' in bridge
    assert "HA_TELEGRAM_USER_ID" in bridge
    assert "HA_TELEGRAM_CHAT_ID" in bridge
    assert 'AGY_CLI_DISABLE_AUTO_UPDATE: "true"' in bridge
    assert '"--output-format"' in bridge
    assert '"stream-json"' in bridge
    assert '"--json-schema"' in bridge
    assert '"--print"' not in bridge
    assert '"--prompt"' not in bridge
    assert 'child.stdin.end(`${prompt}\\n`)' in bridge
    assert 'event?.event === "init"' in bridge
    assert 'event?.event === "result"' in bridge
    assert "event?.type" not in bridge
    assert 'event.result.status !== "SUCCESS"' in bridge
    assert "event.result.conversation_id !== conversationId" in bridge
    assert "parseTerminalResponse(event.result.response)" in bridge
    assert "telegram_allowed_user_ids" in bridge
    assert "ACCESS_MODES" not in bridge
    assert "confirm_changes" not in bridge
    assert '"read_only"' not in bridge
    assert "proposalDisposition(config.toolPermission" in bridge
    assert 'sendBrokerRequest("inspect"' in bridge
    assert 'brokerRequest("authorize"' in bridge
    assert 'brokerRequest("execute"' in bridge
    assert 'brokerRequest("execute_status"' in bridge
    assert "ensureSession(userId, chatId" in bridge
    assert "bindSessionConversation(" in bridge
    assert "queueResponseDelivery(textDeliveryRecord(" in bridge
    assert "terminalFinalize(" in bridge
    assert "drainPendingResponseDeliveries(config" in bridge
    assert "applyNewSessionControl({" in bridge
    assert "classifyPrompt" not in bridge
    assert 'detached: true' in bridge


def test_telegram_metrics_have_bounded_privacy_safe_labels(addon_root: Path) -> None:
    bridge = (
        addon_root / "rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs"
    ).read_text(encoding="utf-8")

    for metric in (
        "updates_received_total",
        "updates_denied_total",
        "jobs_active",
        "jobs_queued",
        "jobs_completed_total",
        "approvals_total",
        "worker_duration_seconds",
        "telegram_api_errors_total",
        "stream_events_ignored_total",
    ):
        assert metric in bridge
    snapshot = bridge.split("function metricsSnapshot()", maxsplit=1)[1].split(
        "function resetMetricsForTest()", maxsplit=1
    )[0]
    for forbidden in (
        "user_id",
        "chat_id",
        "message_id",
        "proposal_id",
        "prompt",
        "output",
        "token",
    ):
        assert forbidden not in snapshot
    assert 'setInterval(() => audit("metrics", metricsSnapshot()), 60_000)' in bridge


def test_telegram_uses_shared_native_home_and_interactive_policy(
    addon_root: Path,
    repository_root: Path,
) -> None:
    rootfs = addon_root / "rootfs"
    init = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    launcher = (rootfs / "usr/local/bin/antigravity").read_text(
        encoding="utf-8"
    )
    restricted = (
        rootfs / "usr/local/libexec/antigravity-interactive-restricted"
    ).read_text(encoding="utf-8")
    sensitive = (
        rootfs / "usr/local/libexec/antigravity-interactive-sensitive-read"
    ).read_text(encoding="utf-8")
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    apparmor = (addon_root / "apparmor.txt").read_text(encoding="utf-8")

    obsolete_paths = (
        "usr/local/bin/ha-telegram-login",
        "usr/local/libexec/ha-telegram-home-bootstrap",
        "usr/local/libexec/ha-telegram-worker",
        "usr/local/lib/antigravity-ha/telegram-plugin.sh",
        "etc/antigravity/telegram-settings.json",
        "usr/local/share/antigravity-ha/telegram-workspace/.antigravity-ha-managed",
        "usr/local/share/antigravity-ha/playwright-telegram-init-page.ts",
        "usr/local/share/antigravity-ha/plugins/home-assistant/agents/ha-telegram/agent.md",
    )
    for relative_path in obsolete_paths:
        assert not (rootfs / relative_path).exists()

    assert "ha-telegram-home-bootstrap" not in init
    assert "telegram-workspace" not in dockerfile
    assert "telegram-settings.json" not in dockerfile
    assert "ANTIGRAVITY_HA_CHANNEL" in launcher
    assert "invalid Telegram requester binding" in launcher
    for confined_launcher in (restricted, sensitive):
        assert "HOME=/data/home" in confined_launcher
        assert "ANTIGRAVITY_HA_CHANNEL=telegram" in confined_launcher
        assert '"HA_TELEGRAM_USER_ID=${HA_TELEGRAM_USER_ID}"' in confined_launcher
        assert '"HA_TELEGRAM_CHAT_ID=${HA_TELEGRAM_CHAT_ID}"' in confined_launcher
        assert '"${requester_environment[@]}"' in confined_launcher

    telegram_profile = apparmor.split(
        "profile antigravity_home_assistant-telegram flags=", maxsplit=1
    )[1].split(
        "profile antigravity_home_assistant-change-proposal-client", maxsplit=1
    )[0]
    assert "/usr/local/bin/antigravity rix," in telegram_profile
    assert (
        "/usr/local/libexec/antigravity-interactive-restricted Px -> "
        "antigravity_home_assistant-interactive-restricted," in telegram_profile
    )
    assert (
        "/usr/local/libexec/antigravity-interactive-sensitive-read Px -> "
        "antigravity_home_assistant-interactive-sensitive-read," in telegram_profile
    )
    for obsolete_profile in (
        "antigravity_home_assistant-telegram-login",
        "antigravity_home_assistant-telegram-worker",
        "antigravity_home_assistant-memory-telegram",
        "antigravity_home_assistant-playwright-bootstrap-telegram",
        "antigravity_home_assistant-browser-telegram",
    ):
        assert obsolete_profile not in apparmor

    proposal_profile = apparmor.split(
        "profile antigravity_home_assistant-change-proposal-client", maxsplit=1
    )[1].split(
        "profile antigravity_home_assistant-broker-bootstrap", maxsplit=1
    )[0]
    assert "/run/antigravity-ha/change-proposal.sock rw," in proposal_profile
    assert "deny /data/home/** rwklm," in proposal_profile
    assert "deny /config/** rwklm," in proposal_profile
    assert "deny /run/antigravity-ha/supervisor.token rwklm," in proposal_profile

    canary = repository_root / "tests/telegram-shared-context-smoke.sh"
    assert canary.is_file()
    if os.name != "nt":
        assert canary.stat().st_mode & stat.S_IXUSR
    canary_source = canary.read_text(encoding="utf-8")
    assert "/usr/local/libexec/antigravity-real --version" in canary_source
    assert "shared Antigravity did not load the global MCP" in canary_source
    assert "shared global rule marker" in canary_source
    assert "shared global plugin marker" in canary_source
    assert "shared native OAuth/config marker" in canary_source
    assert '"[[ \\\"\\${HOME:-}\\\" == /data/home ]]"' in canary_source
    assert '"[[ \\\"\\$(pwd -P)\\\" == /config ]]"' in canary_source
    docker_smoke = (repository_root / "tests/docker-smoke.sh").read_text(
        encoding="utf-8"
    )
    assert 'tests/telegram-shared-context-smoke.sh "${IMAGE}"' in docker_smoke
    assert 'tests/public-v2-upgrade-smoke.sh "${IMAGE}"' in docker_smoke


def test_public_v2_upgrade_smoke_covers_shared_runtime_migration(
    repository_root: Path,
) -> None:
    smoke_path = repository_root / "tests/public-v2-upgrade-smoke.sh"
    assert smoke_path.is_file()
    if os.name != "nt":
        assert smoke_path.stat().st_mode & stat.S_IXUSR
    subprocess.run(["bash", "-n", str(smoke_path)], check=True)
    smoke = smoke_path.read_text(encoding="utf-8")

    for required in (
        "ghcr.io/kanu-coffee/antigravity-for-home-assistant@${PUBLIC_V2_DIGEST}",
        "sha256:7147fd32b3f117879451481a206cb973484a35b4646ac91907769ff9cda327df",
        "sha256:e98274a617d25deeacb8db777898718f920604b260931944997b3aa52ef0c3dd",
        "8eb03cfa22bac2cc481f9c5ebab4c1a250d92cb2",
        "/usr/local/share/antigravity-ha/telegram-pairing.mjs",
        "/usr/local/share/antigravity-ha/telegram-state.mjs",
        "registerSealedUpdateBatch",
        "v2 local pairing authorization bytes changed during upgrade",
        "v4 transport state was not preserved during migration",
        "session.generation !== 1",
        "session.conversation_id !== null",
        "retired dedicated-HOME settings changed during upgrade",
        "shared global permissions were not migrated from preserve mode",
        'index("read_file(/data)") == null',
        'index("write_file(/data)") == null',
        "/usr/local/bin/ha-telegram-login",
        "/usr/local/libexec/ha-telegram-worker",
        "antigravity_home_assistant-telegram-worker",
        "--network none",
    ):
        assert required in smoke

    assert "telegram_enabled: false" in smoke
    assert "PUBLIC_V2_SEALED_PROMPT_DO_NOT_PERSIST" in smoke
    assert "actual HAOS" not in smoke
