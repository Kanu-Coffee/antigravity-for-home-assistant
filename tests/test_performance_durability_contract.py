"""Static fail-closed contracts for the opt-in GAP-007 release harness."""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest


ROOT = Path(__file__).resolve().parents[1]
HARNESS = ROOT / "tests/performance-durability-soak.mjs"
WRAPPER = ROOT / "tests/performance-durability-soak.sh"
WORKFLOW = ROOT / ".github/workflows/ci.yaml"
GAP_REGISTER = ROOT / "docs/v2/gap-register.md"
TEST_PLAN = ROOT / "docs/v2/test-plan.md"
CHECKLIST = ROOT / "docs/v2/checklist.md"
BUDGET = ROOT / "docs/v2/performance-budget.json"
EVIDENCE_CONTRACT_PATH = ROOT / ".github/scripts/gap007_evidence_contract.py"


def load_evidence_contract() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "gap007_evidence_contract", EVIDENCE_CONTRACT_PATH
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


EVIDENCE_CONTRACT = load_evidence_contract()
IMAGE_ID = f"sha256:{'1' * 64}"
REVISION = "2" * 40
ROOTFS_DIGEST = f"sha256:{'3' * 64}"
LEAF_DIGEST = f"sha256:{'4' * 64}"
STAGE_DIGEST = f"sha256:{'5' * 64}"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_release_thresholds_provenance_and_closure_are_fail_closed() -> None:
    harness = read(HARNESS)
    wrapper = read(WRAPPER)

    for fragment in (
        "soakDurationMs: 30 * 60 * 1_000",
        "outageDurationMs: 15 * 60 * 1_000",
        "brokerRestartCount: 20",
        "release mode requires --candidate-image-id",
        "release mode must execute packaged image modules",
        'backoff_implementation: moduleOrigin === "packaged_image"',
        "const botApiFailure = results.bot_api",
        "backoff_reset_after_recovery:",
        "source tree changed while GAP-007 evidence was being collected",
        'source_tree_stable: args.mode === "contract" ? true : null',
        '"/usr/local/share/antigravity-ha/telegram-bridge.mjs"',
        'closure_eligible: false',
    ):
        assert fragment in harness, f"missing release harness contract: {fragment}"

    assert re.search(
        r"FORBIDDEN_OVERRIDE\s*=\s*/\^GAP007_.*DURATION.*OUTAGE.*RESTART"
        r".*SOAK.*THRESHOLD",
        harness,
    )
    assert len(re.findall(r"finishedProvenance\.source_tree_sha256", harness)) == 1
    assert re.search(
        r"assert\.equal\(\s*finishedProvenance\.source_tree_sha256,"
        r"\s*provenance\.source_tree_sha256,",
        harness,
    )

    for fragment in (
        '[[ -n $IMAGE && -n $EVIDENCE \\',
        'Docker Buildx is required for stable OCI image-size measurement',
        '[[ $IMAGE_ID =~ ^sha256:[0-9a-f]{64}$ ]]',
        'candidate image must use an exact registry digest',
        '--candidate-image-id "$IMAGE_ID"',
        '--candidate-leaf-digest "$CANDIDATE_LEAF_DIGEST"',
        '--candidate-stage-digest "$CANDIDATE_STAGE_DIGEST"',
        '--execution-scope packaged_image',
        'docker exec "$CONTAINER" node "$PACKAGED_HARNESS"',
        "timeout --foreground --signal=TERM --kill-after=30s 40m",
        "fixed 40-minute wall-clock limit",
        'source-rootfs-manifest.json',
        '"$MANIFEST_TOOL" verify-image',
        '.provenance.source_image_verification = $source_image_verification[0]',
        'test "$(stat -c %u:%g "$path")" = "0:0"',
        'MAX_AVERAGE_CPU_PERCENT=',
        'MAX_PEAK_RSS_BYTES=',
        'MAX_IMAGE_SIZE_BYTES=',
        'docker buildx imagetools inspect --raw',
        'runtime leaf manifest digest differs from the candidate binding',
        'application/vnd.oci.image.manifest.v1+json',
        '[.config.size, (.layers[].size)] | add',
        'candidate image size ${IMAGE_SIZE_BYTES} exceeded its fixed budget ${MAX_IMAGE_SIZE_BYTES}',
        'for ((restart_index = 1; restart_index <= 20; restart_index += 1))',
        '[[ $(docker image inspect --format \'{{.Id}}\' "$IMAGE") == "$IMAGE_ID" ]]',
        '.provenance.candidate_image_id = $image_id',
        'result: "FAIL"',
        'closure_eligible: false',
        '.closure_eligible = true',
        'completed_count: ($restart_durations | length)',
        '.resources.candidate_budget = {',
        'OVERALL_STARTED_AT_UTC=',
        'OVERALL_FINISHED_AT_UTC=',
        'OVERALL_ELAPSED_SECONDS=',
        'status --porcelain=v1 --untracked-files=all',
        'release evidence requires a clean committed repository worktree',
        'repository worktree changed during the release run',
    ):
        assert fragment in wrapper, f"missing release wrapper contract: {fragment}"

    assert wrapper.count("--network none") == 3
    assert wrapper.count("GAP007_DURATION*") == 1
    assert wrapper.count("GAP007_THRESHOLD*") == 1
    assert wrapper.count("status --porcelain=v1 --untracked-files=all") == 2
    assert wrapper.index("SOURCE_STATUS_BEFORE=") < wrapper.index(
        'docker exec "$CONTAINER" node "$PACKAGED_HARNESS"'
    )
    component_gate = wrapper.index('"$EVIDENCE_CONTRACT" component')
    candidate_restarts = wrapper.index(
        'for ((restart_index = 1; restart_index <= 20; restart_index += 1))'
    )
    closure = wrapper.index('.closure_eligible = true')
    final_gate = wrapper.index('"$EVIDENCE_CONTRACT" final')
    assert component_gate < candidate_restarts < closure < final_gate


