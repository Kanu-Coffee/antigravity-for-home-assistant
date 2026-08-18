import os
import stat
import subprocess
from pathlib import Path


def test_change_broker_dynamic_contract(repository_root: Path) -> None:
    result = subprocess.run(
        ["node", "--test", "tests/ha_change_broker_test.mjs"],
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


def test_change_broker_runtime_files_and_s6_graph(rootfs: Path) -> None:
    bin_root = rootfs / "usr/local/bin"
    share_root = rootfs / "usr/local/share/antigravity-ha"
    s6_root = rootfs / "etc/s6-overlay/s6-rc.d"

    for relative in (
        "ha-change-broker.mjs",
        "ha-change-broker-client.mjs",
        "ha-change-proposal-mcp.mjs",
    ):
        assert (share_root / relative).is_file()

    for name in (
        "ha-change-broker",
        "ha-change-broker-client",
        "ha-change-proposal-mcp",
    ):
        wrapper = bin_root / name
        assert wrapper.is_file()
        if os.name != "nt":
            assert wrapper.stat().st_mode & stat.S_IXUSR

    broker_service = s6_root / "ha-change-broker"
    assert (broker_service / "type").read_text(encoding="utf-8").strip() == "longrun"
    assert (broker_service / "dependencies.d/antigravity-ha-init").is_file()
    assert (s6_root / "user/contents.d/ha-change-broker").is_file()
    assert (s6_root / "telegram-bot/dependencies.d/ha-change-broker").is_file()
    if os.name != "nt":
        assert (broker_service / "run").stat().st_mode & stat.S_IXUSR


def test_broker_passes_only_a_validated_supervisor_credential_fd(rootfs: Path) -> None:
    bin_root = rootfs / "usr/local/bin"
    share_root = rootfs / "usr/local/share/antigravity-ha"
    broker = (bin_root / "ha-change-broker").read_text(encoding="utf-8")
    proposal = (bin_root / "ha-change-proposal-mcp").read_text(encoding="utf-8")
    client = (bin_root / "ha-change-broker-client").read_text(encoding="utf-8")

    assert "antigravity_ha_load_supervisor_credential" not in broker
    assert "antigravity_ha_open_supervisor_credential_pipe" in broker
    assert "supervisor-credential.sh" in broker
    assert "exec /usr/bin/env -i" in broker
    for required in (
        "HOME=/tmp",
        "LANG=C.UTF-8",
        "LC_ALL=C.UTF-8",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        'ANTIGRAVITY_HA_SUPERVISOR_FD="${credential_fd}"',
        "/usr/local/libexec/ha-change-broker-runtime",
    ):
        assert required in broker
    assert 'SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}"' not in broker
    assert "exec /usr/bin/node" not in broker
    for unprivileged in (proposal, client):
        assert "antigravity_ha_load_supervisor_credential" not in unprivileged
        assert "exec /usr/bin/env -i" in unprivileged

    assert "HA_TELEGRAM_USER_ID" in proposal
    assert "HA_TELEGRAM_CHAT_ID" in proposal
    assert 'ANTIGRAVITY_HA_CHANNEL:-}" != telegram' in proposal
    assert "^[1-9][0-9]{0,19}$" in proposal
    assert "^-?[1-9][0-9]{0,19}$" in proposal

    source = (share_root / "ha-change-broker.mjs").read_text(encoding="utf-8")
    fd_consumer = (share_root / "supervisor-credential-fd.mjs").read_text(
        encoding="utf-8"
    )
    assert "consumeSupervisorCredentialFromInheritedFd" in source
    assert "process.env.SUPERVISOR_TOKEN" not in source
    assert "delete environment.SUPERVISOR_TOKEN" in fd_consumer
    assert "closeSync(descriptor)" in fd_consumer
    assert "info.isFIFO()" in fd_consumer
    assert "readlinkSync" not in fd_consumer
    assert "/proc/self/fd" not in fd_consumer
    assert "The only Px entrypoint is the broker bootstrap" in fd_consumer
    assert "antigravity_ha_open_supervisor_credential_pipe" in broker


def test_change_broker_source_has_fail_closed_contract(rootfs: Path) -> None:
    source = (
        rootfs
        / "usr/local/share/antigravity-ha/ha-change-broker.mjs"
    ).read_text(encoding="utf-8")
    proposal = (
        rootfs
        / "usr/local/share/antigravity-ha/ha-change-proposal-mcp.mjs"
    ).read_text(encoding="utf-8")

    assert 'DEFAULT_SOCKET_PATH = "/run/antigravity-ha/change-broker.sock"' in source
    assert (
        'DEFAULT_PROPOSAL_SOCKET_PATH = '
        '"/run/antigravity-ha/change-proposal.sock"'
    ) in source
    assert 'proposal: new Set(["health", "propose"])' in source
    assert (
        'coordinator: new Set(["health", "inspect", "authorize", "execute", "execute_status"])'
        in source
    )
    assert "action_forbidden" in source
    assert "const capability = opaqueId(32)" in source
    assert "return randomBytes(bytes)" in source
    assert "timingSafeEqual" in source
    assert 'new Set(["restart", "update", "restore", "delete"])' in source
    assert 'status: "in_progress"' in source
    assert 'status: "completed"' in source
    assert 'operation === "config_patch"' in source
    assert 'operation === "service_call"' in source
    assert 'operation === "multi_choice_service_call"' in source
    assert "normalizeMultiChoiceServiceCallPayload" in source
    assert "MAX_MULTI_CHOICE_ITEMS = 31" in source
    assert 'format: "ha-multi-choice-service-call-v1"' in source
    assert "#executeMultiChoiceServiceCall" in source
    assert 'existingCapability.authorization === authorization' in source
    assert 'capability: existingCapability.capability' in source
    assert '"device_test"' in source
    assert "normalizeDeviceTestPayload" in source
    assert "#executeDeviceTest" in source
    assert 'format: "device-test-plan-v1"' in source
    assert 'expected_prior_state: normalized.payload.expected_prior_state' in source
    assert 'always: true' in source
    assert '"rollback_failed"' in source
    assert 'case "inspect"' in source
    assert "config_check_failed" in source
    assert "fresh_verification_failed" in source
    assert 'format: "yaml-line-diff-v1"' in source
    assert "buildConfigPatchPreview" in source
    assert "mutation_sha256" in source
    assert "omitted_before_lines" in source
    assert "omitted_after_lines" in source
    assert "MAX_PUBLIC_PREVIEW_BYTES" in source
    assert "<comment omitted>" in source
    assert "<redacted>" in source
    assert 'const CONFIG_ACTIVATION_SERVICES = new Map([' in source
    assert 'const CONFIG_ACTIVATION_TARGETS = new Map([' in source
    for activation in (
        "input_boolean_reload",
        "automation_reload",
        "script_reload",
        "scene_reload",
    ):
        assert f'["{activation}"' in source
    assert 'reload_service: "input_boolean.reload"' in source
    assert '`${this.haUrl}/services/${domain}/${service}`' in source
    assert 'format: "ha-service-call-v1"' in source
    assert "MAX_SERVICE_DATA_BYTES" in source
    assert "MAX_SERVICE_REGISTRY_RESPONSE_BYTES" in source
    assert "maxResponseBytes: MAX_SERVICE_REGISTRY_RESPONSE_BYTES" in source
    assert "MAX_SERVICE_DATA_DEPTH" in source
    assert "MAX_SERVICE_DATA_NODES" in source
    assert "UNSAFE_JSON_KEYS" in source
    assert "SENSITIVE_SERVICE_KEY" in source
    assert "#assertServiceAvailable" in source
    assert '`${this.haUrl}/services`' in source
    assert 'verification: "api_completed"' in source
    assert '? "restart_required"' in source
    assert "#executeInputBooleanConfigPatch" in source
    assert "canonicalInputBooleanInclude" in source
    assert "parseRestrictedInputBooleanYaml" in source
    assert "#beginSemanticChange" in source
    assert "#verifySemanticChange" in source
    assert 'fresh_verification: "memory_verified"' in source
    assert '"memory_begin_failed"' in source
    assert '"memory_verification_unavailable"' in source
    assert 'shell: false' in source
    assert '"/usr/local/bin/ha-memory"' in source
    assert "Authorization" not in proposal
    assert "supervisor-credential.sh" not in proposal
    assert "delete process.env.SUPERVISOR_TOKEN" in proposal
    assert 'name: "ha_change_propose"' in proposal
    assert 'required: ["operation", "summary", "payload"]' in proposal
    assert '"automation_reload"' in proposal
    assert '"script_reload"' in proposal
    assert '"scene_reload"' in proposal
    assert 'required: ["domain", "service"]' in proposal
    assert '"multi_choice_service_call"' in proposal
    assert "maxItems: 31" in proposal
    assert 'required: ["choice_id", "label", "domain", "service"]' in proposal
    assert 'service_data' in proposal
    assert 'return_response' in proposal
    assert '"device_test"' in proposal
    assert 'required: ["domain", "service", "entity_id", "expected_prior_state"]' in proposal
    assert "requester_override_forbidden" in proposal
    assert "HA_TELEGRAM_USER_ID" in proposal
    assert "HA_TELEGRAM_CHAT_ID" in proposal
    assert "DEFAULT_PROPOSAL_SOCKET_PATH" in proposal
    assert "ha_change_execute" not in proposal
    assert "ha_change_authorize" not in proposal


def test_change_broker_backup_retention_is_owned_bounded_and_crash_safe(
    rootfs: Path,
    repository_root: Path,
) -> None:
    source = (
        rootfs / "usr/local/share/antigravity-ha/ha-change-broker.mjs"
    ).read_text(encoding="utf-8")
    unit = (repository_root / "tests/ha_change_broker_test.mjs").read_text(
        encoding="utf-8"
    )

    for required in (
        'const BACKUP_OWNER = "antigravity-for-home-assistant"',
        'const BACKUP_KIND = "ha-config-patch"',
        "const BACKUP_RETENTION = 2",
        "BACKUP_PRUNE_QUARANTINE_PATTERN",
        "this.activeBackupIds = new Set()",
        "entry.status === \"in_progress\"",
        "async #inspectCompletedBackup(",
        "async #markBackupCompleted(",
        "async #removeCompletedBackup(",
        "async #pruneCompletedBackups(",
        "await rename(path, quarantine)",
        "await fsyncDirectory(this.backupRoot)",
        "Exact App ownership and a completed transaction were not established",
        "^sha256:[0-9a-f]{64}$",
    ):
        assert required in source
    assert "await rm(this.backupRoot" not in source
    assert source.index("await this.#loadIdempotencyState();") < source.index(
        "await this.#pruneCompletedBackups()"
    )

    for required in (
        "completed config backups retain two App-owned entries",
        "proposalIds.slice(-2).sort()",
        '"someone-else"',
        ".prune-0123456789ab",
        "isSymbolicLink(), true",
    ):
        assert required in unit


def test_change_broker_memory_transition_is_explicit(addon_root: Path) -> None:
    profile = (addon_root / "apparmor.txt").read_text(encoding="utf-8")
    change_profile = profile.split(
        "profile antigravity_home_assistant-change-broker", maxsplit=1
    )[1].split("\n}\n", maxsplit=1)[0]
    assert (
        "/usr/local/bin/ha-memory Px -> "
        "antigravity_home_assistant-memory,"
    ) in change_profile
