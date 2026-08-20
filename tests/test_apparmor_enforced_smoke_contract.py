from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_enforced_smoke_loads_and_cleans_up_a_real_kernel_profile() -> None:
    smoke_path = ROOT / "tests/apparmor-enforced-smoke.sh"
    smoke = smoke_path.read_text(encoding="utf-8")

    assert smoke_path.stat().st_mode & 0o111
    for token in (
        "the AppArmor kernel module is not enabled",
        "Docker does not advertise AppArmor enforcement",
        "passwordless sudo is required to load the kernel AppArmor profile",
        "sudo -n true",
        "apparmor_parser --replace --skip-cache",
        "apparmor_parser --remove --skip-cache",
        '--security-opt "apparmor=${PROFILE_NAME}"',
        "/sys/kernel/security/apparmor/profiles",
        '/bin/cat /proc/1/attr/current',
        '"${PROFILE_NAME} (enforce)"',
        "trap cleanup EXIT",
    ):
        assert token in smoke

    assert "Mirror Supervisor's adjust_profile implementation" in smoke
    assert 'r"^profile antigravity_home_assistant(?= )"' in smoke
    assert "len(declarations) != 24" in smoke
    assert 'source.replace("antigravity_home_assistant", profile_name)' not in smoke
    host_checks = smoke.split("require_enforcement_host() {", 1)[1].split(
        "\n}", 1
    )[0]
    assert "return 0" not in host_checks
    assert host_checks.count("|| fail") >= 6
    assert "unexpected primary AppArmor declarations" in smoke
    assert "generated profile label already exists" in smoke


def test_enforced_smoke_requires_two_clean_startups_and_a_denial_canary() -> None:
    smoke = read("tests/apparmor-enforced-smoke.sh")

    assert 'start_container "$FIRST_CONTAINER"' in smoke
    assert 'start_container "$RESTART_CONTAINER"' in smoke
    assert 'docker rm --force "$FIRST_CONTAINER"' in smoke
    assert 'docker restart "$FIRST_CONTAINER"' in smoke
    assert 'assert_enforced_container_ready "$FIRST_CONTAINER" 2' in smoke
    assert 'docker rm --force "$FIRST_CONTAINER"' in smoke
    assert 'start_container "$RESTART_CONTAINER"' in smoke
    assert smoke.count("assert_enforced_container_ready") == 4
    for readiness in (
        "antigravity runtime ready:",
        "Starting the isolated Home Assistant change broker",
        "Starting the isolated Home Assistant read broker",
        "Starting the authenticated Ingress reverse proxy",
        "Starting ttyd on the loopback interface",
        "/package/admin/s6/command/s6-svscan",
        "/usr/bin/node /usr/local/share/antigravity-ha/ha-change-broker.mjs",
        "/usr/bin/node /usr/local/share/antigravity-ha/ha-read-broker.mjs",
        "bash /usr/bin/bashio ./run ha-memoryd",
        "nginx: master process",
        "ttyd --interface 127.0.0.1 --port 7682",
        "s6-pause",
        'docker top "$container" -eo pid,args',
    ):
        assert readiness in smoke

    assert "apparmor-denial-canary-no-secret" in smoke
    assert "/config/secrets.yaml" in smoke
    assert "audit deny /config/secrets.yaml rwklm," in smoke
    assert "primary AppArmor denial canary rule drifted" in smoke
    for fatal in (
        "s6-mkdir: warning: unable to mkdir",
        "s6-overlay-suexec: fatal",
        "exec: fatal: unable to exec",
        "s6-rc: warning: unable to start service",
        "fatal: stopping the container",
    ):
        assert fatal in smoke
    assert "real HAOS remains NOT RUN" in smoke
    assert "/usr/lib/bashio/bashio" in smoke
    assert "/package/admin/s6-overlay-3.2.2.0/command/with-contenv" in smoke
    assert "assert_relevant_audit_denials" in smoke
    assert "capture_relevant_audit_denials" in smoke
    assert "print_failure_audit_denials" in smoke
    failure_body = smoke.split("fail() {", 1)[1].split("\n}", 1)[0]
    assert failure_body.index("print_failure_audit_denials") < failure_body.index(
        "exit 1"
    )
    failure_audit_body = smoke.split("print_failure_audit_denials() {", 1)[1].split(
        "\n}", 1
    )[0]
    assert "Relevant AppArmor audit denials captured before profile cleanup" in (
        failure_audit_body
    )
    assert 'redact_probe_output < "$relevant_log"' in failure_audit_body
    capture_body = smoke.split("capture_relevant_audit_denials() {", 1)[1].split(
        "\n}", 1
    )[0]
    assert 'journalctl --dmesg --since "@${AUDIT_START_EPOCH}"' in capture_body
    assert 'grep -F "profile=\\"${name}\\""' in capture_body
    assert (
        "kernel journal unavailable; cannot prove the absence of unexpected "
        "AppArmor denials" in smoke
    )
    assert "unexpected AppArmor audit denial" in smoke
    assert (
        "kernel audit did not capture the AppArmor denial positive control"
        in smoke
    )
    assert "apparmor-enforced-smoke-token-do-not-use" in smoke
    assert "[REDACTED_HOME_ASSISTANT_TOKEN]" in smoke
    assert '--env "SUPERVISOR_TOKEN=${SUPERVISOR_TOKEN}"' in smoke
    assert "run_helper_credential_boundary_probe" in smoke
    assert "--security-opt apparmor=antigravity_home_assistant-ha-helper" in smoke
    assert "the ha-helper Supervisor credential read-only boundary failed" in smoke
    assert "run_settings_update_probe" in smoke
    assert 'run_settings_update_probe "$FIRST_CONTAINER"' in smoke
    assert "/usr/local/bin/agy-settings patch" in smoke
    # runc attaches the container's primary profile to the first docker-exec
    # image. Start with env so the helper's child exec exercises its Px
    # transition into the dedicated settings-update profile.
    assert smoke.count(
        "/usr/bin/env \\\n    /usr/local/bin/agy-settings sha256"
    ) == 6
    assert (
        "/usr/bin/env \\\n        /usr/local/bin/agy-settings patch" in smoke
    )
    assert 'docker exec "$container" /usr/local/bin/agy-settings' not in smoke
    assert (
        'docker exec "$container" \\\n    /usr/local/bin/agy-settings' not in smoke
    )
    assert smoke.count("--security-opt apparmor=unconfined") == 2
    assert smoke.count('--volume "${DATA_VOLUME}:/data:ro"') == 2
    assert "assert_no_native_settings_temporary" in smoke
    assert "native worker rewrote canonical settings" in smoke
    assert "settings.json.*.tmp" in smoke


