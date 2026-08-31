from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_enforced_smoke_loads_and_cleans_up_v3_profiles() -> None:
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
        '"${name} (enforce)"',
        "trap cleanup EXIT",
        "unexpected primary AppArmor declarations",
        "unexpected v3 AppArmor profile set",
        "len(declarations) != 17",
        "generated profile label already exists",
    ):
        assert token in smoke


def test_enforced_smoke_covers_remote_ingress_and_token_boundary() -> None:
    smoke = read("tests/apparmor-enforced-smoke.sh")

    for readiness in (
        "Starting Antigravity Remote Control service",
        "Antigravity Remote Control is waiting for ha-antigravity-remote-login.",
        "Starting the isolated Home Assistant read broker",
        "Starting the authenticated Ingress reverse proxy",
        "Starting ttyd on the loopback interface",
        "/config/secrets.yaml",
        "/data/home/.gemini/jetski-standalone-oauth-token",
        "remote-token-denial-canary",
        "the native-only Remote token",
        "apparmor=unconfined",
        "antigravity_home_assistant-command",
        "antigravity_home_assistant-ha-helper",
        "antigravity_home_assistant-read-broker-bootstrap",
        "antigravity_home_assistant-file-client",
        "antigravity_home_assistant-memory",
        "antigravity_home_assistant-browser",
        "antigravity_home_assistant-shell",
        "real HAOS remains NOT RUN",
    ):
        assert readiness in smoke

    assert '"remote_control_name":"home-assistant"' in smoke
    assert '"antigravity_sensitive_data_access":false' in smoke
    assert '"home_assistant_browser_auto_auth":false' in smoke
    assert '"log_level":"info"' in smoke


def test_enforced_smoke_contains_no_retired_channel_probes() -> None:
    smoke = read("tests/apparmor-enforced-smoke.sh")

    for retired in (
        "ha-change-broker",
        "change-proposal",
        "telegram",
        "ssh-keygen",
        "sshd",
        "onboarding",
        "agy-settings",
    ):
        assert retired not in smoke.lower()

    assert 'docker rm --force "${CONTAINER}"' in smoke
    assert 'docker volume rm --force \\\n    "${DATA_VOLUME}"' in smoke
    assert 'rm -rf -- "${WORK_DIR}"' in smoke
