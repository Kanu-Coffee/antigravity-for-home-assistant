import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_native_settings_atomic_rename_smoke_is_synthetic_and_offline() -> None:
    smoke_path = ROOT / "tests/native-settings-atomic-rename-smoke.sh"
    smoke = smoke_path.read_text(encoding="utf-8")

    subprocess.run(["bash", "-n", str(smoke_path)], check=True)
    assert "--network none" in smoke
    assert "--read-only" in smoke
    assert "--security-opt no-new-privileges" in smoke
    assert "AGY_CLI_DISABLE_AUTO_UPDATE=true" in smoke
    assert "GEMINI_API_KEY" not in smoke
    assert "GOOGLE_GEMINI_BASE_URL" not in smoke
    assert "SUPERVISOR_TOKEN" not in smoke
    assert "auth.json" not in smoke


def test_native_settings_atomic_rename_smoke_has_deny_and_allow_controls() -> None:
    smoke = (
        ROOT / "tests/native-settings-atomic-rename-smoke.sh"
    ).read_text(encoding="utf-8")

    for required in (
        'deny) install -d -m 1777 "$settings_directory"',
        'allow) install -d -m 0777 "$settings_directory"',
        "for telemetry_value in false true",
        'settings.enableTelemetry = process.env.TELEMETRY_VALUE === "true"',
        '--argjson telemetry "$telemetry_value"',
        '(has("enableTelemetry") | not)',
        "--reuid=65534 --regid=65534 --clear-groups",
        "/usr/local/libexec/antigravity-real agent",
        'grep -Eq "^EVENT (change|rename) temporary$"',
        '[[ $WATCH_HASH_BEFORE == "$WATCH_HASH_AFTER" ]]',
        '[[ $WATCH_HASH_BEFORE != "$WATCH_HASH_AFTER" ]]',
        'grep -Fqx "EVENT rename final"',
        "settings.json.*.tmp",
        "restart=repeat",
        "restart=idempotent",
    ):
        assert required in smoke


def test_native_settings_watcher_redacts_random_temporary_names() -> None:
    watcher = (
        ROOT / "tests/fixtures/native-settings-atomic-watch.mjs"
    ).read_text(encoding="utf-8")

    assert 'name === "settings.json"' in watcher
    assert "temporaryPattern.test" in watcher
    assert "EVENT ${eventType} final" in watcher
    assert "EVENT ${eventType} temporary" in watcher
    assert "process.stdout.write(`EVENT ${eventType} ${name}" not in watcher