def valid_evidence(*, closure_eligible: bool) -> dict:
    budget = json.loads(BUDGET.read_text(encoding="utf-8"))
    evidence = {
        "mode": "release",
        "result": "PASS",
        "closure_eligible": closure_eligible,
        "provenance": {
            "candidate_image_id": IMAGE_ID,
            "candidate_leaf_digest": LEAF_DIGEST,
            "candidate_stage_digest": STAGE_DIGEST,
            "candidate_architecture": "amd64",
            "candidate_revision": REVISION,
            "git_commit": REVISION,
            "source_rootfs_sha256": ROOTFS_DIGEST,
            "module_origin": "packaged_image",
            "telegram_bridge_module_path": (
                "/usr/local/share/antigravity-ha/telegram-bridge.mjs"
            ),
            "source_tree_stable": closure_eligible,
        },
        "telegram": {
            "required_elapsed_seconds": 1800,
            "actual_elapsed_seconds": 1800,
        },
        "failure_injection": {
            "required_elapsed_seconds": 900,
            "actual_elapsed_seconds": 900,
            "backoff_implementation": "packaged_telegram_bridge",
            "backoff_reset_after_recovery": True,
            "external_calls": 0,
        },
        "bounded_io": {"indexed_entities": 1000},
        "rapid_restart": {
            "required_count": 20,
            "completed_count": 20,
            "candidate_container": {
                "required_count": 20,
                "completed_count": 20,
                "pending_journal_count": 0,
                "zombie_process_count": 0,
                "stale_socket_count": 0,
            },
        },
        "resources": {
            "candidate_budget": {
                "baseline_evidence_sha256": budget["baseline_evidence_sha256"],
                "limits": budget["limits"],
                "observed": {
                    "average_cpu_percent": 1.0,
                    "peak_rss_bytes": 150_000_000,
                    "image_size_bytes": 570_000_000,
                },
                "result": "PASS",
            }
        },
    }
    if closure_eligible:
        evidence["provenance"]["source_image_verification"] = {
            "schema": "antigravity-ha-source-image-verification/v1",
            "image_id": IMAGE_ID,
            "revision": REVISION,
            "source_rootfs_sha256": ROOTFS_DIGEST,
            "verified_files": 123,
        }
    return evidence