def test_enforced_smoke_exercises_ssh_browser_feedback_and_accounting() -> None:
    smoke = read("tests/apparmor-enforced-smoke.sh")

    for ttyd_token in (
        "run_ttyd_websocket_probe",
        "tests/ttyd_websocket_smoke.py",
        'nsenter --target "$container_pid" --net --',
        "ws://127.0.0.1:7682/ws",
        "reconnect=same resize=96x32 cwd=/config",
        "the confined loopback ttyd WebSocket/PTY probe failed",
    ):
        assert ttyd_token in smoke
    ttyd_probe = smoke.split("run_ttyd_websocket_probe() {", 1)[1].split(
        "\n}", 1
    )[0]
    preflight = smoke.split("require_enforcement_host() {", 1)[1].split(
        "\n}", 1
    )[0]
    assert preflight.count("command -v python3") == 1
    assert "PYTHON3_BIN=$(command -v python3 2>/dev/null || true)" in preflight
    assert "[[ -n $PYTHON3_BIN && -x $PYTHON3_BIN ]]" in preflight
    assert "readonly PYTHON3_BIN" in preflight
    assert '"$PYTHON3_BIN" "$TTYD_WEBSOCKET_SMOKE"' in ttyd_probe
    assert "/usr/bin/python3" not in ttyd_probe
    assert "--mount" not in ttyd_probe
    assert "docker port" not in ttyd_probe
    ttyd_client = read("tests/ttyd_websocket_smoke.py")
    assert smoke.count('run_ttyd_websocket_probe "$FIRST_CONTAINER"') == 1
    assert smoke.index(
        'assert_enforced_container_ready "$FIRST_CONTAINER"'
    ) < smoke.index('run_ttyd_websocket_probe "$FIRST_CONTAINER"')
    assert smoke.index(
        'run_ttyd_websocket_probe "$FIRST_CONTAINER"'
    ) < smoke.index('run_confined_feature_probes "$FIRST_CONTAINER"')
    assert smoke.index(
        'run_ttyd_websocket_probe "$FIRST_CONTAINER"'
    ) < smoke.index('run_native_cli_probe "$FIRST_CONTAINER" restricted')
    ttyd_command = ttyd_client.split(
        "def query_antigravity_canary(", maxsplit=1
    )[1].split("pattern = re.compile", maxsplit=1)[0]
    assert ttyd_command.index("/usr/local/bin/antigravity;") < ttyd_command.index(
        "/usr/local/bin/antigravity --version"
    )
    for lifecycle_token in (
        "first_stream, _ = connect(sys.argv[1])",
        "send_resize(first_stream, 120, 40)",
        "second_stream, _ = connect(sys.argv[1], columns=88, rows=28)",
        "second_state[:3] != first_state[:3]",
        "send_resize(second_stream, 96, 32)",
        "resized_state[:3] != first_state[:3]",
        "query_antigravity_canary(",
        "/usr/local/bin/antigravity --version",
        "/usr/bin/timeout --kill-after=2 5 /usr/local/bin/antigravity",
        "/usr/bin/timeout --kill-after=2 15 /usr/local/bin/ha-config-check",
        "/usr/bin/timeout --kill-after=2 15 /usr/local/bin/ha-core-logs 1",
        "tui_status not in (1, 124)",
        "not 0 <= helper_status <= 124",
        "not 0 <= log_status <= 124",
        "Antigravity Web PTY canary output exceeded 1 MiB",
        "FORBIDDEN_SETTINGS_PROMPTS",
        "continue with default settings",
        "Antigravity Web PTY TUI rewrote settings.json",
        "/usr/local/bin/agy-settings sha256",
        "settings_hash_before",
        "reconnect=same resize=96x32 cwd=/config",
    ):
        assert lifecycle_token in ttyd_client
    assert "the ttyd WebSocket PTY TUI rewrote canonical settings" in smoke
    assert 'assert_no_native_settings_temporary \'ttyd WebSocket PTY TUI\'' in smoke

    for ssh_token in (
        "generate_disposable_ssh_key",
        "ssh-keygen -q -t ed25519",
        '"authorized_keys": [public_key]',
        "Enabled public-key SSH with 1 authorized key(s)",
        "Starting public-key-only OpenSSH server",
        "sshd: /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config",
        "IdentitiesOnly=yes",
        "RequestTTY=force",
        "root@127.0.0.1",
        "APPARMOR_SSH_AUTHENTICATED",
        "antigravity_home_assistant-shell (enforce)",
    ):
        assert ssh_token in smoke

    for accounting_token in (
        '"${container}:/run/utmp"',
        '"${container}:/var/log/wtmp"',
        "test -s /run/utmp",
        "test -s /var/log/wtmp",
        "tmux -L apparmor-enforced-accounting new-session",
        "APPARMOR_ACCOUNTING_FILES_ACTIVE",
        "APPARMOR_TMUX_ACCOUNTING",
    ):
        assert accounting_token in smoke

    for playwright_token in (
        "tests/playwright_mcp_smoke.mjs",
        "/tmp/playwright_mcp_smoke.mjs",
        "/usr/local/bin/ha-playwright-mcp",
        '\"status\":\"passed\"',
        "the real Playwright MCP probe failed under AppArmor enforcement",
    ):
        assert playwright_token in smoke

    for feedback_token in (
        "tests/fixtures/ha_feedback_bug.json",
        "/usr/local/bin/ha-feedback collect bug",
        "/usr/local/bin/ha-feedback validate",
        "/config/antigravity-workspace/feedback/",
        '.valid == true and .kind == "bug" and .privacy == "PASS"',
    ):
        assert feedback_token in smoke

    feedback_probe = smoke.split("run_feedback_probe() {", 1)[1].split(
        "\n}", 1
    )[0]
    assert feedback_probe.count('docker exec "$container" /usr/bin/env') == 2
    assert feedback_probe.count("/usr/local/bin/ha-feedback") == 2

    assert 'run_confined_feature_probes "$FIRST_CONTAINER"' in smoke
    assert smoke.index('run_confined_feature_probes "$FIRST_CONTAINER"') < smoke.index(
        "assert_relevant_audit_denials\n"
    )
    assert "ha-feedback submit" not in smoke
    assert "[REDACTED_HOME_ASSISTANT_TOKEN]" in smoke


