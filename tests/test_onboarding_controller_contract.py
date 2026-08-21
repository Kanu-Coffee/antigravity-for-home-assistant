import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_onboarding_controller_smoke_covers_transaction_outcomes() -> None:
    smoke = ROOT / "tests/onboarding-controller-smoke.sh"
    stub = ROOT / "tests/fixtures/onboarding-controller-stub.sh"
    smoke_text = smoke.read_text(encoding="utf-8")
    stub_text = stub.read_text(encoding="utf-8")

    subprocess.run(["bash", "-n", str(smoke)], check=True)
    subprocess.run(["bash", "-n", str(stub)], check=True)
    assert smoke.stat().st_mode & 0o111
    assert stub.stat().st_mode & 0o111
    assert "--network none" in smoke_text
    assert "docker run --rm --interactive --tty" not in smoke_text
    assert smoke_text.count("docker run --rm --tty") == 4
    assert "synthetic native; real HAOS remains NOT RUN" in smoke_text
    for case, status in (
        ("success", 0),
        ("incomplete", 76),
        ("unexpected", 42),
        ("timeout", 124),
    ):
        assert f"run_case {case} {status}" in smoke_text
        assert f"{case})" in stub_text
    assert "run_quarantine_case" in smoke_text
    assert "finalize_privacy_case" in smoke_text
    assert "did not retain the privacy quarantine" in smoke_text
    assert "privacy quarantine allowed a normal session" in smoke_text
    assert "--privacy-finalize" in smoke_text
    for case, status in (
        ("upgrade-oauth", 0),
        ("upgrade-complete", 0),
        ("marker-without-oauth", 70),
        ("enterprise", 70),
    ):
        assert f"run_upgrade_baseline_case {case} {status}" in smoke_text
        assert f"{case})" in stub_text
    assert "settings.json.onboarding.tmp" in smoke_text
    assert "antigravity-oauth-token.onboarding.tmp" in smoke_text
    assert "onboarding.json.onboarding.tmp" in smoke_text
    assert "onboarding-home -mindepth 1" in smoke_text
    assert "antigravity-native-session-guard" in smoke_text
    assert "status == 78" in smoke_text
    assert "futureSecurityPolicy" in stub_text
    docker_smoke = (ROOT / "tests/docker-smoke.sh").read_text(encoding="utf-8")
    assert 'tests/native-settings-atomic-rename-smoke.sh "${IMAGE}"' in (
        docker_smoke
    )
    assert 'tests/onboarding-controller-smoke.sh "${IMAGE}"' in docker_smoke
    assert 'tests/onboarding-transaction-smoke.sh "${IMAGE}"' in docker_smoke
    assert (
        'tests/onboarding-restart-reconciliation-smoke.sh "${IMAGE}"'
        in docker_smoke
    )
    assert 'tests/onboarding-tmux-privacy-smoke.sh "${IMAGE}"' in docker_smoke
    assert (
        '"{\\"consumerOnboardingComplete\\":true,'
        '\\"enterpriseOnboardingComplete\\":false}"' in docker_smoke
    )


def test_onboarding_restart_and_tmux_privacy_smokes_are_dynamic() -> None:
    restart = ROOT / "tests/onboarding-restart-reconciliation-smoke.sh"
    tmux = ROOT / "tests/onboarding-tmux-privacy-smoke.sh"
    stub = ROOT / "tests/fixtures/onboarding-tmux-controller-stub.sh"
    for script in (restart, tmux, stub):
        subprocess.run(["bash", "-n", str(script)], check=True)
        assert script.stat().st_mode & 0o111

    restart_text = restart.read_text(encoding="utf-8")
    for evidence in (
        "run_init partial",
        "run_init reconciled",
        "marker partial",
        "marker restart",
        "onboarding-active.tmp",
        "--privacy-finalize >/dev/null 2>&1",
        "restart-required",
    ):
        assert evidence in restart_text

    tmux_text = tmux.read_text(encoding="utf-8")
    for evidence in (
        "web-chain",
        "/usr/local/bin/tmux-session-shell",
        "TARGET-PRELOGIN-HISTORY-CANARY",
        "NEIGHBOR-HISTORY-CANARY",
        "privacy-mismatch",
        "privacy-sigkill",
        "capture-pane -p -S -",
    ):
        assert evidence in tmux_text


def test_onboarding_transaction_smoke_covers_no_secret_crash_prefixes() -> None:
    smoke = ROOT / "tests/onboarding-transaction-smoke.sh"
    text = smoke.read_text(encoding="utf-8")
    subprocess.run(["bash", "-n", str(smoke)], check=True)
    assert smoke.stat().st_mode & 0o111
    for prefix in ("s0", "s1", "s2"):
        assert f"{prefix}) blocker=" in text
    assert "run_complete_before_finalize_case" in text
    assert 'test "$(node "$helper" status)" = partial' in text
    assert 'test "$(node "$helper" status)" = complete-restart' in text
    assert 'test "$(node "$helper" status)" = complete' in text
    assert 'test "$(node "$helper" finalize)" = restart-required' in text
    assert 'find "$transaction" -type f -name "*oauth*"' in text
    assert "consumerOnboardingComplete\\\":false" in text
    assert "wc -l" in text
    assert "real HAOS remains NOT RUN" in text


def test_controller_commits_only_validated_complete_consumer_state() -> None:
    controller = (
        ROOT
        / "antigravity_home_assistant/rootfs/usr/local/libexec/"
        "antigravity-onboarding-controller"
    ).read_text(encoding="utf-8")

    status_gate = '[[ ${native_status} == 0 || ${native_status} == 130 ]]'
    consumer_gate = '[[ ${current_consumer} == true ]]'
    oauth_gate = '[[ ${current_consumer} == true && ${current_oauth} == absent ]]'
    assert status_gate in controller
    assert consumer_gate in controller
    assert oauth_gate in controller
    gate_index = controller.index(status_gate)
    for destination in ("REAL_SETTINGS", "REAL_OAUTH", "REAL_ONBOARDING"):
        assert controller.index(f'"${{{destination}}}"', gate_index) > gate_index
    assert "onboarding_committed=false" in controller
    assert "exit 76" in controller


def test_settings_invariant_preserves_exact_json_numbers() -> None:
    result = subprocess.run(
        ["node", str(ROOT / "tests/onboarding-settings-fingerprint-test.mjs")],
        check=True,
        capture_output=True,
        text=True,
    )
    assert result.stdout == "onboarding settings fingerprint: PASS\n"
    helper = (
        ROOT
        / "antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/"
        "onboarding-settings-fingerprint.mjs"
    ).read_text(encoding="utf-8")
    assert "O_NOFOLLOW" in helper
    assert "nativeParseJsonContent" in helper
    assert "isNativeRawJsonNumber" in helper
    assert "canonicalExactNumber" in helper
    assert "delete invariant.enableTelemetry" in helper
    assert "900719925474099" not in helper
