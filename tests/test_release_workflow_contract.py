import importlib.util
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


def load_release_contract(repository_root: Path):
    path = repository_root / ".github/scripts/release_contract.py"
    spec = importlib.util.spec_from_file_location("release_contract_v3", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def candidate_fixture() -> dict:
    source_sha = "b" * 40
    digest = "sha256:" + "a" * 64
    return {
        "schema": "antigravity-ha-release-candidate/v3",
        "version": "3.0.0",
        "source_sha": source_sha,
        "run_id": 1,
        "run_attempt": 1,
        "candidate_tag": f"candidate-{source_sha}-1-1",
        "images": {
            "generic": {
                "name": "ghcr.io/kanu-coffee/antigravity-for-home-assistant",
                "digest": digest,
            },
            "amd64": {
                "name": "ghcr.io/kanu-coffee/amd64-antigravity-for-home-assistant",
                "platform": "linux/amd64",
                "stage_digest": "sha256:" + "c" * 64,
                "runtime_digest": "sha256:" + "d" * 64,
            },
            "aarch64": {
                "name": "ghcr.io/kanu-coffee/aarch64-antigravity-for-home-assistant",
                "platform": "linux/arm64",
                "stage_digest": "sha256:" + "e" * 64,
                "runtime_digest": "sha256:" + "f" * 64,
            },
        },
        "haos_rehearsal": {
            "version": "3.0.0-candidate.1.1",
            "image": "ghcr.io/kanu-coffee/antigravity-for-home-assistant",
            "digest": digest,
            "repository_manifest_sha256": "sha256:" + "1" * 64,
            "repository_archive_sha256": "sha256:" + "2" * 64,
        },
        "automated_gates": {
            "exact_digest_smoke": "PASS",
            "native_arm64_full_feasible": "PASS",
            "source_quality": "PASS",
            "spdx_leaf_sbom": "PASS",
        },
    }


def test_release_contract_uses_two_architecture_acceptance_gates(
    repository_root: Path,
) -> None:
    contract = load_release_contract(repository_root)
    assert contract.EXPECTED_MANUAL_GATES == {
        "haos_aarch64_acceptance",
        "haos_amd64_acceptance",
    }
    assert contract.EXPECTED_HAOS_GATE_ARCHITECTURES == {
        "haos_aarch64_acceptance": ["aarch64"],
        "haos_amd64_acceptance": ["amd64"],
    }
    assert "no_app_backup_created" in contract.HAOS_ACCEPTANCE_CHECKS
    assert "backup_rollback" not in contract.HAOS_ACCEPTANCE_CHECKS

    candidate = candidate_fixture()
    for gate in sorted(contract.EXPECTED_MANUAL_GATES):
        template = contract.build_haos_report_template(candidate, gate)
        assert template["status"] == "NOT_RUN"
        assert template["previous_release"] is None
        assert template["test_ids"] == [
            "REM-01",
            "REM-02",
            "REM-03",
            "REM-04",
            "REM-05",
            "REM-06",
            "RST-01",
            "RST-02",
            "RST-03",
            "RST-04",
            "RST-05",
            "REG-01",
            "SEC-01",
            "SEC-02",
            "SEC-03",
            "SEC-04",
        ]
        assert set(template["checks"]) == contract.HAOS_ACCEPTANCE_CHECKS
        assert template["sanitization"] == {
            "contains_credentials": True,
            "contains_identifiers": True,
            "contains_raw_logs_or_prompts": True,
        }


def test_release_contract_cli_and_schema_are_v3(repository_root: Path) -> None:
    script = repository_root / ".github/scripts/release_contract.py"
    source = script.read_text(encoding="utf-8")
    assert '"antigravity-ha-release-candidate/v3"' in source
    assert '"antigravity-ha-release-candidate/v2"' not in source
    assert "numeric v3 release" in source
    assert "numeric v2 release" not in source
    assert "telegram_session_delivery" not in source
    assert "telegram_action" not in source
    assert "HA-005" not in source

    result = subprocess.run(
        ["python3", str(script), "--help"],
        cwd=repository_root,
        check=True,
        capture_output=True,
        text=True,
    )
    assert "haos-report-templates" in result.stdout
    assert "public-install-report" in result.stdout
    assert "candidate-verify" in result.stdout
    assert "ha005-report" not in result.stdout

    contract = load_release_contract(repository_root)
    contract.validate_candidate(candidate_fixture())
    v2_candidate = candidate_fixture()
    v2_candidate["version"] = "2.1.3"
    with pytest.raises(contract.ContractError, match="numeric v3 release"):
        contract.validate_candidate(v2_candidate)


def test_public_install_validator_binds_the_direct_v3_candidate(
    repository_root: Path,
) -> None:
    contract = load_release_contract(repository_root)
    candidate = candidate_fixture()
    observed = datetime.now(timezone.utc).replace(microsecond=0)
    published = observed - timedelta(minutes=1)
    observed_text = observed.strftime("%Y-%m-%dT%H:%M:%SZ")
    published_text = published.strftime("%Y-%m-%dT%H:%M:%SZ")
    installations = {}
    for index, architecture in enumerate(("amd64", "aarch64"), start=3):
        installations[architecture] = {
            "status": "PASS",
            "installation_source": "original_custom_repository_prebuilt_image",
            "repository_id_sha256": "sha256:" + str(index) * 64,
            "data_identity_before_restart_sha256": "sha256:"
            + str(index + 2) * 64,
            "data_identity_after_restart_sha256": "sha256:"
            + str(index + 2) * 64,
            "observed_repository_version": candidate["version"],
            "observed_generic_digest": candidate["images"]["generic"]["digest"],
            "observed_runtime_digest": candidate["images"][architecture][
                "runtime_digest"
            ],
            "checks": {
                check: "PASS" for check in contract.EXPECTED_PUBLIC_INSTALL_CHECKS
            },
            "environment": {
                "platform": "HAOS",
                "architecture": architecture,
                "haos_version": "16.1",
                "supervisor_version": "2026.8.0",
                "core_version": "2026.8.0",
                "final_app_version": candidate["version"],
                "apparmor_mode": "enforce",
            },
            "observed_at_utc": observed_text,
        }
    report = {
        "schema": contract.PUBLIC_INSTALL_REPORT_SCHEMA,
        "test_id": "HA-008",
        "status": "PASS",
        "release": {
            "version": candidate["version"],
            "source_sha": candidate["source_sha"],
            "published_at_utc": published_text,
            "repository_url": contract.PUBLIC_REPOSITORY_URL,
            "addon_slug": contract.PUBLIC_APP_SLUG,
            "generic_image": contract.PUBLIC_GENERIC_IMAGE,
            "generic_digest": candidate["images"]["generic"]["digest"],
            "runtime_digests": {
                architecture: candidate["images"][architecture]["runtime_digest"]
                for architecture in ("amd64", "aarch64")
            },
        },
        "installations": installations,
        "sanitization": {
            "contains_credentials": False,
            "contains_identifiers": False,
            "contains_raw_logs_or_prompts": False,
            "contains_private_host_or_user_identifiers": False,
        },
        "attestation": {
            "real_haos_devices": True,
            "original_public_repository_verified": True,
            "public_release_observed_after_publish": True,
            "independent_fresh_installs_verified": True,
            "both_architectures_scope_reviewed": True,
            "sanitized_by_maintainer": True,
        },
    }
    assert contract.validate_public_install_report(
        candidate,
        report,
        version=candidate["version"],
        source_sha=candidate["source_sha"],
        generic_digest=candidate["images"]["generic"]["digest"],
        amd64_runtime_digest=candidate["images"]["amd64"]["runtime_digest"],
        aarch64_runtime_digest=candidate["images"]["aarch64"]["runtime_digest"],
        published_at_utc=published_text,
    ) == report
    with pytest.raises(contract.ContractError, match="candidate record keys"):
        contract.validate_public_install_report(
            {"candidate": candidate},
            report,
            version=candidate["version"],
            source_sha=candidate["source_sha"],
            generic_digest=candidate["images"]["generic"]["digest"],
            amd64_runtime_digest=candidate["images"]["amd64"]["runtime_digest"],
            aarch64_runtime_digest=candidate["images"]["aarch64"]["runtime_digest"],
            published_at_utc=published_text,
        )


def test_workflows_reference_only_existing_test_files(
    repository_root: Path,
) -> None:
    workflow_root = repository_root / ".github/workflows"
    references: set[str] = set()
    for workflow in workflow_root.glob("*.yaml"):
        source = workflow.read_text(encoding="utf-8")
        references.update(
            re.findall(r"(?<![A-Za-z0-9_.-])(tests/[A-Za-z0-9_.-]+)", source)
        )
    assert references
    for relative in sorted(references):
        assert (repository_root / relative).is_file(), relative


def test_candidate_smokes_cover_v3_upgrade_on_both_architectures(
    repository_root: Path,
) -> None:
    build = (repository_root / ".github/workflows/build-app.yaml").read_text(
        encoding="utf-8"
    )
    ci = (repository_root / ".github/workflows/ci.yaml").read_text(
        encoding="utf-8"
    )
    assert build.count("suite: v3-upgrade") == 2
    assert 'v3-upgrade) exec bash tests/v3-upgrade-smoke.sh "$image" ;;' in build
    assert "tests/v3-upgrade-smoke.sh antigravity-for-home-assistant:test" in ci
    for retired in (
        "public-v1-upgrade-smoke",
        "public-v2-upgrade-smoke",
        "telegram-shared-context",
        "user-files-update-smoke",
        "performance-durability-soak",
    ):
        assert retired not in build
        assert retired not in ci


def test_main_release_is_the_only_numeric_publication_workflow(
    repository_root: Path,
) -> None:
    builder = (repository_root / ".github/workflows/builder.yaml").read_text(
        encoding="utf-8"
    )
    assert "pull_request:" in builder
    assert "push:" not in builder
    for retired in (
        "parse-release-tag.sh",
        "release-evidence",
        "ensure-github-release.sh",
        "cosign sign",
        "release-oci.sh ensure-tag",
    ):
        assert retired not in builder


def test_main_release_notes_lead_with_breaking_reset(
    repository_root: Path,
) -> None:
    workflow = (
        repository_root / ".github/workflows/main-release.yaml"
    ).read_text(encoding="utf-8")
    assert 'antigravity-ha-release-candidate/v3' in workflow
    assert "permanently deletes the documented App-owned 2.x runtime data" in workflow
    assert "Remote Control replaces the Telegram bridge and SSH service" in workflow
    assert "Overall 3.0 HAOS acceptance at publication: `PARTIAL`" in workflow
    assert "Overall v2 acceptance" not in workflow


def test_postpublish_acceptance_is_bound_directly_to_the_v3_candidate(
    repository_root: Path,
) -> None:
    workflow = (
        repository_root / ".github/workflows/postpublish-public-install.yaml"
    ).read_text(encoding="utf-8")
    for required in (
        '[[ $RELEASE_VERSION =~ ^3\\.[0-9]+\\.[0-9]+$ ]]',
        "Candidate-Run-ID:",
        "Candidate-Run-Attempt:",
        "/attempts/${CANDIDATE_RUN_ATTEMPT}",
        "release-candidate-${SOURCE_SHA}-${CANDIDATE_RUN_ID}-${CANDIDATE_RUN_ATTEMPT}",
        "artifact-ids: ${{ steps.candidate.outputs.artifact_id }}",
        "digest-mismatch: error",
        "release_contract.py candidate-verify",
        "--candidate candidate-evidence/candidate.json",
        "--manifest candidate-evidence/candidate-index.json",
    ):
        assert required in workflow
    for retired in (
        "parse-release-tag.sh",
        "release-evidence.json",
        "evidence_run_id",
        "evidence_run_attempt",
        "--release-evidence",
    ):
        assert retired not in workflow


def test_v3_upgrade_smoke_pins_immutable_2_1_3_and_rejects_backups(
    repository_root: Path,
) -> None:
    smoke = (repository_root / "tests/v3-upgrade-smoke.sh").read_text(
        encoding="utf-8"
    )
    for required in (
        "sha256:62437e374c523af3d0a0549abf1874b07ef95c7cab7c7935758faff664d98e3a",
        "sha256:980cf09746368bbf329a49e060f94dba36f60fd7337141ac57babcc3c9d3cd55",
        "a8cee9a70b445a9ce66dc2489e3643a9e135bcfa",
        'PUBLIC_2_1_3_IMAGE="ghcr.io/kanu-coffee/antigravity-for-home-assistant@${PUBLIC_2_1_3_DIGEST}"',
        "the 3.0 reset created a persistent backup of retired App data",
        '"${SHARE_VOLUME}:/share"',
        '"${MEDIA_VOLUME}:/media"',
    ):
        assert required in smoke
    assert "antigravity-for-home-assistant:2.1.3" not in smoke


def test_retired_postpublish_ha005_workflow_is_absent(
    repository_root: Path,
) -> None:
    assert not (
        repository_root / ".github/workflows/postpublish-ha005.yaml"
    ).exists()