def test_enforced_smoke_executes_both_native_cli_px_paths() -> None:
    smoke = read("tests/apparmor-enforced-smoke.sh")

    for token in (
        "run_native_cli_probe",
        'run_native_cli_probe "$FIRST_CONTAINER" restricted',
        'run_native_cli_probe "$FIRST_CONTAINER" sensitive',
        "enable_sensitive_data_access_fixture",
        "/run/antigravity-ha/sensitive-data-access.enabled",
        "0:400:1",
        "/usr/bin/env /usr/local/bin/antigravity --version",
        "EXPECTED_ANTIGRAVITY_VERSION=1.1.13",
        "--output-format stream-json",
        "--print-timeout 5s",
        "--disable-slash-commands",
        "Error: authentication required. Run 'antigravity-real' to log in, then retry.",
        "authentication failed or timed out",
        "did not return rc=1 without a signal",
    ):
        assert token in smoke

    native_probe = smoke.split("run_native_cli_probe() {", 1)[1].split(
        "\n}", 1
    )[0]
    assert native_probe.count("/usr/bin/env /usr/local/bin/antigravity") == 2
    assert "stream_status != 1" in native_probe
    assert "stream_status == 139" in native_probe
    assert "received SIGSEGV (rc=139)" in native_probe
    assert '$(< "$stream_stderr") == "$ANTIGRAVITY_AUTH_REQUIRED_MARKER"' in (
        native_probe
    )
    assert 'wc -l < "$stream_stdout"' in native_probe
    assert '.result.status == "ERROR"' in native_probe
    assert '.result.num_turns == 0' in native_probe

    restricted_call = smoke.index(
        'run_native_cli_probe "$FIRST_CONTAINER" restricted'
    )
    option_change = smoke.index("enable_sensitive_data_access_fixture\n")
    restart = smoke.index('docker restart "$FIRST_CONTAINER"')
    sensitive_call = smoke.index(
        'run_native_cli_probe "$FIRST_CONTAINER" sensitive'
    )
    final_audit = smoke.rindex("assert_relevant_audit_denials\n")
    assert restricted_call < option_change < restart < sensitive_call < final_audit


