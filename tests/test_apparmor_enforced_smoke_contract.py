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
    assert "len(declarations) != 23" in smoke
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
    assert smoke.count('run_ttyd_websocket_probe "$FIRST_CONTAINER"') == 1
    assert smoke.index(
        'assert_enforced_container_ready "$FIRST_CONTAINER"'
    ) < smoke.index('run_ttyd_websocket_probe "$FIRST_CONTAINER"')
    assert smoke.index(
        'run_ttyd_websocket_probe "$FIRST_CONTAINER"'
    ) < smoke.index('run_confined_feature_probes "$FIRST_CONTAINER"')

    ttyd_client = read("tests/ttyd_websocket_smoke.py")
    for lifecycle_token in (
        "first_stream, _ = connect(sys.argv[1])",
        "send_resize(first_stream, 120, 40)",
        "second_stream, _ = connect(sys.argv[1], columns=88, rows=28)",
        "second_state[:3] != first_state[:3]",
        "send_resize(second_stream, 96, 32)",
        "resized_state[:3] != first_state[:3]",
        "reconnect=same resize=96x32 cwd=/config",
    ):
        assert lifecycle_token in ttyd_client

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
