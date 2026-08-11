"""Security and packaging contracts for the Telegram bridge v2."""

from pathlib import Path
import json
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
    assert options["telegram_access_mode"] == "confirm_changes"
    assert schema["telegram_enabled"] == "bool"
    assert schema["telegram_bot_token"] == "password?"
    assert schema["telegram_access_mode"] == "list(read_only|confirm_changes|autonomous)"


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
    assert "telegram-bridge.mjs" in runtime
    assert "s6-svwait" not in run


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
        'approval_policy="never"',
        'sandbox_mode="danger-full-access"',
    )
    for marker in forbidden:
        assert marker not in bridge

    assert 'spawn(binary, args' in bridge
    assert 'DEFAULT_AGY_BIN = "/usr/local/libexec/ha-telegram-worker"' in bridge
    assert 'TELEGRAM_HOME = "/data/antigravity-ha/telegram-home"' in bridge
    assert (
        'TELEGRAM_WORKSPACE = "/usr/local/share/antigravity-ha/telegram-workspace"'
        in bridge
    )
    assert "cwd = TELEGRAM_WORKSPACE" in bridge
    assert "HOME: TELEGRAM_HOME" in bridge
    assert 'AGY_CLI_DISABLE_AUTO_UPDATE: "true"' in bridge
    assert '"--output-format"' in bridge
    assert '"stream-json"' in bridge
    assert '"--json-schema"' in bridge
    assert 'child.stdin.end(`${prompt}\\n`)' in bridge
    assert "telegram_allowed_user_ids" in bridge
    assert "confirm_changes" in bridge
    assert 'sendBrokerRequest("inspect"' in bridge
    assert 'brokerRequest("authorize"' in bridge
    assert 'brokerRequest("execute"' in bridge
    assert 'brokerRequest("execute_status"' in bridge
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