def test_enforced_smoke_bootstraps_the_managed_change_proposal_mcp() -> None:
    smoke = read("tests/apparmor-enforced-smoke.sh")

    for token in (
        "run_managed_change_proposal_mcp_probe",
        'run_managed_change_proposal_mcp_probe "$FIRST_CONTAINER"',
        "apparmor=antigravity_home_assistant-interactive-runtime-restricted",
        "--entrypoint /usr/bin/env",
        '"$IMAGE" /usr/local/bin/ha-change-proposal-mcp',
        "ANTIGRAVITY_HA_CHANNEL=telegram",
        '"method":"initialize"',
        '"method":"tools/list"',
        'serverInfo.name == "antigravity-ha-change-proposal"',
        'index("ha_change_propose")',
        "failed under AppArmor enforcement",
        "returned an invalid handshake",
    ):
        assert token in smoke

    probe = smoke.split(
        "run_managed_change_proposal_mcp_probe() {", 1
    )[1].split("\n}", 1)[0]
    assert "Docker/runc applies the requested profile to the first exec" in probe
    assert probe.index("--entrypoint /usr/bin/env") < probe.index(
        '"$IMAGE" /usr/local/bin/ha-change-proposal-mcp'
    )
    assert "tools/call" not in probe
    assert "SUPERVISOR_TOKEN=" not in probe
    assert 'grep -Fq "$SUPERVISOR_TOKEN"' in probe
    assert '--volume "${CONFIG_VOLUME}:/config"' in probe
    assert '--volume "${DATA_VOLUME}:/data"' in probe

    native_call = smoke.index('run_native_cli_probe "$FIRST_CONTAINER" restricted')
    proposal_call = smoke.index(
        'run_managed_change_proposal_mcp_probe "$FIRST_CONTAINER"'
    )
    final_audit = smoke.rindex("assert_relevant_audit_denials\n")
    assert native_call < proposal_call < final_audit