def test_gap007_cli_wires_candidate_component_and_final_bindings(
    tmp_path: Path,
) -> None:
    candidate = subprocess.run(
        [
            sys.executable,
            str(EVIDENCE_CONTRACT_PATH),
            "candidate",
            "--image-id",
            IMAGE_ID,
            "--revision",
            REVISION,
            "--source-rootfs-sha256",
            ROOTFS_DIGEST,
            "--expected-revision",
            REVISION,
            "--expected-source-rootfs-sha256",
            ROOTFS_DIGEST,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert candidate.returncode == 0, candidate.stderr

    common = [
        "--image-id",
        IMAGE_ID,
        "--candidate-leaf-digest",
        LEAF_DIGEST,
        "--candidate-stage-digest",
        STAGE_DIGEST,
        "--revision",
        REVISION,
        "--source-rootfs-sha256",
        ROOTFS_DIGEST,
    ]
    component_path = tmp_path / "component.json"
    component_path.write_text(
        json.dumps(valid_evidence(closure_eligible=False)),
        encoding="utf-8",
    )
    component = subprocess.run(
        [
            sys.executable,
            str(EVIDENCE_CONTRACT_PATH),
            "component",
            "--evidence",
            str(component_path),
            *common,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert component.returncode == 0, component.stderr

    final_path = tmp_path / "final.json"
    final_path.write_text(
        json.dumps(valid_evidence(closure_eligible=True)),
        encoding="utf-8",
    )
    final = subprocess.run(
        [
            sys.executable,
            str(EVIDENCE_CONTRACT_PATH),
            "final",
            "--evidence",
            str(final_path),
            *common,
            "--budget",
            str(BUDGET),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert final.returncode == 0, final.stderr


def test_stale_or_revision_null_candidate_binding_is_rejected() -> None:
    EVIDENCE_CONTRACT.validate_candidate_binding(
        image_id=IMAGE_ID,
        revision=REVISION,
        source_rootfs_sha256=ROOTFS_DIGEST,
        expected_revision=REVISION,
        expected_source_rootfs_sha256=ROOTFS_DIGEST,
    )
    with pytest.raises(EVIDENCE_CONTRACT.ContractError, match="revision label"):
        EVIDENCE_CONTRACT.validate_candidate_binding(
            image_id=IMAGE_ID,
            revision="",
            source_rootfs_sha256=ROOTFS_DIGEST,
            expected_revision=REVISION,
            expected_source_rootfs_sha256=ROOTFS_DIGEST,
        )
    with pytest.raises(EVIDENCE_CONTRACT.ContractError, match="stale"):
        EVIDENCE_CONTRACT.validate_candidate_binding(
            image_id=IMAGE_ID,
            revision="4" * 40,
            source_rootfs_sha256=ROOTFS_DIGEST,
            expected_revision=REVISION,
            expected_source_rootfs_sha256=ROOTFS_DIGEST,
        )


def test_synthetic_only_component_and_missing_budget_are_rejected() -> None:
    component = valid_evidence(closure_eligible=False)
    EVIDENCE_CONTRACT.validate_component(
        component,
        image_id=IMAGE_ID,
        candidate_leaf_digest=LEAF_DIGEST,
        candidate_stage_digest=STAGE_DIGEST,
        revision=REVISION,
        source_rootfs_sha256=ROOTFS_DIGEST,
    )
    component["provenance"]["module_origin"] = "host_source_contract"
    with pytest.raises(EVIDENCE_CONTRACT.ContractError, match="host-only"):
        EVIDENCE_CONTRACT.validate_component(
            component,
            image_id=IMAGE_ID,
            candidate_leaf_digest=LEAF_DIGEST,
            candidate_stage_digest=STAGE_DIGEST,
            revision=REVISION,
            source_rootfs_sha256=ROOTFS_DIGEST,
        )

    final = valid_evidence(closure_eligible=True)
    final["provenance"].pop("source_image_verification")
    with pytest.raises(EVIDENCE_CONTRACT.ContractError, match="source-image verification"):
        EVIDENCE_CONTRACT.validate_final(
            final,
            image_id=IMAGE_ID,
            candidate_leaf_digest=LEAF_DIGEST,
            candidate_stage_digest=STAGE_DIGEST,
            revision=REVISION,
            source_rootfs_sha256=ROOTFS_DIGEST,
            budget=json.loads(BUDGET.read_text(encoding="utf-8")),
        )

    final = valid_evidence(closure_eligible=True)
    final["resources"].pop("candidate_budget")
    with pytest.raises(EVIDENCE_CONTRACT.ContractError, match="budget evidence"):
        EVIDENCE_CONTRACT.validate_final(
            final,
            image_id=IMAGE_ID,
            candidate_leaf_digest=LEAF_DIGEST,
            candidate_stage_digest=STAGE_DIGEST,
            revision=REVISION,
            source_rootfs_sha256=ROOTFS_DIGEST,
            budget=json.loads(BUDGET.read_text(encoding="utf-8")),
        )

    missing_limit = json.loads(BUDGET.read_text(encoding="utf-8"))
    missing_limit["limits"].pop("max_peak_rss_bytes")
    with pytest.raises(EVIDENCE_CONTRACT.ContractError, match="limits are missing"):
        EVIDENCE_CONTRACT.validate_budget(missing_limit)


def test_duration_override_is_rejected_before_contract_execution() -> None:
    environment = os.environ.copy()
    environment["GAP007_SOAK_SECONDS"] = "1"
    result = subprocess.run(
        [str(WRAPPER), "--mode", "contract"],
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode == 64
    assert result.stdout == ""
    assert "overrides are forbidden" in result.stderr


def test_short_ci_contract_is_mandatory_but_long_soak_is_manual_advisory() -> None:
    workflow = read(WORKFLOW)
    assert "tests/performance-durability-soak.sh" in workflow
    assert "--mode contract" in workflow
    assert 'assert.equal(evidence.closure_eligible, false);' in workflow
    assert 'assert.equal(evidence.provenance.source_tree_stable, true);' in workflow
    assert (
        'assert.equal(evidence.provenance.module_origin, "host_source_contract");'
        in workflow
    )

    gap_register = read(GAP_REGISTER)
    gap_row = next(
        line for line in gap_register.splitlines() if line.startswith("| GAP-007 |")
    )
    assert "`OPEN`" in gap_row
    assert "non-blocking advisory" in gap_row
    assert "Candidate·finalize·tag·release를 차단하지 않는다" in gap_row
    assert "일반 CI에서 계속 실행" in gap_register
    assert (
        "2c2b3fe0cb0aa2522722e192323bdb0e0a291f5d99193df603eace003dc7f8f9"
        in gap_register
    )
    assert "immutable URI가 보존돼 있지 않고" in gap_register
    assert "수동 진단 도구" in gap_register
    assert "gap007_release" in gap_register
    assert "원본 JSON이나 `gap007_release` binding이 없어도 릴리스는 진행" in gap_register
    assert "실제 HAOS와 live Bot API 검증을 대신하지 않으며" in gap_register

    test_plan = read(TEST_PLAN)
    assert "자동 release gate를 뜻하지 않는다" in test_plan
    assert "공식 Candidate와 release workflow는 이 30분 mode를 자동 실행하지 않으며" in test_plan
    assert "해당 장시간 evidence가 없다는 이유로 numeric image tag 생성을" in test_plan

    checklist = read(CHECKLIST)
    m505 = next(line for line in checklist.splitlines() if line.startswith("| M5-05 |"))
    assert "장시간 진단은 수동 advisory" in m505
