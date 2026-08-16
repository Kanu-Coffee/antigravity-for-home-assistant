import os
import stat
import subprocess
from pathlib import Path


def test_read_broker_dynamic_contract(repository_root: Path) -> None:
    result = subprocess.run(
        ["node", "--test", "tests/ha_read_broker_test.mjs"],
        cwd=repository_root,
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
        env={
            "HOME": os.environ.get("HOME", "/tmp"),
            "LANG": "C.UTF-8",
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        },
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"


def test_validate_mcp_dynamic_contract(repository_root: Path) -> None:
    result = subprocess.run(
        ["node", "--test", "tests/ha_validate_mcp_test.mjs"],
        cwd=repository_root,
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
        env={
            "HOME": os.environ.get("HOME", "/tmp"),
            "LANG": "C.UTF-8",
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        },
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"


def test_read_broker_is_image_managed_and_token_isolated(rootfs: Path) -> None:
    bin_root = rootfs / "usr/local/bin"
    share_root = rootfs / "usr/local/share/antigravity-ha"
    for name in ("ha-read-broker", "ha-read-mcp", "ha-validate-mcp"):
        wrapper = bin_root / name
        assert wrapper.is_file()
        assert wrapper.read_text(encoding="utf-8").splitlines()[:3] == [
            "#!/bin/bash -p",
            "set -Eeuo pipefail",
            "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN",
        ]
        if os.name != "nt":
            assert wrapper.stat().st_mode & stat.S_IXUSR
    for name in (
        "ha-read-broker.mjs",
        "ha-read-client.mjs",
        "ha-read-mcp.mjs",
        "ha-validate-mcp.mjs",
    ):
        assert (share_root / name).is_file()

    broker_wrapper = (bin_root / "ha-read-broker").read_text(encoding="utf-8")
    mcp_wrapper = (bin_root / "ha-read-mcp").read_text(encoding="utf-8")
    assert "antigravity_ha_load_supervisor_credential" not in broker_wrapper
    assert "antigravity_ha_open_supervisor_credential_pipe" in broker_wrapper
    assert "ANTIGRAVITY_HA_SUPERVISOR_FD" in broker_wrapper
    assert 'SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}"' not in broker_wrapper
    assert "/usr/local/libexec/ha-read-broker-runtime" in broker_wrapper
    assert "antigravity_ha_load_supervisor_credential" not in mcp_wrapper
    assert "SUPERVISOR_TOKEN=" not in mcp_wrapper
    assert "exec /usr/bin/env -i" in mcp_wrapper


def test_read_broker_s6_and_plugin_contract(rootfs: Path) -> None:
    s6_root = rootfs / "etc/s6-overlay/s6-rc.d"
    service = s6_root / "ha-read-broker"
    assert (service / "type").read_text(encoding="utf-8").strip() == "longrun"
    assert (service / "dependencies.d/antigravity-ha-init").is_file()
    assert (s6_root / "user/contents.d/ha-read-broker").is_file()
    assert (s6_root / "telegram-bot/dependencies.d/ha-read-broker").is_file()
    assert (s6_root / "ha-memoryd/dependencies.d/ha-read-broker").is_file()
    assert "exec /usr/local/bin/ha-read-broker" in (
        service / "run"
    ).read_text(encoding="utf-8")

    plugin = (
        rootfs
        / "usr/local/share/antigravity-ha/plugins/home-assistant/mcp_config.json"
    ).read_text(encoding="utf-8")
    assert '"ha_read"' in plugin
    assert '"command": "/usr/local/bin/ha-read-mcp"' in plugin
    assert '"ha_validate"' in plugin
    assert '"command": "/usr/local/bin/ha-validate-mcp"' in plugin


def test_apparmor_separates_read_worker_client_and_token_broker(
    addon_root: Path,
    rootfs: Path,
) -> None:
    profile = (addon_root / "apparmor.txt").read_text(encoding="utf-8")
    main, bootstrap_tail = profile.split(
        "profile antigravity_home_assistant-broker-bootstrap", maxsplit=1
    )
    bootstrap, read_broker_tail = bootstrap_tail.split(
        "profile antigravity_home_assistant-change-broker", maxsplit=1
    )[0], profile.split(
        "profile antigravity_home_assistant-read-broker", maxsplit=1
    )[1]
    read_broker, read_client_tail = read_broker_tail.split(
        "profile antigravity_home_assistant-read-client", maxsplit=1
    )
    read_client = read_client_tail.split(
        "profile antigravity_home_assistant-playwright-bootstrap", maxsplit=1
    )[0]
    restricted = profile.split(
        "profile antigravity_home_assistant-interactive-restricted", maxsplit=1
    )[1].split(
        "profile antigravity_home_assistant-interactive-sensitive-read", maxsplit=1
    )[0]
    sensitive = profile.split(
        "profile antigravity_home_assistant-interactive-sensitive-read", maxsplit=1
    )[1].split(
        "profile antigravity_home_assistant-init", maxsplit=1
    )[0]

    assert "/usr/local/bin/{ha-change-broker,ha-read-broker} Px -> " \
        "antigravity_home_assistant-broker-bootstrap," in main
    for interactive in (restricted, sensitive):
        assert "/usr/local/bin/ha-read-mcp Px -> " \
            "antigravity_home_assistant-read-client," in interactive
        assert "/usr/local/bin/ha-validate-mcp Px -> " \
            "antigravity_home_assistant-read-client," in interactive
        assert "deny /run/antigravity-ha/ha-read.sock rwklm," in interactive
    assert "/run/antigravity-ha/ha-read.sock rw," in read_client
    assert "/usr/local/bin/ha-config-check Px -> " \
        "antigravity_home_assistant-ha-helper," in read_client
    assert "/usr/local/bin/ha-validate-mcp rix," in read_client
    assert "/usr/local/share/antigravity-ha/ha-validate-mcp.mjs r," in read_client
    assert "deny /run/antigravity-ha/supervisor.token rwklm," in read_client
    assert "/run/antigravity-ha/ha-read.sock rwk," in read_broker
    assert "/run/antigravity-ha/supervisor.token r," in bootstrap
    assert "/usr/local/libexec/ha-read-broker-runtime Px -> " \
        "antigravity_home_assistant-read-broker," in bootstrap
    assert "deny /run/antigravity-ha/supervisor.token rwklm," in read_broker
    assert "antigravity_ha_open_supervisor_credential_pipe" in (
        rootfs / "usr/local/bin/ha-read-broker"
    ).read_text(encoding="utf-8")
    assert "deny /data/** rwklm," in read_broker
    assert "deny /config/** rwklm," in read_broker


def test_read_broker_source_is_fixed_get_only_and_bounded(rootfs: Path) -> None:
    source = (
        rootfs / "usr/local/share/antigravity-ha/ha-read-broker.mjs"
    ).read_text(encoding="utf-8")
    client = (
        rootfs / "usr/local/share/antigravity-ha/ha-read-client.mjs"
    ).read_text(encoding="utf-8")
    mcp = (
        rootfs / "usr/local/share/antigravity-ha/ha-read-mcp.mjs"
    ).read_text(encoding="utf-8")

    assert 'method: "GET"' in source
    assert 'CORE_API_URL = "http://supervisor/core/api"' in source
    assert 'SUPERVISOR_API_URL = "http://supervisor"' in source
    assert "UPSTREAM_TIMEOUT_MS = 10_000" in source
    assert "HA_READ_MAX_RESPONSE_BYTES = 1024 * 1024" in client
    assert "HA_READ_MAX_MEMORY_RESPONSE_BYTES = 32 * 1024 * 1024" in client
    assert 'action === "memory_snapshot"' in client
    assert "MAX_LIST_LIMIT = 100" in source
    assert "MAX_LOG_LINES = 500" in source
    assert '"service_call"' not in source
    assert '"POST"' not in source
    assert 'case "memory_snapshot"' in source
    assert "Authorization" not in mcp
    assert "sendHaReadRequest" in mcp
    assert "memory_snapshot" not in mcp
    assert "readOnlyHint: true" in mcp
    assert "ha_read_state" in mcp
    assert "ha_read_core_logs" in mcp
    assert "ha_read_registry" in mcp
    assert "ha_read_history" in mcp
    assert "ha_read_traces" in mcp
    assert "ha_read_app_logs" in mcp


def test_production_transport_ownership_is_explicit_and_privileged_flows_stay_separate(
    rootfs: Path,
) -> None:
    share_root = rootfs / "usr/local/share/antigravity-ha"
    bin_root = rootfs / "usr/local/bin"
    read_mcp = (share_root / "ha-read-mcp.mjs").read_text(encoding="utf-8")
    validate_mcp = (share_root / "ha-validate-mcp.mjs").read_text(
        encoding="utf-8"
    )
    memory_client = (share_root / "ha-memory-ha-client.mjs").read_text(
        encoding="utf-8"
    )
    read_broker = (share_root / "ha-read-broker.mjs").read_text(
        encoding="utf-8"
    )

    assert "sendHaReadRequest" in read_mcp
    assert "sendHaReadRequest" in validate_mcp
    assert '"/usr/local/bin/ha-config-check"' in validate_mcp
    assert "runConfigCheck" in validate_mcp
    assert "options.brokerRequest ?? sendHaReadRequest" in memory_client
    assert '"memory_snapshot"' in memory_client
    for unprivileged in (read_mcp, validate_mcp):
        assert "Authorization" not in unprivileged
        assert "SUPERVISOR_TOKEN=" not in unprivileged
    assert "fetchHomeAssistantSnapshot" in read_broker
    assert "fetchHomeAssistantBrokerRead" in read_broker
    assert "consumeSupervisorCredentialFromInheritedFd" in read_broker
    assert "process.env.SUPERVISOR_TOKEN" not in read_broker

    read_wrapper = (bin_root / "ha-read-broker").read_text(encoding="utf-8")
    change_wrapper = (bin_root / "ha-change-broker").read_text(encoding="utf-8")
    browser_setup = (bin_root / "ha-browser-auth-setup").read_text(
        encoding="utf-8"
    )
    for broker_wrapper in (read_wrapper, change_wrapper):
        assert "antigravity_ha_load_supervisor_credential" not in broker_wrapper
        assert "antigravity_ha_open_supervisor_credential_pipe" in broker_wrapper
        assert "ANTIGRAVITY_HA_SUPERVISOR_FD" in broker_wrapper
    assert "antigravity_ha_load_supervisor_credential" in browser_setup
    assert "/run/antigravity-ha/ha-read.sock" in (
        share_root / "ha-read-client.mjs"
    ).read_text(encoding="utf-8")
    assert "/run/antigravity-ha/change-broker.sock" in (
        share_root / "ha-change-broker.mjs"
    ).read_text(encoding="utf-8")