def test_enforced_smoke_proves_the_operational_blacklist_and_every_managed_mcp(
) -> None:
    smoke = read("tests/apparmor-enforced-smoke.sh")

    for volume in (
        '"${SHARE_VOLUME}:/share"',
        '"${MEDIA_VOLUME}:/media"',
        '"${BACKUP_VOLUME}:/backup"',
    ):
        assert volume in smoke
    for token in (
        "run_operational_blacklist_probe",
        "APPARMOR_OPERATIONAL_BLACKLIST_PASS",
        "exercise_write_and_exec",
        "for root in /config /data/home /share /media /tmp /var/tmp",
        "/config/ordinary-secret-link",
        "/config/ordinary-storage-link",
        "/config/.storage/core.config",
        "/config/home-assistant_v2.db",
        "/data/options.json",
        "/run/antigravity-ha/supervisor.token",
        "/data/home/.gemini/antigravity-cli/oauth-unknown-backend.json",
        "/data/home/.gemini/antigravity-cli/auth.json",
        "/data/home/.gemini/antigravity-cli/cli.log",
        "/data/home/.gemini/config/mcp_config.json",
        "/config/ha-files-storage-link",
        "/config/ha-files-oauth-link",
        "/config/ha-files-cloud-link",
        "/config/ha-files-storage-hardlink",
        "/config/ha-files-nonroot-readable.txt",
        "ordinary-nonroot-file-mcp-canary",
        "managed-nonroot-file-write-pass",
        "65534:65534:600",
        "cloud-credential-denial-canary",
        "/data/home/.config/gh/hosts.yml",
        "/data/home/.gnupg/private-keys-v1.d",
        "/data/home/.pypirc",
        "/data/home/.git-credentials",
        "/usr/local/share/antigravity-ha/AGENTS.md",
        '"/proc/${other_pid}/environ"',
        '"/proc/${other_pid}/fd"',
        '"/proc/${other_pid}/root/etc/os-release"',
        '"/proc/${other_pid}/root/data/options.json"',
        '"/proc/${other_pid}/map_files"',
        '"/proc/${other_pid}/task/${other_tid}/environ"',
        '"/proc/${other_pid}/task/${other_tid}/fd"',
        '"/proc/${other_pid}/task/${other_tid}/root/etc/os-release"',
        '"/proc/${other_pid}/task/${other_tid}/root/data/options.json"',
        '"/proc/${other_pid}/task/${other_tid}/map_files"',
        "/proc/thread-self/environ",
        "/proc/thread-self/fd",
        "/proc/thread-self/root/etc/os-release",
        "/proc/thread-self/root/data/options.json",
        "/proc/thread-self/map_files",
    ):
        assert token in smoke

    for token in (
        "run_managed_read_validate_memory_mcp_probes",
        "run_managed_file_mcp_probe",
        "antigravity-ha-files",
        '"text":"managed-file-write-pass\\n"',
        '"text":"managed-nonroot-file-write-pass\\n"',
        "ha_files_read_text",
        "ha_files_list",
        "ha_files_write_text",
        "APPARMOR_ARBITRARY_MCP_CHILD_PASS",
        '"ordinary-child-pass\\n"',
        '"APPARMOR_ARBITRARY_MCP_CHILD_PASS\\n"',
        "apparmor=antigravity_home_assistant-file-client",
        "ha-read-mcp|antigravity-ha-read|ha_read_system_info|",
        "ha-validate-mcp|antigravity-ha-validate|ha_validate_config|{}",
        '"id":"call","method":"tools/call"',
        '"name":"memory_status"',
        "the managed memory MCP did not complete its synthetic actual call",
        "run_managed_change_proposal_mcp_probe",
        "run_managed_telegram_action_proposal_mcp_probe",
        "antigravity-telegram-action-proposal",
        'index("telegram_action_propose")',
    ):
        assert token in smoke

    assert '"text":"managed-file-write-pass\\\\n"' not in smoke
    assert '"text":"managed-nonroot-file-write-pass\\\\n"' not in smoke
    assert '"ordinary-child-pass\\\\n"' not in smoke
    assert '"APPARMOR_ARBITRARY_MCP_CHILD_PASS\\\\n"' not in smoke

    final_audit = smoke.rindex("assert_relevant_audit_denials\n")
    for unconditional_call in (
        "run_operational_blacklist_probe\n",
        'run_managed_read_validate_memory_mcp_probes "$FIRST_CONTAINER"\n',
        'run_managed_file_mcp_probe "$FIRST_CONTAINER"\n',
        'run_managed_change_proposal_mcp_probe "$FIRST_CONTAINER"\n',
        'run_managed_telegram_action_proposal_mcp_probe "$FIRST_CONTAINER"\n',
        'run_ttyd_websocket_probe "$FIRST_CONTAINER"\n',
    ):
        assert smoke.rindex(unconditional_call) < final_audit

    ttyd_probe = smoke.split("run_ttyd_websocket_probe() {", 1)[1].split(
        "\n}", 1
    )[0]
    assert "antigravity=${EXPECTED_ANTIGRAVITY_VERSION} version_status=0" in (
        ttyd_probe
    )
    assert (
        "tui_status=(1|124) helper_status=([0-9]|[1-9][0-9]|1[01][0-9]|12[0-4]) "
        "log_status=([0-9]|[1-9][0-9]|1[01][0-9]|12[0-4])"
        in ttyd_probe
    )