def test_telegram_native_home_is_bootstrapped_and_fail_closed(
    addon_root: Path,
    repository_root: Path,
) -> None:
    rootfs = addon_root / "rootfs"
    bootstrap_path = rootfs / "usr/local/libexec/ha-telegram-home-bootstrap"
    worker_path = rootfs / "usr/local/libexec/ha-telegram-worker"
    plugin_deriver_path = (
        rootfs / "usr/local/lib/antigravity-ha/telegram-plugin.sh"
    )
    login_path = rootfs / "usr/local/bin/ha-telegram-login"
    workspace = rootfs / "usr/local/share/antigravity-ha/telegram-workspace"
    telegram_settings = rootfs / "etc/antigravity/telegram-settings.json"
    telegram_agent = (
        rootfs
        / "usr/local/share/antigravity-ha/plugins/home-assistant/"
        "agents/ha-telegram/agent.md"
    ).read_text(encoding="utf-8")
    init = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    apparmor = (addon_root / "apparmor.txt").read_text(encoding="utf-8")

    for executable in (bootstrap_path, worker_path, login_path):
        assert executable.is_file()
        if os.name != "nt":
            assert executable.stat().st_mode & stat.S_IXUSR
    assert (workspace / ".antigravity-ha-managed").is_file()
    plugin_deriver = plugin_deriver_path.read_text(encoding="utf-8")
    assert "antigravity_ha_render_telegram_plugin_mcp" in plugin_deriver
    assert "antigravity_ha_stage_telegram_plugin" in plugin_deriver
    assert (
        '.value.cwd = "/usr/local/share/antigravity-ha/telegram-workspace"'
        in plugin_deriver
    )
    for server in (
        "ha_change",
        "ha_memory",
        "ha_read",
        "ha_validate",
        "playwright",
    ):
        assert f'"{server}"' in plugin_deriver
    settings = telegram_settings.read_text(encoding="utf-8")
    assert '"enableTerminalSandbox": true' in settings
    assert '"allowNonWorkspaceAccess": true' not in settings
    assert '"toolPermission": "always-proceed"' not in settings
    telegram_settings_value = json.loads(settings)
    assert telegram_settings_value["toolPermission"] == "request-review"
    assert telegram_settings_value["allowNonWorkspaceAccess"] is False
    assert "tools: []" in telegram_agent
    assert "view_file" not in telegram_agent
    assert "grep_search" not in telegram_agent
    assert "`device_test`" in telegram_agent
    assert "always-restore/fresh-verify" in telegram_agent
    telegram_permissions = telegram_settings_value["permissions"]
    for rule in (
        "mcp(ha_change/ha_change_propose)",
        "mcp(ha_read/ha_read_registry)",
        "mcp(ha_read/ha_read_history)",
        "mcp(ha_read/ha_read_traces)",
        "mcp(ha_validate/ha_validate_config)",
        "mcp(ha_validate/ha_verify_state)",
        "mcp(playwright/browser_snapshot)",
    ):
        assert rule in telegram_permissions["allow"]
    for rule in (
        "command(*)",
        "mcp(ha_memory/memory_begin_change)",
        "mcp(playwright/browser_click)",
        "mcp(playwright/browser_hover)",
    ):
        assert rule in telegram_permissions["deny"]
    assert telegram_permissions["ask"] == []

    bootstrap = bootstrap_path.read_text(encoding="utf-8")
    worker = worker_path.read_text(encoding="utf-8")
    login = login_path.read_text(encoding="utf-8")
    assert "TELEGRAM_HOME=/data/antigravity-ha/telegram-home" in bootstrap
    assert "SETTINGS_SOURCE=/etc/antigravity/telegram-settings.json" in bootstrap
    assert "rm -rf --" in bootstrap
    assert '"${CONFIG_ROOT}/agents"' in bootstrap
    assert '"${CONFIG_ROOT}/rules"' in bootstrap
    assert '"${CONFIG_ROOT}/mcp_config.json"' in bootstrap
    assert "PLUGIN_TARGET=${CONFIG_ROOT}/plugins/home-assistant" in bootstrap
    assert "--login" in bootstrap and "--runtime" in bootstrap
    assert "native OAuth backend is not inferred" in bootstrap
    assert 'if .toolPermission == "request-review"' in bootstrap
    assert 'if .allowNonWorkspaceAccess == false' in bootstrap
    assert 'if .permissions.ask == []' in bootstrap
    assert 'install_managed_file "${SETTINGS_SOURCE}"' in bootstrap
    assert 'antigravity_ha_stage_telegram_plugin \\' in bootstrap
    assert '"${PLUGIN_SOURCE}" "${plugin_temporary}"' in bootstrap
    assert 'diff -qr "${plugin_expected}" "${PLUGIN_TARGET}"' in bootstrap
    assert "/usr/local/libexec/ha-telegram-home-bootstrap --runtime" in init

    assert "TELEGRAM_HOME=/data/antigravity-ha/telegram-home" in worker
    assert '[[ "$(pwd -P)" == "${SAFE_WORKSPACE}" ]]' in worker
    assert '/usr/bin/flock --shared 9' in worker
    assert 'cmp -s "${MCP_SOURCE}"' in worker
    assert 'antigravity_ha_stage_telegram_plugin \\' in worker
    assert 'diff -qr "${plugin_expected}" "${PLUGIN_TARGET}"' in worker
    assert 'diff -qr "${PLUGIN_SOURCE}" "${PLUGIN_TARGET}"' not in worker
    assert '"${CONFIG_ROOT}/rules"' in worker
    assert 'exec /usr/local/libexec/antigravity-real "$@"' in worker

    assert login.splitlines()[:3] == [
        "#!/bin/bash -p",
        "set -Eeuo pipefail",
        "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN",
    ]
    assert "unset ANTIGRAVITY_TOKEN" in login
    assert "a trusted local controlling terminal is required" in login
    assert "/usr/bin/flock --exclusive 9" in login
    assert "--login --lock-held" in login
    assert "--runtime --lock-held" in login
    assert "native Antigravity first-run login" in login
    assert "--sandbox --disable-slash-commands" in login
    assert "/data/home" not in login

    assert "chmod 0555 /usr/local/share/antigravity-ha/telegram-workspace" in dockerfile
    assert (
        "/usr/local/bin/ha-telegram-login Px -> "
        "antigravity_home_assistant-telegram-login" in apparmor
    )
    assert (
        "/usr/local/libexec/ha-telegram-worker Px -> "
        "antigravity_home_assistant-telegram-worker" in apparmor
    )
    assert "deny /data/home/** rwklm," in apparmor
    assert "deny /config/ rwklmx," in apparmor
    assert "deny /config/** rwklmx," in apparmor
    assert (
        "deny /data/antigravity-ha/telegram-home/.gemini/config/rules/** rwklm,"
        in apparmor
    )

    canary = repository_root / "tests/telegram-isolation-smoke.sh"
    assert canary.is_file()
    if os.name != "nt":
        assert canary.stat().st_mode & stat.S_IXUSR
    canary_source = canary.read_text(encoding="utf-8")
    assert "/usr/local/libexec/antigravity-real --version" in canary_source
    assert "positive control did not launch the user global MCP" in canary_source
    assert "isolated worker launched the interactive global MCP" in canary_source
    assert "isolated worker launched the /config workspace MCP" in canary_source
    assert "isolated worker accepted a global rules directory" in canary_source
    docker_smoke = (repository_root / "tests/docker-smoke.sh").read_text(
        encoding="utf-8"
    )
    assert 'tests/telegram-isolation-smoke.sh "${IMAGE}"' in docker_smoke