def test_ci_and_candidate_require_enforcement_against_exact_images() -> None:
    ci = read(".github/workflows/ci.yaml")
    candidate = read(".github/workflows/build-app.yaml")

    assert "amd64-independent-smokes:" in ci
    assert ci.count("- apparmor-enforced") == 1
    assert (
        "exec bash tests/apparmor-enforced-smoke.sh "
        "antigravity-for-home-assistant:test"
    ) in ci
    static_parse = ci.split(
        "      - name: Parse the enforcing AppArmor profile\n", 1
    )[1].split("\n      - name: ", 1)[0]
    assert "if ! command -v apparmor_parser >/dev/null 2>&1; then" in static_parse
    assert "sudo apt-get update" not in static_parse
    assert "Acquire::Retries=2" in static_parse
    assert "Acquire::http::Timeout=15" in static_parse
    assert "Acquire::https::Timeout=15" in static_parse
    assert static_parse.count("timeout --signal=TERM --kill-after=10s 120s") == 2
    assert 'apt-get "${apt_options[@]}" update' in static_parse
    assert 'apt-get "${apt_options[@]}" install' in static_parse
    assert "--yes --no-install-recommends apparmor" in static_parse
    assert static_parse.count("command -v apparmor_parser >/dev/null 2>&1") == 2
    assert static_parse.rindex("command -v apparmor_parser") < static_parse.index(
        "sudo apparmor_parser"
    )
    assert "packages+=(apparmor)" in ci
    assert "if ((${#packages[@]} > 0)); then" in ci
    assert "timeout --signal=TERM --kill-after=10s 120s" in ci

    assert candidate.count("suite: apparmor-enforced") == 2
    assert (
        "{os: ubuntu-24.04, platform: linux/amd64, ha_arch: amd64, "
        "suite: apparmor-enforced}"
    ) in candidate
    assert (
        "{os: ubuntu-24.04-arm, platform: linux/arm64, ha_arch: aarch64, "
        "suite: apparmor-enforced}"
    ) in candidate
    assert "if: matrix.suite == 'apparmor-enforced'" in candidate
    candidate_install = candidate.split(
        "      - name: Install AppArmor enforcement tooling\n", 1
    )[1].split("\n      - name: ", 1)[0]
    assert "if ! command -v apparmor_parser >/dev/null 2>&1; then" in (
        candidate_install
    )
    assert "sudo apt-get update" not in candidate_install
    assert "Acquire::Retries=2" in candidate_install
    assert "Acquire::http::Timeout=15" in candidate_install
    assert "Acquire::https::Timeout=15" in candidate_install
    assert (
        candidate_install.count("timeout --signal=TERM --kill-after=10s 120s")
        == 2
    )
    assert 'apt-get "${apt_options[@]}" update' in candidate_install
    assert 'apt-get "${apt_options[@]}" install' in candidate_install
    assert "--yes --no-install-recommends apparmor" in candidate_install
    assert candidate_install.rstrip().endswith(
        "command -v apparmor_parser >/dev/null 2>&1"
    )
    assert (
        'apparmor-enforced) exec bash tests/apparmor-enforced-smoke.sh "$image"'
        in candidate
    )
    assert "Pull the exact generic candidate digest" in candidate
    assert "- exact-digest-smoke" in candidate
