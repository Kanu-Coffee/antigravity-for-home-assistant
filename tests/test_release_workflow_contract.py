from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import ModuleType

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / ".github/scripts/release_contract.py"


def _load_contract() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "release_contract", CONTRACT_PATH
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CONTRACT = _load_contract()


def _digest(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode()
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _descriptor(
    digest_seed: str,
    architecture: str,
    os_name: str,
    annotations: dict[str, str] | None = None,
) -> dict[str, object]:
    descriptor: dict[str, object] = {
        "mediaType": CONTRACT.OCI_MANIFEST,
        "digest": _digest(digest_seed),
        "size": 123,
        "platform": {"architecture": architecture, "os": os_name},
    }
    if annotations is not None:
        descriptor["annotations"] = annotations
    return descriptor


def _valid_index() -> dict[str, object]:
    amd64 = _descriptor("amd64", "amd64", "linux")
    arm64 = _descriptor("arm64", "arm64", "linux")
    attestation = _descriptor(
        "amd64-attestation",
        "unknown",
        "unknown",
        {
            "vnd.docker.reference.type": "attestation-manifest",
            "vnd.docker.reference.digest": str(amd64["digest"]),
        },
    )
    return {
        "schemaVersion": 2,
        "mediaType": CONTRACT.OCI_INDEX,
        "manifests": [amd64, arm64, attestation],
    }


def _candidate() -> dict[str, object]:
    source = "a" * 40
    candidate = {
        "schema": "antigravity-ha-release-candidate/v1",
        "version": "2.0.0",
        "source_sha": source,
        "run_id": 101,
        "run_attempt": 2,
        "candidate_tag": f"candidate-{source}-101-2",
        "images": {
            "generic": {
                "name": "ghcr.io/kanu-coffee/antigravity-for-home-assistant",
                "digest": _digest("index"),
            },
            "amd64": {
                "name": "ghcr.io/kanu-coffee/amd64-antigravity-for-home-assistant",
                "platform": "linux/amd64",
                "stage_digest": _digest("amd64-stage"),
                "runtime_digest": _digest("amd64"),
            },
            "aarch64": {
                "name": "ghcr.io/kanu-coffee/aarch64-antigravity-for-home-assistant",
                "platform": "linux/arm64",
                "stage_digest": _digest("arm64-stage"),
                "runtime_digest": _digest("arm64"),
            },
        },
        "haos_rehearsal": {
            "version": "2.0.0-candidate.101.2",
            "image": "ghcr.io/kanu-coffee/antigravity-for-home-assistant",
            "digest": _digest("index"),
            "repository_manifest_sha256": _digest("candidate-repository"),
            "repository_archive_sha256": _digest("candidate-repository-archive"),
        },
        "automated_gates": {
            "exact_digest_smoke": "PASS",
            "gap007_performance_durability": "PASS",
            "native_arm64_full_feasible": "PASS",
            "source_quality": "PASS",
            "spdx_leaf_sbom": "PASS",
        },
    }
    gap007 = _gap007(candidate)
    candidate["gap007_release"] = {
        "schema": "antigravity-ha-gap007-binding/v1",
        "evidence_sha256": _digest(_gap007_bytes(candidate)),
        "source_sha": source,
        "amd64_stage_digest": candidate["images"]["amd64"]["stage_digest"],
        "amd64_runtime_digest": candidate["images"]["amd64"]["runtime_digest"],
        "candidate_image_id": gap007["provenance"]["candidate_image_id"],
        "source_rootfs_sha256": gap007["provenance"]["source_rootfs_sha256"],
    }
    return candidate


def _gap007(candidate: dict[str, object]) -> dict[str, object]:
    source = candidate["source_sha"]
    amd64 = candidate["images"]["amd64"]
    return {
        "schema_version": 1,
        "requirement_id": "GAP-007",
        "mode": "release",
        "scope": "local_candidate_release_fixture",
        "result": "PASS",
        "closure_eligible": True,
        "started_at_utc": "2026-08-12T00:00:00Z",
        "finished_at_utc": "2026-08-12T00:32:00Z",
        "actual_elapsed_seconds": 1920,
        "threshold_policy": {
            "duration_override_supported": False,
            "override_detected": False,
            "release_soak_seconds": 1800,
            "release_outage_seconds": 900,
            "release_restart_count": 20,
        },
        "provenance": {
            "git_commit": source,
            "candidate_revision": source,
            "candidate_stage_digest": amd64["stage_digest"],
            "candidate_leaf_digest": amd64["runtime_digest"],
            "candidate_image_id": _digest("candidate-config"),
            "candidate_architecture": "amd64",
            "source_rootfs_sha256": _digest("source-rootfs"),
            "source_tree_stable": True,
            "source_image_verification": {
                "schema": "antigravity-ha-source-image-verification/v1",
                "image_id": _digest("candidate-config"),
                "revision": source,
                "source_rootfs_sha256": _digest("source-rootfs"),
                "verified_files": 123,
            },
            "module_origin": "packaged_image",
            "telegram_bridge_module_path": CONTRACT.GAP007_MODULE_PATH,
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
                "baseline_evidence_sha256": (
                    CONTRACT.GAP007_BASELINE_EVIDENCE_SHA256
                ),
                "limits": CONTRACT.GAP007_LIMITS,
                "observed": {
                    "average_cpu_percent": 1.0,
                    "peak_rss_bytes": 150_000_000,
                    "image_size_bytes": 570_000_000,
                },
                "result": "PASS",
            }
        },
        "sanitization": {
            "external_calls": 0,
            "contains_credentials": False,
            "contains_entity_or_chat_identifiers": False,
            "contains_raw_logs_or_prompts": False,
        },
        "remaining_gap": "local GAP-007 complete; HAOS-specific gates remain separate",
    }


def _gap007_bytes(candidate: dict[str, object]) -> bytes:
    return (
        json.dumps(_gap007(candidate), sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode()


def _write_gap007(path: Path, candidate: dict[str, object]) -> None:
    path.write_bytes(_gap007_bytes(candidate))


def _manual(
    candidate: dict[str, object],
    payload_digest: str,
    payloads: dict[str, bytes] | None = None,
) -> dict:
    gates = {}
    for index, name in enumerate(sorted(CONTRACT.EXPECTED_MANUAL_GATES), start=42):
        if payloads is None:
            digest = _digest(f"{payload_digest}:{name}")
            uri = (
                "https://api.github.com/repos/Kanu-Coffee/"
                f"antigravity-for-home-assistant/actions/artifacts/{index}/zip"
            )
            evidence_format = "github_actions_zip"
        else:
            digest = _digest(payloads[name])
            uri = (
                "https://github.com/Kanu-Coffee/antigravity-for-home-assistant/"
                f"releases/download/evidence-fixture/{name}.json"
            )
            evidence_format = "json"
        gates[name] = {
            "status": "PASS",
            "evidence_uri": uri,
            "sha256": digest,
            "format": evidence_format,
        }
    return {
        "schema": "antigravity-ha-manual-evidence/v1",
        "version": candidate["version"],
        "source_sha": candidate["source_sha"],
        "candidate_manifest_digest": candidate["images"]["generic"][
            "digest"
        ],
        "gates": gates,
    }


def _haos_report(candidate: dict[str, object], gate: str) -> dict[str, object]:
    images = candidate["images"]
    previous_release = None
    if gate in {
        "haos_amd64_local_migration",
        "local_migration_rollback",
        "migration_modes",
    }:
        previous_release = {
            "version": "1.0.4",
            "source_sha": CONTRACT.PUBLIC_V1_SOURCE_SHA,
            "image_id": _digest("public-v1-local-image"),
            "installation_source": "local_addons_source_build",
            "repository_identity": "same_local_repository_identity",
            "image_digest_verified": True,
        }
    return {
        "schema": "antigravity-ha-haos-gate-evidence/v1",
        "gate": gate,
        "status": "PASS",
        "version": candidate["version"],
        "source_sha": candidate["source_sha"],
        "candidate_manifest_digest": images["generic"]["digest"],
        "candidate_images": {
            "generic_manifest_digest": images["generic"]["digest"],
            "amd64_stage_digest": images["amd64"]["stage_digest"],
            "amd64_runtime_digest": images["amd64"]["runtime_digest"],
            "aarch64_stage_digest": images["aarch64"]["stage_digest"],
            "aarch64_runtime_digest": images["aarch64"]["runtime_digest"],
        },
        "haos_rehearsal": candidate["haos_rehearsal"],
        "test_ids": CONTRACT.EXPECTED_HAOS_GATE_TEST_IDS[gate],
        "checks": {
            name: "PASS" for name in sorted(CONTRACT.EXPECTED_HAOS_GATE_CHECKS[gate])
        },
        "environment": {
            "platform": "HAOS",
            "architectures": CONTRACT.EXPECTED_HAOS_GATE_ARCHITECTURES[gate],
            "haos_version": "16.1",
            "supervisor_version": "2026.8.1",
            "core_version": "2026.8.0",
            "app_version": (
                "1.0.4"
                if gate == "local_migration_rollback"
                else candidate["haos_rehearsal"]["version"]
            ),
            "apparmor_mode": "enforce",
        },
        "previous_release": previous_release,
        "observed_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sanitization": {
            "contains_credentials": False,
            "contains_entity_or_chat_identifiers": False,
            "contains_raw_logs_or_prompts": False,
        },
        "attestation": {
            "candidate_digest_verified": True,
            "real_haos_device": True,
            "sanitized_by_maintainer": True,
            "scope_reviewed": True,
        },
    }


def _haos_report_bytes(candidate: dict[str, object], gate: str) -> bytes:
    return (json.dumps(_haos_report(candidate, gate), indent=2, sort_keys=True) + "\n").encode()


def _release_evidence(candidate: dict[str, object] | None = None) -> dict[str, object]:
    candidate = candidate or _candidate()
    return {
        "schema": "antigravity-ha-release-evidence/v1",
        "candidate": candidate,
        "candidate_artifact_digest": _digest("candidate-artifact"),
        "manual_evidence": _manual(candidate, _digest("manual")),
        "haos_gate_evidence": {
            gate: _digest(f"haos:{gate}")
            for gate in CONTRACT.EXPECTED_MANUAL_GATES
        },
        "finalizer": {"actor": "maintainer", "run_id": 202, "run_attempt": 1},
    }


def _ha005_report(
    release_evidence: dict[str, object],
    *,
    published_at_utc: str,
    observed_at_utc: str,
) -> dict[str, object]:
    candidate = release_evidence["candidate"]
    images = candidate["images"]
    repository_identity = _digest("original-public-repository-id")
    local_image_id = _digest("public-v1-source-build-image-id")
    data_identity = _digest("supervisor-addon-data-identity")
    version = candidate["version"]
    return {
        "schema": CONTRACT.HA005_REPORT_SCHEMA,
        "test_id": "HA-005",
        "status": "PASS",
        "release": {
            "version": version,
            "source_sha": candidate["source_sha"],
            "published_at_utc": published_at_utc,
            "generic_image": CONTRACT.PUBLIC_GENERIC_IMAGE,
            "generic_digest": images["generic"]["digest"],
            "amd64_runtime_digest": images["amd64"]["runtime_digest"],
        },
        "previous_release": {
            "version": "1.0.4",
            "source_sha": CONTRACT.PUBLIC_V1_SOURCE_SHA,
            "repository_url": CONTRACT.PUBLIC_REPOSITORY_URL,
            "addon_slug": CONTRACT.PUBLIC_APP_SLUG,
            "installation_source": "original_custom_repository_source_build",
            "repository_id_sha256": repository_identity,
            "local_image_id": local_image_id,
            "data_identity_sha256": data_identity,
        },
        "transitions": {
            "update": {
                "status": "PASS",
                "from_version": "1.0.4",
                "to_version": version,
                "repository_id_sha256": repository_identity,
                "addon_slug": CONTRACT.PUBLIC_APP_SLUG,
                "data_identity_sha256": data_identity,
                "observed_generic_digest": images["generic"]["digest"],
                "observed_amd64_runtime_digest": images["amd64"][
                    "runtime_digest"
                ],
            },
            "rollback": {
                "status": "PASS",
                "from_version": version,
                "to_version": "1.0.4",
                "repository_id_sha256": repository_identity,
                "addon_slug": CONTRACT.PUBLIC_APP_SLUG,
                "data_identity_sha256": data_identity,
                "source_sha": CONTRACT.PUBLIC_V1_SOURCE_SHA,
                "selected_local_image_id": local_image_id,
                "matching_managed_backup_restored": True,
            },
        },
        "checks": {name: "PASS" for name in sorted(CONTRACT.EXPECTED_HA005_CHECKS)},
        "environment": {
            "platform": "HAOS",
            "architecture": "amd64",
            "haos_version": "16.1",
            "supervisor_version": "2026.8.1",
            "core_version": "2026.8.0",
            "final_app_version": "1.0.4",
        },
        "observed_at_utc": observed_at_utc,
        "sanitization": {
            "contains_credentials": False,
            "contains_entity_or_chat_identifiers": False,
            "contains_raw_logs_or_prompts": False,
            "contains_private_host_or_user_identifiers": False,
        },
        "attestation": {
            "real_haos_device": True,
            "original_public_repository_verified": True,
            "public_release_observed_after_publish": True,
            "sanitized_by_maintainer": True,
            "scope_reviewed": True,
        },
    }


def _public_install_report(
    release_evidence: dict[str, object],
    *,
    published_at_utc: str,
    observed_at_utc: str,
) -> dict[str, object]:
    candidate = release_evidence["candidate"]
    images = candidate["images"]
    version = candidate["version"]
    installations = {}
    for architecture in ("amd64", "aarch64"):
        data_identity = _digest(f"{architecture}-data-identity")
        installations[architecture] = {
            "status": "PASS",
            "installation_source": "original_custom_repository_prebuilt_image",
            "repository_id_sha256": _digest(f"{architecture}-repository-id"),
            "data_identity_before_restart_sha256": data_identity,
            "data_identity_after_restart_sha256": data_identity,
            "observed_repository_version": version,
            "observed_generic_digest": images["generic"]["digest"],
            "observed_runtime_digest": images[architecture]["runtime_digest"],
            "checks": {
                name: "PASS"
                for name in sorted(CONTRACT.EXPECTED_PUBLIC_INSTALL_CHECKS)
            },
            "environment": {
                "platform": "HAOS",
                "architecture": architecture,
                "haos_version": "16.1",
                "supervisor_version": "2026.8.1",
                "core_version": "2026.8.0",
                "final_app_version": version,
                "apparmor_mode": "enforce",
            },
            "observed_at_utc": observed_at_utc,
        }
    return {
        "schema": CONTRACT.PUBLIC_INSTALL_REPORT_SCHEMA,
        "test_id": "HA-008",
        "status": "PASS",
        "release": {
            "version": version,
            "source_sha": candidate["source_sha"],
            "published_at_utc": published_at_utc,
            "repository_url": CONTRACT.PUBLIC_REPOSITORY_URL,
            "addon_slug": CONTRACT.PUBLIC_APP_SLUG,
            "generic_image": CONTRACT.PUBLIC_GENERIC_IMAGE,
            "generic_digest": images["generic"]["digest"],
            "runtime_digests": {
                "amd64": images["amd64"]["runtime_digest"],
                "aarch64": images["aarch64"]["runtime_digest"],
            },
        },
        "installations": installations,
        "sanitization": {
            "contains_credentials": False,
            "contains_entity_or_chat_identifiers": False,
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


def _write_haos_gate_dir(path: Path, candidate: dict[str, object]) -> dict[str, str]:
    path.mkdir()
    result = {}
    for gate in sorted(CONTRACT.EXPECTED_MANUAL_GATES):
        report_path = path / f"{gate}.json"
        report_path.write_bytes(_haos_report_bytes(candidate, gate))
        result[gate] = _digest(report_path.read_bytes())
    return result


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


def _run(
    command: list[str],
    *,
    env: dict[str, str] | None = None,
    cwd: Path = ROOT,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )


def test_oci_index_accepts_only_exact_runtime_descriptors(
    tmp_path: Path,
) -> None:
    manifest = tmp_path / "index.json"
    manifest.write_text(
        json.dumps(_valid_index(), separators=(",", ":")), encoding="utf-8"
    )
    result = CONTRACT.validate_index_file(
        manifest, ("amd64", "aarch64")
    )
    assert result["amd64"] == _digest("amd64")
    assert result["aarch64"] == _digest("arm64")
    assert result["index_digest"] == _digest(manifest.read_bytes())

    extra = _valid_index()
    extra["manifests"].append(_descriptor("windows", "amd64", "windows"))
    with pytest.raises(CONTRACT.ContractError, match="unexpected runnable"):
        CONTRACT.validate_index_document(extra, ("amd64", "aarch64"))

    duplicate = _valid_index()
    duplicate["manifests"].append(
        _descriptor("second-amd64", "amd64", "linux")
    )
    with pytest.raises(CONTRACT.ContractError, match="duplicate linux/amd64"):
        CONTRACT.validate_index_document(duplicate, ("amd64", "aarch64"))

    detached = _valid_index()
    detached["manifests"][-1]["annotations"][
        "vnd.docker.reference.digest"
    ] = _digest("not-a-runtime")
    with pytest.raises(CONTRACT.ContractError, match="points outside"):
        CONTRACT.validate_index_document(detached, ("amd64", "aarch64"))


def test_manual_and_tag_release_binding_fail_closed(tmp_path: Path) -> None:
    candidate = _candidate()
    manual = _manual(candidate, _digest("report"))
    CONTRACT.validate_candidate(candidate)
    CONTRACT.validate_manual(candidate, manual)

    mismatched_candidate_tag = json.loads(json.dumps(candidate))
    mismatched_candidate_tag["candidate_tag"] = (
        f"candidate-{'b' * 40}-101-2"
    )
    with pytest.raises(CONTRACT.ContractError, match="binding differs"):
        CONTRACT.validate_candidate(mismatched_candidate_tag)

    not_run = json.loads(json.dumps(manual))
    not_run["gates"]["local_migration_rollback"]["status"] = "NOT_RUN"
    with pytest.raises(CONTRACT.ContractError, match="not PASS"):
        CONTRACT.validate_manual(candidate, not_run)

    foreign_uri = json.loads(json.dumps(manual))
    foreign_uri["gates"]["local_migration_rollback"]["evidence_uri"] = (
        "https://example.com/report.zip"
    )
    with pytest.raises(CONTRACT.ContractError, match="unbound evidence URI"):
        CONTRACT.validate_manual(candidate, foreign_uri)

    template = ROOT / "docs/v2/release-evidence-template.json"
    with pytest.raises(CONTRACT.ContractError):
        CONTRACT.validate_manual(candidate, json.loads(template.read_text()))

    evidence = {
        "schema": "antigravity-ha-release-evidence/v1",
        "candidate": candidate,
        "candidate_artifact_digest": _digest("candidate-artifact"),
        "manual_evidence": manual,
        "haos_gate_evidence": {},
        "finalizer": {"actor": "maintainer", "run_id": 202, "run_attempt": 1},
    }
    haos_gate_dir = tmp_path / "haos-gates"
    evidence["haos_gate_evidence"] = _write_haos_gate_dir(
        haos_gate_dir, candidate
    )
    invalid_actor = json.loads(json.dumps(evidence))
    invalid_actor["finalizer"]["actor"] = "maintainer\nspoofed"
    with pytest.raises(CONTRACT.ContractError, match="invalid finalizer actor"):
        CONTRACT.validate_release_evidence(invalid_actor)
    evidence_path = tmp_path / "release-evidence.json"
    evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
    gap007_path = tmp_path / "gap007-release.json"
    _write_gap007(gap007_path, candidate)
    result = _run(
        [
            "python3",
            str(CONTRACT_PATH),
            "release",
            "--evidence",
            str(evidence_path),
            "--gap007-evidence",
            str(gap007_path),
            "--haos-gates-dir",
            str(haos_gate_dir),
            "--version",
            "2.0.0",
            "--source-sha",
            "b" * 40,
            "--candidate-run-id",
            "101",
            "--candidate-run-attempt",
            "2",
            "--evidence-run-id",
            "202",
            "--evidence-run-attempt",
            "1",
        ]
    )
    assert result.returncode != 0
    assert "tag commit differs from evidence" in result.stderr


def test_release_and_notes_reject_tampered_embedded_haos_gate(
    tmp_path: Path,
) -> None:
    candidate = _candidate()
    manual = _manual(candidate, _digest("report"))
    haos_gate_dir = tmp_path / "haos-gates"
    haos_gate_evidence = _write_haos_gate_dir(haos_gate_dir, candidate)
    evidence = {
        "schema": "antigravity-ha-release-evidence/v1",
        "candidate": candidate,
        "candidate_artifact_digest": _digest("candidate-artifact"),
        "manual_evidence": manual,
        "haos_gate_evidence": haos_gate_evidence,
        "finalizer": {"actor": "maintainer", "run_id": 202, "run_attempt": 1},
    }
    evidence_path = tmp_path / "release-evidence.json"
    evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
    gap007_path = tmp_path / "gap007-release.json"
    _write_gap007(gap007_path, candidate)

    tampered_gate = haos_gate_dir / "telegram_modes.json"
    tampered_gate.write_bytes(tampered_gate.read_bytes() + b"\n")
    release_result = _run(
        [
            "python3",
            str(CONTRACT_PATH),
            "release",
            "--evidence",
            str(evidence_path),
            "--gap007-evidence",
            str(gap007_path),
            "--haos-gates-dir",
            str(haos_gate_dir),
            "--version",
            "2.0.0",
            "--source-sha",
            candidate["source_sha"],
            "--candidate-run-id",
            "101",
            "--candidate-run-attempt",
            "2",
            "--evidence-run-id",
            "202",
            "--evidence-run-attempt",
            "1",
        ]
    )
    assert release_result.returncode != 0
    assert "embedded HAOS gate report digest differs" in release_result.stderr

    notes_result = _run(
        [
            "python3",
            str(CONTRACT_PATH),
            "notes",
            "--evidence",
            str(evidence_path),
            "--gap007-evidence",
            str(gap007_path),
            "--haos-gates-dir",
            str(haos_gate_dir),
            "--output",
            str(tmp_path / "release-notes.md"),
        ]
    )
    assert notes_result.returncode != 0
    assert "embedded HAOS gate report digest differs" in notes_result.stderr


def test_gap007_release_binding_rejects_hash_leaf_source_and_budget_drift() -> None:
    candidate = _candidate()
    evidence = _gap007(candidate)
    evidence_sha256 = candidate["gap007_release"]["evidence_sha256"]
    CONTRACT.validate_gap007_release(candidate, evidence, evidence_sha256)

    with pytest.raises(CONTRACT.ContractError, match="file hash"):
        CONTRACT.validate_gap007_release(candidate, evidence, _digest("stale"))

    stale_leaf = json.loads(json.dumps(evidence))
    stale_leaf["provenance"]["candidate_leaf_digest"] = _digest("foreign-leaf")
    with pytest.raises(CONTRACT.ContractError, match="leaf digest"):
        CONTRACT.validate_gap007_release(candidate, stale_leaf, evidence_sha256)

    stale_source = json.loads(json.dumps(evidence))
    stale_source["provenance"]["git_commit"] = "b" * 40
    with pytest.raises(CONTRACT.ContractError, match="source differs"):
        CONTRACT.validate_gap007_release(candidate, stale_source, evidence_sha256)

    no_budget = json.loads(json.dumps(evidence))
    no_budget["resources"].pop("candidate_budget")
    with pytest.raises(CONTRACT.ContractError, match="budget"):
        CONTRACT.validate_gap007_release(candidate, no_budget, evidence_sha256)


def test_annotated_tag_parser_binds_source_runs_and_archive(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    for command in (
        ["git", "init", "--quiet"],
        ["git", "config", "user.name", "Release Test"],
        ["git", "config", "user.email", "release@example.invalid"],
    ):
        assert _run(command, cwd=repository).returncode == 0
    (repository / "source.txt").write_text("release source\n")
    assert _run(["git", "add", "source.txt"], cwd=repository).returncode == 0
    assert (
        _run(
            ["git", "commit", "--quiet", "-m", "release source"],
            cwd=repository,
        ).returncode
        == 0
    )
    source = _run(
        ["git", "rev-parse", "HEAD"], cwd=repository
    ).stdout.strip()
    artifact = f"release-evidence-2.0.0-{source}-101-2-202-1"
    message = (
        "Release 2.0.0\n\n"
        "Candidate-Run-ID: 101\n"
        "Candidate-Run-Attempt: 2\n"
        "Release-Evidence-Run-ID: 202\n"
        "Release-Evidence-Run-Attempt: 1\n"
        f"Release-Evidence-Artifact: {artifact}\n"
        f"Release-Evidence-SHA256: sha256:{'1' * 64}\n"
    )
    message_path = repository / "tag-message.txt"
    message_path.write_text(message)
    assert (
        _run(
            ["git", "tag", "--annotate", "2.0.0", "--file", str(message_path)],
            cwd=repository,
        ).returncode
        == 0
    )
    output = repository / "github-output.txt"
    env = os.environ | {"GITHUB_OUTPUT": str(output)}
    script = ROOT / ".github/scripts/parse-release-tag.sh"
    result = _run(["bash", str(script), "2.0.0"], env=env, cwd=repository)
    assert result.returncode == 0, result.stderr
    parsed = dict(
        line.split("=", 1) for line in output.read_text().splitlines()
    )
    assert parsed["source_sha"] == source
    assert parsed["evidence_artifact"] == artifact

    assert (
        _run(["git", "tag", "2.0.1"], cwd=repository).returncode == 0
    )
    output.write_text("")
    result = _run(["bash", str(script), "2.0.1"], env=env, cwd=repository)
    assert result.returncode != 0
    assert "must be annotated" in result.stderr

    malformed = message.replace(artifact, f"release-evidence-2.0.2-{'b' * 40}-1-1-1-1")
    message_path.write_text(malformed)
    assert (
        _run(
            ["git", "tag", "--annotate", "2.0.2", "--file", str(message_path)],
            cwd=repository,
        ).returncode
        == 0
    )
    result = _run(["bash", str(script), "2.0.2"], env=env, cwd=repository)
    assert result.returncode != 0
    assert "not bound" in result.stderr


def test_manual_evidence_downloader_hashes_actual_bytes(
    tmp_path: Path,
) -> None:
    candidate = _candidate()
    payloads = {
        gate: _haos_report_bytes(candidate, gate)
        for gate in CONTRACT.EXPECTED_MANUAL_GATES
    }
    payload_directory = tmp_path / "payloads"
    payload_directory.mkdir()
    for gate, payload in payloads.items():
        (payload_directory / f"{gate}.json").write_bytes(payload)
    manual_path = tmp_path / "manual.json"
    manual_path.write_text(
        json.dumps(_manual(candidate, _digest("unused"), payloads)), encoding="utf-8"
    )
    candidate_path = tmp_path / "candidate.json"
    candidate_path.write_text(json.dumps(candidate), encoding="utf-8")
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _write_executable(
        fake_bin / "curl",
        """#!/usr/bin/env bash
set -Eeuo pipefail
output=
url=
while (($#)); do
  if [[ $1 == --output ]]; then output=$2; shift 2
  elif [[ $1 == https://* ]]; then url=$1; shift
  else shift
  fi
done
cp -- "${FAKE_EVIDENCE_DIR}/$(basename -- "$url")" "$output"
""",
    )
    env = os.environ | {
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "FAKE_EVIDENCE_DIR": str(payload_directory),
        "GH_TOKEN": "synthetic-token",
    }
    script = ROOT / ".github/scripts/verify-manual-evidence.sh"
    output_directory = tmp_path / "canonical"
    result = _run(
        [
            "bash",
            str(script),
            str(manual_path),
            str(candidate_path),
            str(output_directory),
        ],
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert {path.name for path in output_directory.iterdir()} == {
        f"{gate}.json" for gate in CONTRACT.EXPECTED_MANUAL_GATES
    }

    broken = _manual(candidate, _digest("unused"), payloads)
    broken["gates"]["local_migration_rollback"]["sha256"] = _digest("different")
    manual_path.write_text(json.dumps(broken), encoding="utf-8")
    broken_output = tmp_path / "broken-output"
    result = _run(
        [
            "bash",
            str(script),
            str(manual_path),
            str(candidate_path),
            str(broken_output),
        ],
        env=env,
    )
    assert result.returncode != 0
    assert "downloaded evidence digest mismatch" in result.stderr
    assert not broken_output.exists()


def test_haos_gate_reports_bind_schema_source_arch_and_scope(
    tmp_path: Path,
) -> None:
    candidate = _candidate()
    for gate in sorted(CONTRACT.EXPECTED_MANUAL_GATES):
        report = _haos_report(candidate, gate)
        CONTRACT.validate_haos_gate_report(candidate, gate, report)

    wrong_gate = _haos_report(candidate, "telegram_modes")
    wrong_gate["gate"] = "local_migration_rollback"
    with pytest.raises(CONTRACT.ContractError, match="gate binding"):
        CONTRACT.validate_haos_gate_report(candidate, "telegram_modes", wrong_gate)

    wrong_source = _haos_report(candidate, "oauth_isolation_persistence")
    wrong_source["source_sha"] = "b" * 40
    with pytest.raises(CONTRACT.ContractError, match="source differs"):
        CONTRACT.validate_haos_gate_report(
            candidate, "oauth_isolation_persistence", wrong_source
        )

    wrong_manifest = _haos_report(candidate, "telegram_modes")
    wrong_manifest["candidate_manifest_digest"] = _digest("wrong-manifest")
    with pytest.raises(CONTRACT.ContractError, match="candidate manifest differs"):
        CONTRACT.validate_haos_gate_report(
            candidate, "telegram_modes", wrong_manifest
        )

    wrong_leaf = _haos_report(candidate, "telegram_modes")
    wrong_leaf["candidate_images"] = dict(wrong_leaf["candidate_images"])
    wrong_leaf["candidate_images"]["amd64_runtime_digest"] = _digest(
        "wrong-amd64-leaf"
    )
    with pytest.raises(CONTRACT.ContractError, match="image binding differs"):
        CONTRACT.validate_haos_gate_report(candidate, "telegram_modes", wrong_leaf)

    wrong_rehearsal = _haos_report(candidate, "telegram_modes")
    wrong_rehearsal["haos_rehearsal"] = dict(wrong_rehearsal["haos_rehearsal"])
    wrong_rehearsal["haos_rehearsal"]["digest"] = _digest("wrong-rehearsal")
    with pytest.raises(CONTRACT.ContractError, match="rehearsal repository"):
        CONTRACT.validate_haos_gate_report(
            candidate, "telegram_modes", wrong_rehearsal
        )

    wrong_test_ids = _haos_report(candidate, "telegram_modes")
    wrong_test_ids["test_ids"] = [*wrong_test_ids["test_ids"], "HA-008"]
    with pytest.raises(CONTRACT.ContractError, match="test ID set is not exact"):
        CONTRACT.validate_haos_gate_report(
            candidate, "telegram_modes", wrong_test_ids
        )

    missing_check = _haos_report(candidate, "apparmor_enforce")
    missing_check["checks"].pop("other_pid_proc_denied")
    with pytest.raises(CONTRACT.ContractError, match="checks are incomplete"):
        CONTRACT.validate_haos_gate_report(
            candidate, "apparmor_enforce", missing_check
        )

    local_fixture = _haos_report(candidate, "haos_amd64_local_migration")
    local_fixture["environment"]["platform"] = "Docker"
    with pytest.raises(CONTRACT.ContractError, match="platform is not HAOS"):
        CONTRACT.validate_haos_gate_report(
            candidate, "haos_amd64_local_migration", local_fixture
        )

    final_version_only = _haos_report(candidate, "haos_amd64_local_migration")
    final_version_only["environment"]["app_version"] = candidate["version"]
    with pytest.raises(CONTRACT.ContractError, match="gate postcondition"):
        CONTRACT.validate_haos_gate_report(
            candidate, "haos_amd64_local_migration", final_version_only
        )

    not_rolled_back = _haos_report(candidate, "local_migration_rollback")
    not_rolled_back["environment"]["app_version"] = candidate[
        "haos_rehearsal"
    ]["version"]
    with pytest.raises(CONTRACT.ContractError, match="gate postcondition"):
        CONTRACT.validate_haos_gate_report(
            candidate, "local_migration_rollback", not_rolled_back
        )

    different_local_repository = _haos_report(
        candidate, "haos_amd64_local_migration"
    )
    different_local_repository["previous_release"]["repository_identity"] = (
        "different_repository_identity"
    )
    with pytest.raises(CONTRACT.ContractError, match="repository identity differs"):
        CONTRACT.validate_haos_gate_report(
            candidate,
            "haos_amd64_local_migration",
            different_local_repository,
        )

    impossible_date = _haos_report(candidate, "haos_amd64_local_migration")
    impossible_date["observed_at_utc"] = "2026-02-31T12:00:00Z"
    with pytest.raises(CONTRACT.ContractError, match="timestamp is invalid"):
        CONTRACT.validate_haos_gate_report(
            candidate, "haos_amd64_local_migration", impossible_date
        )

    duplicate_json = tmp_path / "duplicate.json"
    duplicate_json.write_text('{"schema":"one","schema":"two"}\n', encoding="utf-8")
    with pytest.raises(CONTRACT.ContractError, match="duplicate JSON key"):
        CONTRACT.load_haos_gate_report(
            duplicate_json, "telegram_modes", "json"
        )


def test_haos_report_templates_are_exact_deterministic_and_fail_closed(
    tmp_path: Path,
) -> None:
    candidate = _candidate()
    candidate_path = tmp_path / "candidate.json"
    candidate_path.write_text(json.dumps(candidate), encoding="utf-8")
    first_output = tmp_path / "first"
    second_output = tmp_path / "second"

    for output_directory in (first_output, second_output):
        result = _run(
            [
                "python3",
                str(CONTRACT_PATH),
                "haos-report-templates",
                "--candidate",
                str(candidate_path),
                "--output-dir",
                str(output_directory),
            ]
        )
        assert result.returncode == 0, result.stderr

    expected_names = {
        f"{gate}.json" for gate in CONTRACT.EXPECTED_MANUAL_GATES
    }
    assert {path.name for path in first_output.iterdir()} == expected_names
    assert {path.name for path in second_output.iterdir()} == expected_names

    for gate in sorted(CONTRACT.EXPECTED_MANUAL_GATES):
        first_path = first_output / f"{gate}.json"
        second_path = second_output / f"{gate}.json"
        assert first_path.read_bytes() == second_path.read_bytes()
        report = json.loads(first_path.read_text(encoding="utf-8"))
        assert report == CONTRACT.build_haos_report_template(candidate, gate)
        assert set(report) == CONTRACT.HAOS_GATE_REPORT_KEYS
        assert report["status"] == "NOT_RUN"
        assert report["test_ids"] == CONTRACT.EXPECTED_HAOS_GATE_TEST_IDS[gate]
        assert set(report["checks"]) == CONTRACT.EXPECTED_HAOS_GATE_CHECKS[gate]
        assert set(report["checks"].values()) == {"NOT_RUN"}
        assert set(report["environment"]) == CONTRACT.HAOS_GATE_ENVIRONMENT_KEYS
        assert report["environment"]["architectures"] == (
            CONTRACT.EXPECTED_HAOS_GATE_ARCHITECTURES[gate]
        )
        assert all(
            report["environment"][name] == ""
            for name in (
                "haos_version",
                "supervisor_version",
                "core_version",
                "app_version",
                "apparmor_mode",
            )
        )
        assert set(report["sanitization"].values()) == {True}
        assert set(report["attestation"].values()) == {False}
        if gate in CONTRACT.HAOS_LOCAL_V1_GATES:
            assert report["previous_release"]["image_id"] == ""
            assert report["previous_release"]["image_digest_verified"] is False
        else:
            assert report["previous_release"] is None
        with pytest.raises(CONTRACT.ContractError, match="did not pass"):
            CONTRACT.validate_haos_gate_report(candidate, gate, report)

    sentinel = first_output / "sentinel"
    sentinel.write_text("preserve", encoding="utf-8")
    result = _run(
        [
            "python3",
            str(CONTRACT_PATH),
            "haos-report-templates",
            "--candidate",
            str(candidate_path),
            "--output-dir",
            str(first_output),
        ]
    )
    assert result.returncode != 0
    assert sentinel.read_text(encoding="utf-8") == "preserve"

    symlink_output = tmp_path / "symlink-output"
    symlink_output.symlink_to(second_output, target_is_directory=True)
    result = _run(
        [
            "python3",
            str(CONTRACT_PATH),
            "haos-report-templates",
            "--candidate",
            str(candidate_path),
            "--output-dir",
            str(symlink_output),
        ]
    )
    assert result.returncode != 0
    assert {path.name for path in second_output.iterdir()} == expected_names


def test_haos_gate_zip_rejects_extra_symlink_and_reuse(
    tmp_path: Path,
) -> None:
    candidate = _candidate()
    report = _haos_report_bytes(candidate, "telegram_modes")
    valid_zip = tmp_path / "valid.zip"
    with zipfile.ZipFile(valid_zip, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manual-gate-evidence.json", report)
    loaded = CONTRACT.load_haos_gate_report(
        valid_zip, "telegram_modes", "github_actions_zip"
    )
    CONTRACT.validate_haos_gate_report(candidate, "telegram_modes", loaded)

    extra_zip = tmp_path / "extra.zip"
    with zipfile.ZipFile(extra_zip, "w") as archive:
        archive.writestr("manual-gate-evidence.json", report)
        archive.writestr("extra.json", b"{}")
    with pytest.raises(CONTRACT.ContractError, match="member set"):
        CONTRACT.load_haos_gate_report(
            extra_zip, "telegram_modes", "github_actions_zip"
        )

    symlink_zip = tmp_path / "symlink.zip"
    link = zipfile.ZipInfo("manual-gate-evidence.json")
    link.create_system = 3
    link.external_attr = (0o120777 << 16)
    with zipfile.ZipFile(symlink_zip, "w") as archive:
        archive.writestr(link, b"target")
    with pytest.raises(CONTRACT.ContractError, match="not a regular"):
        CONTRACT.load_haos_gate_report(
            symlink_zip, "telegram_modes", "github_actions_zip"
        )

    manual = _manual(candidate, _digest("report"))
    first, second = sorted(CONTRACT.EXPECTED_MANUAL_GATES)[:2]
    manual["gates"][second]["evidence_uri"] = manual["gates"][first][
        "evidence_uri"
    ]
    manual["gates"][second]["sha256"] = manual["gates"][first]["sha256"]
    with pytest.raises(CONTRACT.ContractError, match="reused across gates"):
        CONTRACT.validate_manual(candidate, manual)


def _validate_ha005(
    release_evidence: dict[str, object],
    report: dict[str, object],
    published_at_utc: str,
) -> dict[str, object]:
    candidate = release_evidence["candidate"]
    return CONTRACT.validate_ha005_report(
        release_evidence,
        report,
        version=candidate["version"],
        source_sha=candidate["source_sha"],
        generic_digest=candidate["images"]["generic"]["digest"],
        amd64_runtime_digest=candidate["images"]["amd64"]["runtime_digest"],
        published_at_utc=published_at_utc,
    )


def _validate_public_install(
    release_evidence: dict[str, object],
    report: dict[str, object],
    published_at_utc: str,
) -> dict[str, object]:
    candidate = release_evidence["candidate"]
    return CONTRACT.validate_public_install_report(
        release_evidence,
        report,
        version=candidate["version"],
        source_sha=candidate["source_sha"],
        generic_digest=candidate["images"]["generic"]["digest"],
        amd64_runtime_digest=candidate["images"]["amd64"]["runtime_digest"],
        aarch64_runtime_digest=candidate["images"]["aarch64"]["runtime_digest"],
        published_at_utc=published_at_utc,
    )


def test_ha005_postpublish_report_binds_public_release_and_canonicalizes(
    tmp_path: Path,
) -> None:
    evidence = _release_evidence()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    published = (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    observed = (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    report = _ha005_report(
        evidence, published_at_utc=published, observed_at_utc=observed
    )
    assert _validate_ha005(evidence, report, published) == report
    assert all(
        "HA-005" not in identifiers
        for identifiers in CONTRACT.EXPECTED_HAOS_GATE_TEST_IDS.values()
    )

    evidence_path = tmp_path / "release-evidence.json"
    evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
    report_path = tmp_path / "submitted.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    output_path = tmp_path / "ha005-acceptance.json"
    candidate = evidence["candidate"]
    result = _run(
        [
            "python3",
            str(CONTRACT_PATH),
            "ha005-report",
            "--release-evidence",
            str(evidence_path),
            "--report",
            str(report_path),
            "--version",
            candidate["version"],
            "--source-sha",
            candidate["source_sha"],
            "--generic-digest",
            candidate["images"]["generic"]["digest"],
            "--amd64-runtime-digest",
            candidate["images"]["amd64"]["runtime_digest"],
            "--published-at-utc",
            published,
            "--output",
            str(output_path),
        ]
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(output_path.read_text()) == report
    assert output_path.read_text().endswith("\n")


def test_ha005_postpublish_report_rejects_binding_scope_and_sanitization_drift() -> None:
    evidence = _release_evidence()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    published = (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    observed = (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")

    wrong_release = _ha005_report(
        evidence, published_at_utc=published, observed_at_utc=observed
    )
    wrong_release["release"]["source_sha"] = "b" * 40
    with pytest.raises(CONTRACT.ContractError, match="release binding differs"):
        _validate_ha005(evidence, wrong_release, published)

    wrong_update = _ha005_report(
        evidence, published_at_utc=published, observed_at_utc=observed
    )
    wrong_update["transitions"]["update"]["observed_generic_digest"] = _digest(
        "different-public-image"
    )
    with pytest.raises(CONTRACT.ContractError, match="update transition"):
        _validate_ha005(evidence, wrong_update, published)

    wrong_previous_source = _ha005_report(
        evidence, published_at_utc=published, observed_at_utc=observed
    )
    wrong_previous_source["previous_release"]["source_sha"] = "b" * 40
    with pytest.raises(CONTRACT.ContractError, match="previous source differs"):
        _validate_ha005(evidence, wrong_previous_source, published)

    wrong_rollback_image = _ha005_report(
        evidence, published_at_utc=published, observed_at_utc=observed
    )
    wrong_rollback_image["transitions"]["rollback"][
        "selected_local_image_id"
    ] = _digest("different-local-image")
    with pytest.raises(CONTRACT.ContractError, match="rollback transition"):
        _validate_ha005(evidence, wrong_rollback_image, published)

    reused_placeholder = _ha005_report(
        evidence, published_at_utc=published, observed_at_utc=observed
    )
    reused_placeholder["previous_release"]["data_identity_sha256"] = (
        reused_placeholder["previous_release"]["repository_id_sha256"]
    )
    with pytest.raises(CONTRACT.ContractError, match="must be distinct"):
        _validate_ha005(evidence, reused_placeholder, published)

    missing_check = _ha005_report(
        evidence, published_at_utc=published, observed_at_utc=observed
    )
    missing_check["checks"].pop("published_generic_digest_verified")
    with pytest.raises(CONTRACT.ContractError, match="checks are incomplete"):
        _validate_ha005(evidence, missing_check, published)

    unsanitized = _ha005_report(
        evidence, published_at_utc=published, observed_at_utc=observed
    )
    unsanitized["sanitization"]["contains_credentials"] = True
    with pytest.raises(CONTRACT.ContractError, match="sanitization contract failed"):
        _validate_ha005(evidence, unsanitized, published)

    numeric_sanitization = _ha005_report(
        evidence, published_at_utc=published, observed_at_utc=observed
    )
    numeric_sanitization["sanitization"] = {
        name: 0 for name in numeric_sanitization["sanitization"]
    }
    with pytest.raises(CONTRACT.ContractError, match="flags are not boolean false"):
        _validate_ha005(evidence, numeric_sanitization, published)

    numeric_attestation = _ha005_report(
        evidence, published_at_utc=published, observed_at_utc=observed
    )
    numeric_attestation["attestation"] = {
        name: 1 for name in numeric_attestation["attestation"]
    }
    with pytest.raises(CONTRACT.ContractError, match="flags are not boolean true"):
        _validate_ha005(evidence, numeric_attestation, published)

    numeric_backup = _ha005_report(
        evidence, published_at_utc=published, observed_at_utc=observed
    )
    numeric_backup["transitions"]["rollback"][
        "matching_managed_backup_restored"
    ] = 1
    with pytest.raises(CONTRACT.ContractError, match="not boolean true"):
        _validate_ha005(evidence, numeric_backup, published)

    wrong_arch = _ha005_report(
        evidence, published_at_utc=published, observed_at_utc=observed
    )
    wrong_arch["environment"]["architecture"] = "aarch64"
    with pytest.raises(CONTRACT.ContractError, match="architecture is not amd64"):
        _validate_ha005(evidence, wrong_arch, published)

    prepublish_observation = _ha005_report(
        evidence,
        published_at_utc=published,
        observed_at_utc=(now - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )
    with pytest.raises(CONTRACT.ContractError, match="predates the GitHub Release"):
        _validate_ha005(evidence, prepublish_observation, published)

    with pytest.raises(CONTRACT.ContractError, match="numeric v2 release"):
        candidate = evidence["candidate"]
        CONTRACT.validate_ha005_report(
            evidence,
            _ha005_report(
                evidence, published_at_utc=published, observed_at_utc=observed
            ),
            version="1.9.9",
            source_sha=candidate["source_sha"],
            generic_digest=candidate["images"]["generic"]["digest"],
            amd64_runtime_digest=candidate["images"]["amd64"]["runtime_digest"],
            published_at_utc=published,
        )


def test_public_install_report_binds_both_architectures_and_canonicalizes(
    tmp_path: Path,
) -> None:
    evidence = _release_evidence()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    published = (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    observed = (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    report = _public_install_report(
        evidence, published_at_utc=published, observed_at_utc=observed
    )
    assert _validate_public_install(evidence, report, published) == report
    assert all(
        "HA-008" not in identifiers
        for identifiers in CONTRACT.EXPECTED_HAOS_GATE_TEST_IDS.values()
    )

    evidence_path = tmp_path / "release-evidence.json"
    evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
    report_path = tmp_path / "submitted.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    output_path = tmp_path / "public-install-acceptance.json"
    candidate = evidence["candidate"]
    result = _run(
        [
            "python3",
            str(CONTRACT_PATH),
            "public-install-report",
            "--release-evidence",
            str(evidence_path),
            "--report",
            str(report_path),
            "--version",
            candidate["version"],
            "--source-sha",
            candidate["source_sha"],
            "--generic-digest",
            candidate["images"]["generic"]["digest"],
            "--amd64-runtime-digest",
            candidate["images"]["amd64"]["runtime_digest"],
            "--aarch64-runtime-digest",
            candidate["images"]["aarch64"]["runtime_digest"],
            "--published-at-utc",
            published,
            "--output",
            str(output_path),
        ]
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(output_path.read_text()) == report
    assert output_path.read_text().endswith("\n")

    unchanged_template = json.loads(
        (ROOT / "docs/v2/public-install-acceptance-template.json").read_text()
    )
    with pytest.raises(CONTRACT.ContractError, match="report did not pass"):
        _validate_public_install(evidence, unchanged_template, published)


def test_public_install_report_rejects_incomplete_or_drifted_observations() -> None:
    evidence = _release_evidence()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    published = (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    observed = (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def report() -> dict[str, object]:
        return _public_install_report(
            evidence, published_at_utc=published, observed_at_utc=observed
        )

    missing_arch = report()
    missing_arch["installations"].pop("aarch64")
    with pytest.raises(CONTRACT.ContractError, match="architecture set is not exact"):
        _validate_public_install(evidence, missing_arch, published)

    extra_arch = report()
    extra_arch["installations"]["s390x"] = dict(
        extra_arch["installations"]["amd64"]
    )
    with pytest.raises(CONTRACT.ContractError, match="architecture set is not exact"):
        _validate_public_install(evidence, extra_arch, published)

    wrong_release = report()
    wrong_release["release"]["source_sha"] = "b" * 40
    with pytest.raises(CONTRACT.ContractError, match="release binding differs"):
        _validate_public_install(evidence, wrong_release, published)

    wrong_repository = report()
    wrong_repository["release"]["repository_url"] = "https://example.invalid/repo"
    with pytest.raises(CONTRACT.ContractError, match="release binding differs"):
        _validate_public_install(evidence, wrong_repository, published)

    wrong_generic = report()
    wrong_generic["installations"]["amd64"]["observed_generic_digest"] = (
        _digest("wrong-public-generic")
    )
    with pytest.raises(CONTRACT.ContractError, match="generic digest differs"):
        _validate_public_install(evidence, wrong_generic, published)

    swapped_leaf = report()
    swapped_leaf["installations"]["aarch64"]["observed_runtime_digest"] = (
        evidence["candidate"]["images"]["amd64"]["runtime_digest"]
    )
    with pytest.raises(CONTRACT.ContractError, match="runtime digest differs"):
        _validate_public_install(evidence, swapped_leaf, published)

    candidate_source = report()
    candidate_source["installations"]["amd64"]["installation_source"] = (
        "local_addons_source_build"
    )
    with pytest.raises(CONTRACT.ContractError, match="installation source"):
        _validate_public_install(evidence, candidate_source, published)

    reused_identity = report()
    reused_identity["installations"]["amd64"][
        "data_identity_before_restart_sha256"
    ] = (
        reused_identity["installations"]["amd64"]["repository_id_sha256"]
    )
    reused_identity["installations"]["amd64"][
        "data_identity_after_restart_sha256"
    ] = reused_identity["installations"]["amd64"]["repository_id_sha256"]
    with pytest.raises(CONTRACT.ContractError, match="must be distinct"):
        _validate_public_install(evidence, reused_identity, published)

    changed_after_restart = report()
    changed_after_restart["installations"]["aarch64"][
        "data_identity_after_restart_sha256"
    ] = _digest("different-aarch64-data-identity")
    with pytest.raises(CONTRACT.ContractError, match="changed across restart"):
        _validate_public_install(evidence, changed_after_restart, published)

    reused_across_architectures = report()
    amd64_identity = reused_across_architectures["installations"]["amd64"][
        "data_identity_before_restart_sha256"
    ]
    reused_across_architectures["installations"]["aarch64"][
        "data_identity_before_restart_sha256"
    ] = amd64_identity
    reused_across_architectures["installations"]["aarch64"][
        "data_identity_after_restart_sha256"
    ] = amd64_identity
    with pytest.raises(CONTRACT.ContractError, match="unique across architectures"):
        _validate_public_install(
            evidence, reused_across_architectures, published
        )

    missing_check = report()
    missing_check["installations"]["aarch64"]["checks"].pop(
        "fresh_install_from_original_public_repository"
    )
    with pytest.raises(CONTRACT.ContractError, match="checks are incomplete"):
        _validate_public_install(evidence, missing_check, published)

    not_run_check = report()
    not_run_check["installations"]["amd64"]["checks"][
        "supervisor_healthy_after_restart"
    ] = "NOT_RUN"
    with pytest.raises(CONTRACT.ContractError, match="checks are incomplete"):
        _validate_public_install(evidence, not_run_check, published)

    wrong_repository_version = report()
    wrong_repository_version["installations"]["aarch64"][
        "observed_repository_version"
    ] = "2.0.1"
    with pytest.raises(CONTRACT.ContractError, match="metadata version differs"):
        _validate_public_install(evidence, wrong_repository_version, published)

    wrong_arch = report()
    wrong_arch["installations"]["amd64"]["environment"]["architecture"] = (
        "aarch64"
    )
    with pytest.raises(CONTRACT.ContractError, match="architecture differs"):
        _validate_public_install(evidence, wrong_arch, published)

    complain_mode = report()
    complain_mode["installations"]["aarch64"]["environment"][
        "apparmor_mode"
    ] = "complain"
    with pytest.raises(CONTRACT.ContractError, match="AppArmor mode"):
        _validate_public_install(evidence, complain_mode, published)

    wrong_app_version = report()
    wrong_app_version["installations"]["amd64"]["environment"][
        "final_app_version"
    ] = "2.0.1"
    with pytest.raises(CONTRACT.ContractError, match="final App version differs"):
        _validate_public_install(evidence, wrong_app_version, published)

    numeric_sanitization = report()
    numeric_sanitization["sanitization"] = {
        name: 0 for name in numeric_sanitization["sanitization"]
    }
    with pytest.raises(CONTRACT.ContractError, match="not boolean false"):
        _validate_public_install(evidence, numeric_sanitization, published)

    numeric_attestation = report()
    numeric_attestation["attestation"] = {
        name: 1 for name in numeric_attestation["attestation"]
    }
    with pytest.raises(CONTRACT.ContractError, match="not boolean true"):
        _validate_public_install(evidence, numeric_attestation, published)

    prepublish = report()
    prepublish["installations"]["amd64"]["observed_at_utc"] = (
        now - timedelta(hours=3)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    with pytest.raises(CONTRACT.ContractError, match="predates"):
        _validate_public_install(evidence, prepublish, published)

    future = report()
    future["installations"]["aarch64"]["observed_at_utc"] = (
        now + timedelta(minutes=6)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")
    with pytest.raises(CONTRACT.ContractError, match="future"):
        _validate_public_install(evidence, future, published)

    future_published = (now + timedelta(minutes=6)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    future_release = _public_install_report(
        evidence,
        published_at_utc=future_published,
        observed_at_utc=future_published,
    )
    with pytest.raises(CONTRACT.ContractError, match="published timestamp is in the future"):
        _validate_public_install(evidence, future_release, future_published)

    old_published = (now - timedelta(days=32)).strftime("%Y-%m-%dT%H:%M:%SZ")
    stale = _public_install_report(
        evidence,
        published_at_utc=old_published,
        observed_at_utc=(now - timedelta(days=31)).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )
    with pytest.raises(CONTRACT.ContractError, match="older than 30 days"):
        _validate_public_install(evidence, stale, old_published)

    ha005_report = _ha005_report(
        evidence, published_at_utc=published, observed_at_utc=observed
    )
    with pytest.raises(CONTRACT.ContractError, match="keys are not exact"):
        _validate_public_install(evidence, ha005_report, published)
    with pytest.raises(CONTRACT.ContractError, match="keys are not exact"):
        CONTRACT.validate_ha005_report(
            evidence,
            report(),
            version=evidence["candidate"]["version"],
            source_sha=evidence["candidate"]["source_sha"],
            generic_digest=evidence["candidate"]["images"]["generic"]["digest"],
            amd64_runtime_digest=evidence["candidate"]["images"]["amd64"][
                "runtime_digest"
            ],
            published_at_utc=published,
        )


def test_haos_and_public_install_reports_enforce_exact_30_day_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixed_now = datetime(2026, 8, 12, 12, 0, 0, tzinfo=timezone.utc)

    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz: timezone | None = None) -> datetime:
            return fixed_now if tz is not None else fixed_now.replace(tzinfo=None)

    monkeypatch.setattr(CONTRACT, "datetime", FixedDateTime)
    boundary = (fixed_now - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    expired = (fixed_now - timedelta(days=30, seconds=1)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )

    candidate = _candidate()
    haos_report = _haos_report(candidate, "telegram_modes")
    haos_report["observed_at_utc"] = boundary
    CONTRACT.validate_haos_gate_report(candidate, "telegram_modes", haos_report)
    haos_report["observed_at_utc"] = expired
    with pytest.raises(CONTRACT.ContractError, match="older than 30 days"):
        CONTRACT.validate_haos_gate_report(
            candidate, "telegram_modes", haos_report
        )

    evidence = _release_evidence(candidate)
    published = (fixed_now - timedelta(days=31)).strftime("%Y-%m-%dT%H:%M:%SZ")
    public_report = _public_install_report(
        evidence,
        published_at_utc=published,
        observed_at_utc=boundary,
    )
    _validate_public_install(evidence, public_report, published)
    public_report["installations"]["amd64"]["observed_at_utc"] = expired
    with pytest.raises(CONTRACT.ContractError, match="older than 30 days"):
        _validate_public_install(evidence, public_report, published)


def test_public_install_report_loader_rejects_unsafe_or_ambiguous_files(
    tmp_path: Path,
) -> None:
    duplicate = tmp_path / "duplicate.json"
    duplicate.write_text('{"schema":"one","schema":"two"}\n', encoding="utf-8")
    with pytest.raises(CONTRACT.ContractError, match="duplicate JSON key"):
        CONTRACT.load_public_install_report(duplicate)

    target = tmp_path / "target.json"
    target.write_text("{}\n", encoding="utf-8")
    symlink = tmp_path / "symlink.json"
    symlink.symlink_to(target)
    with pytest.raises(CONTRACT.ContractError, match="single regular file"):
        CONTRACT.load_public_install_report(symlink)

    hardlink = tmp_path / "hardlink.json"
    os.link(target, hardlink)
    with pytest.raises(CONTRACT.ContractError, match="single regular file"):
        CONTRACT.load_public_install_report(hardlink)

    oversized = tmp_path / "oversized.json"
    oversized.write_bytes(b" " * (CONTRACT.PUBLIC_INSTALL_MAX_BYTES + 1))
    with pytest.raises(CONTRACT.ContractError, match="exceeds 60000 bytes"):
        CONTRACT.load_public_install_report(oversized)


@pytest.mark.parametrize(
    "asset_name",
    ["ha005-acceptance.json", "public-install-acceptance.json"],
)
def test_release_acceptance_attachment_is_create_once_and_never_clobbers(
    tmp_path: Path, asset_name: str,
) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    remote_asset = tmp_path / f"remote-{asset_name}"
    upload_log = tmp_path / "uploads.log"
    _write_executable(
        fake_bin / "gh",
        """#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $1 == api ]]; then
  endpoint=$2
  case "$endpoint" in
    */git/ref/tags/*)
      jq --null-input --arg sha "${FAKE_TAG_OBJECT}" \
        '{object: {type: "tag", sha: $sha}}'
      ;;
    */git/tags/*)
      jq --null-input \
        --arg source "${FAKE_SOURCE_SHA}" \
        --arg version "${FAKE_VERSION}" \
        '{tag: $version, object: {type: "commit", sha: $source}}'
      ;;
    */releases/tags/*)
      if [[ -f ${FAKE_REMOTE_ASSET} ]]; then
        digest="sha256:$(sha256sum "${FAKE_REMOTE_ASSET}" | cut -d ' ' -f 1)"
        size=$(stat --format '%s' "${FAKE_REMOTE_ASSET}")
        jq --null-input \
          --arg digest "$digest" \
          --arg asset_name "${FAKE_ASSET_NAME}" \
          --arg source "${FAKE_SOURCE_SHA}" \
          --arg version "${FAKE_VERSION}" \
          --argjson prerelease "${FAKE_PRERELEASE}" \
          --argjson duplicate "${FAKE_DUPLICATE}" \
          --argjson size "$size" \
          '{tag_name: $version, target_commitish: $source, draft: false,
            prerelease: $prerelease,
            published_at: "2026-08-12T00:00:00Z",
            assets: [{name: $asset_name, state: "uploaded",
              digest: $digest, size: $size}]}
          | if $duplicate then .assets += [.assets[0]] else . end'
      else
        jq --null-input \
          --arg source "${FAKE_SOURCE_SHA}" \
          --arg version "${FAKE_VERSION}" \
          --argjson prerelease "${FAKE_PRERELEASE}" \
          '{tag_name: $version, target_commitish: $source, draft: false,
            prerelease: $prerelease,
            published_at: "2026-08-12T00:00:00Z", assets: []}'
      fi
      ;;
    *) exit 64 ;;
  esac
elif [[ $1 == release && $2 == upload ]]; then
  if [[ ${FAKE_UPLOAD_NOOP} != 1 ]]; then
    cp -- "$4" "${FAKE_REMOTE_ASSET}"
  fi
  printf 'upload\n' >> "${FAKE_UPLOAD_LOG}"
elif [[ $1 == release && $2 == download ]]; then
  shift 3
  output_directory=
  while (($#)); do
    if [[ $1 == --dir ]]; then output_directory=$2; shift 2; else shift; fi
  done
  cp -- "${FAKE_REMOTE_ASSET}" "${output_directory}/${FAKE_ASSET_NAME}"
else
  exit 64
fi
""",
    )
    source_sha = "a" * 40
    version = "2.0.0"
    local_asset = tmp_path / asset_name
    if asset_name == "ha005-acceptance.json":
        schema = CONTRACT.HA005_REPORT_SCHEMA
        test_id = "HA-005"
        swapped_schema = CONTRACT.PUBLIC_INSTALL_REPORT_SCHEMA
    else:
        schema = CONTRACT.PUBLIC_INSTALL_REPORT_SCHEMA
        test_id = "HA-008"
        swapped_schema = CONTRACT.HA005_REPORT_SCHEMA
    valid_attachment = {
        "schema": schema,
        "test_id": test_id,
        "status": "PASS",
        "release": {"version": version, "source_sha": source_sha},
    }
    local_asset.write_text(
        json.dumps(valid_attachment) + "\n", encoding="utf-8"
    )
    env = os.environ | {
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "FAKE_REMOTE_ASSET": str(remote_asset),
        "FAKE_ASSET_NAME": asset_name,
        "FAKE_DUPLICATE": "false",
        "FAKE_PRERELEASE": "true",
        "FAKE_SOURCE_SHA": source_sha,
        "FAKE_TAG_OBJECT": "c" * 40,
        "FAKE_UPLOAD_LOG": str(upload_log),
        "FAKE_UPLOAD_NOOP": "0",
        "FAKE_VERSION": version,
        "GITHUB_REPOSITORY": "Kanu-Coffee/antigravity-for-home-assistant",
    }
    script = ROOT / ".github/scripts/ensure-release-acceptance.sh"

    invalid_attachment = dict(valid_attachment)
    invalid_attachment["schema"] = swapped_schema
    local_asset.write_text(
        json.dumps(invalid_attachment) + "\n", encoding="utf-8"
    )
    rejected = _run(
        ["bash", str(script), version, source_sha, str(local_asset)], env=env
    )
    assert rejected.returncode != 0
    assert "schema or release binding differs" in rejected.stderr
    assert not remote_asset.exists()
    assert not upload_log.exists()
    local_asset.write_text(
        json.dumps(valid_attachment) + "\n", encoding="utf-8"
    )

    created = _run(
        ["bash", str(script), version, source_sha, str(local_asset)], env=env
    )
    assert created.returncode == 0, created.stderr
    assert remote_asset.read_bytes() == local_asset.read_bytes()

    resumed = _run(
        ["bash", str(script), version, source_sha, str(local_asset)], env=env
    )
    assert resumed.returncode == 0, resumed.stderr
    assert upload_log.read_text().splitlines() == ["upload"]

    original_remote = remote_asset.read_bytes()
    conflicting_attachment = dict(valid_attachment)
    conflicting_attachment["unexpected"] = True
    local_asset.write_text(
        json.dumps(conflicting_attachment) + "\n", encoding="utf-8"
    )
    conflict = _run(
        ["bash", str(script), version, source_sha, str(local_asset)], env=env
    )
    assert conflict.returncode != 0
    assert remote_asset.read_bytes() == original_remote

    local_asset.write_bytes(original_remote)
    uploads_before = upload_log.read_bytes()
    final_release_env = env | {"FAKE_PRERELEASE": "false"}
    wrong_release_state = _run(
        ["bash", str(script), version, source_sha, str(local_asset)],
        env=final_release_env,
    )
    assert wrong_release_state.returncode != 0
    assert remote_asset.read_bytes() == original_remote
    assert upload_log.read_bytes() == uploads_before

    duplicate = _run(
        ["bash", str(script), version, source_sha, str(local_asset)],
        env=env | {"FAKE_DUPLICATE": "true"},
    )
    assert duplicate.returncode != 0
    assert remote_asset.read_bytes() == original_remote
    assert upload_log.read_bytes() == uploads_before

    remote_asset.unlink()
    no_op_upload = _run(
        ["bash", str(script), version, source_sha, str(local_asset)],
        env=env | {"FAKE_UPLOAD_NOOP": "1"},
    )
    assert no_op_upload.returncode != 0
    assert not remote_asset.exists()


def _registry_fake_environment(
    tmp_path: Path,
    versions: object,
    raw_manifest: bytes,
    expected_digest: str,
    gh_exit: int = 0,
    precheck_not_found: bool = False,
    precheck_not_found_message: str = "manifest unknown",
    inspect_error: str = "",
) -> tuple[dict[str, str], Path]:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    log = tmp_path / "docker.log"
    _write_executable(
        fake_bin / "gh",
        """#!/usr/bin/env bash
if [[ ${FAKE_GH_EXIT} != 0 ]]; then
  echo 'HTTP 403: forbidden' >&2
  exit "${FAKE_GH_EXIT}"
fi
printf '%s' "${FAKE_VERSIONS_JSON}"
""",
    )
    _write_executable(
        fake_bin / "docker",
        """#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ $1 == buildx && $2 == imagetools && $3 == inspect ]]; then
  if [[ -n ${FAKE_INSPECT_ERROR} ]]; then
    printf '%s\n' "$FAKE_INSPECT_ERROR" >&2
    exit 1
  fi
  if [[ ${FAKE_PRECHECK_NOT_FOUND} == 1 && ! -e ${FAKE_CREATED_STATE} ]]; then
    printf '%s\n' "$FAKE_PRECHECK_NOT_FOUND_MESSAGE" >&2
    exit 1
  fi
  cat "$FAKE_RAW_MANIFEST"
elif [[ $1 == buildx && $2 == imagetools && $3 == create ]]; then
  while (($#)); do
    if [[ $1 == --metadata-file ]]; then metadata=$2; shift 2; else shift; fi
  done
  touch "$FAKE_CREATED_STATE"
  printf '{"containerimage.descriptor":{"digest":"%s"}}\n' \
    "$FAKE_EXPECTED_DIGEST" > "$metadata"
else
  exit 64
fi
""",
    )
    raw_path = tmp_path / "raw.json"
    raw_path.write_bytes(raw_manifest)
    env = os.environ | {
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "FAKE_DOCKER_LOG": str(log),
        "FAKE_EXPECTED_DIGEST": expected_digest,
        "FAKE_CREATED_STATE": str(tmp_path / "created"),
        "FAKE_GH_EXIT": str(gh_exit),
        "FAKE_INSPECT_ERROR": inspect_error,
        "FAKE_PRECHECK_NOT_FOUND": "1" if precheck_not_found else "0",
        "FAKE_PRECHECK_NOT_FOUND_MESSAGE": precheck_not_found_message,
        "FAKE_RAW_MANIFEST": str(raw_path),
        "FAKE_VERSIONS_JSON": json.dumps(versions),
        "GH_TOKEN": "synthetic-token",
    }
    return env, log


def test_registry_promotion_absent_same_conflict_and_api_error(
    tmp_path: Path,
) -> None:
    raw = b'{"schemaVersion":2}'
    digest = _digest(raw)
    target = (
        "ghcr.io/kanu-coffee/antigravity-for-home-assistant:2.0.0"
    )
    source = (
        "ghcr.io/kanu-coffee/antigravity-for-home-assistant@" + digest
    )
    script = ROOT / ".github/scripts/release-oci.sh"

    wrong_repository = source.replace(
        "/antigravity-for-home-assistant@",
        "/amd64-antigravity-for-home-assistant@",
    )
    result = _run(
        [
            "bash",
            str(script),
            "ensure-tag",
            target,
            wrong_repository,
            digest,
        ]
    )
    assert result.returncode == 64
    assert "same repository" in result.stderr

    absent_dir = tmp_path / "absent"
    absent_dir.mkdir()
    env, log = _registry_fake_environment(
        absent_dir, [[]], raw, digest, precheck_not_found=True
    )
    result = _run(
        ["bash", str(script), "ensure-tag", target, source, digest], env=env
    )
    assert result.returncode == 0, result.stderr
    assert "imagetools create" in log.read_text()

    buildx_not_found_dir = tmp_path / "buildx-not-found"
    buildx_not_found_dir.mkdir()
    env, log = _registry_fake_environment(
        buildx_not_found_dir,
        [[]],
        raw,
        digest,
        precheck_not_found=True,
        precheck_not_found_message=f"ERROR: {target}: not found",
    )
    result = _run(
        ["bash", str(script), "ensure-tag", target, source, digest], env=env
    )
    assert result.returncode == 0, result.stderr
    assert "imagetools create" in log.read_text()

    wrong_target_dir = tmp_path / "wrong-target-not-found"
    wrong_target_dir.mkdir()
    env, log = _registry_fake_environment(
        wrong_target_dir,
        [[]],
        raw,
        digest,
        inspect_error=(
            "ERROR: ghcr.io/kanu-coffee/"
            "amd64-antigravity-for-home-assistant:2.0.0: not found"
        ),
    )
    result = _run(
        ["bash", str(script), "ensure-tag", target, source, digest], env=env
    )
    assert result.returncode != 0
    assert "registry absence was not established" in result.stderr
    assert "imagetools create" not in log.read_text()

    mixed_error_dir = tmp_path / "mixed-not-found-error"
    mixed_error_dir.mkdir()
    env, log = _registry_fake_environment(
        mixed_error_dir,
        [[]],
        raw,
        digest,
        inspect_error=f"ERROR: {target}: not found\nunexpected EOF",
    )
    result = _run(
        ["bash", str(script), "ensure-tag", target, source, digest], env=env
    )
    assert result.returncode != 0
    assert "registry absence was not established" in result.stderr
    assert "imagetools create" not in log.read_text()

    same_dir = tmp_path / "same"
    same_dir.mkdir()
    versions = [[{"metadata": {"container": {"tags": ["2.0.0"]}}}]]
    env, log = _registry_fake_environment(same_dir, versions, raw, digest)
    result = _run(
        ["bash", str(script), "ensure-tag", target, source, digest], env=env
    )
    assert result.returncode == 0, result.stderr
    assert "imagetools create" not in log.read_text()

    conflict_dir = tmp_path / "conflict"
    conflict_dir.mkdir()
    env, _ = _registry_fake_environment(
        conflict_dir, versions, b'{"different":true}', digest
    )
    result = _run(
        ["bash", str(script), "ensure-tag", target, source, digest], env=env
    )
    assert result.returncode != 0
    assert "conflict:" in result.stderr

    forbidden_dir = tmp_path / "forbidden"
    forbidden_dir.mkdir()
    env, log = _registry_fake_environment(
        forbidden_dir, [], raw, digest, gh_exit=1
    )
    result = _run(
        ["bash", str(script), "ensure-tag", target, source, digest], env=env
    )
    assert result.returncode != 0
    assert not log.exists()

    drift_dir = tmp_path / "api-lag-conflict"
    drift_dir.mkdir()
    env, log = _registry_fake_environment(
        drift_dir, [[]], b'{"visible":"different"}', digest
    )
    result = _run(
        ["bash", str(script), "ensure-tag", target, source, digest], env=env
    )
    assert result.returncode != 0
    assert "conflict:" in result.stderr
    assert "imagetools create" not in log.read_text()

    transport_dir = tmp_path / "inspect-error"
    transport_dir.mkdir()
    env, log = _registry_fake_environment(
        transport_dir,
        [[]],
        raw,
        digest,
        inspect_error="unexpected EOF",
    )
    result = _run(
        ["bash", str(script), "ensure-tag", target, source, digest], env=env
    )
    assert result.returncode != 0
    assert "registry absence was not established" in result.stderr
    assert "imagetools create" not in log.read_text()


def _release_environment(
    tmp_path: Path,
    source_sha: str,
    target_commitish: str,
    remote_tag_source: str,
    release_absent: bool = False,
    default_contains_source: bool = True,
    workflow_tree_matches: bool = True,
) -> tuple[dict[str, str], Path, Path, Path]:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    notes = tmp_path / "notes.md"
    notes.write_text("deterministic notes\n", encoding="utf-8")
    asset = tmp_path / "evidence.json"
    asset.write_text('{"evidence":true}\n', encoding="utf-8")
    remote_assets = tmp_path / "remote-assets"
    remote_assets.mkdir()
    (remote_assets / asset.name).write_bytes(asset.read_bytes())
    release = {
        "tag_name": "2.0.0",
        "target_commitish": target_commitish,
        "draft": False,
        "prerelease": True,
        "body": "deterministic notes",
        "assets": [
            {
                "name": asset.name,
                "state": "uploaded",
                "digest": _digest(asset.read_bytes()),
                "size": asset.stat().st_size,
            }
        ],
    }
    _write_executable(
        fake_bin / "gh",
        """#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $1 == api && $2 == */git/ref/tags/* ]]; then
  printf '{"object":{"type":"tag","sha":"%s"}}\n' "$FAKE_TAG_OBJECT"
elif [[ $1 == api && $2 == */git/tags/* ]]; then
  printf '{"tag":"2.0.0","object":{"type":"commit","sha":"%s"}}\n' \
    "$FAKE_REMOTE_TAG_SOURCE"
elif [[ $1 == api && $2 == */releases/tags/* ]]; then
  if [[ ${FAKE_RELEASE_ABSENT} == 1 && ! -e ${FAKE_RELEASE_STATE} ]]; then
    echo 'gh: Not Found (HTTP 404)' >&2
    exit 1
  fi
  cat "$FAKE_RELEASE_JSON"
elif [[ $1 == api && $2 == "/repos/${GITHUB_REPOSITORY}" ]]; then
  printf '{"default_branch":"main"}\n'
elif [[ $1 == api && $2 == */commits/main ]]; then
  printf '{"sha":"%s"}\n' "$FAKE_DEFAULT_SHA"
elif [[ $1 == api && $2 == */compare/* ]]; then
  cat "$FAKE_COMPARE_JSON"
elif [[ $1 == api && $2 == */git/commits/* ]]; then
  if [[ $2 == */${FAKE_SOURCE_SHA} ]]; then
    printf '{"tree":{"sha":"%s"}}\n' "$FAKE_SOURCE_ROOT_TREE"
  else
    printf '{"tree":{"sha":"%s"}}\n' "$FAKE_DEFAULT_ROOT_TREE"
  fi
elif [[ $1 == api && $2 == */git/trees/${FAKE_SOURCE_ROOT_TREE} ]]; then
  printf '{"tree":[{"path":".github","type":"tree","sha":"%s"}]}\n' \
    "$FAKE_SOURCE_GITHUB_TREE"
elif [[ $1 == api && $2 == */git/trees/${FAKE_DEFAULT_ROOT_TREE} ]]; then
  printf '{"tree":[{"path":".github","type":"tree","sha":"%s"}]}\n' \
    "$FAKE_DEFAULT_GITHUB_TREE"
elif [[ $1 == api && $2 == */git/trees/${FAKE_SOURCE_GITHUB_TREE} ]]; then
  printf '{"tree":[{"path":"workflows","type":"tree","sha":"%s"}]}\n' \
    "$FAKE_SOURCE_WORKFLOW_TREE"
elif [[ $1 == api && $2 == */git/trees/${FAKE_DEFAULT_GITHUB_TREE} ]]; then
  printf '{"tree":[{"path":"workflows","type":"tree","sha":"%s"}]}\n' \
    "$FAKE_DEFAULT_WORKFLOW_TREE"
elif [[ $1 == release && $2 == download ]]; then
  shift 2
  while (($#)); do
    case $1 in
      --pattern) pattern=$2; shift 2 ;;
      --dir) directory=$2; shift 2 ;;
      *) shift ;;
    esac
  done
  mkdir -p "$directory"
  cp "$FAKE_REMOTE_ASSETS/$pattern" "$directory/$pattern"
elif [[ $1 == release && $2 == upload ]]; then
  printf '%s\n' "$*" >> "$FAKE_RELEASE_LOG"
  if [[ ${FAKE_UPLOAD_NOOP} != 1 ]]; then
    upload_asset=$4
    upload_name=${upload_asset##*/}
    cp "$upload_asset" "$FAKE_REMOTE_ASSETS/$upload_name"
    upload_digest="sha256:$(sha256sum "$upload_asset" | cut -d ' ' -f 1)"
    upload_size=$(stat --format '%s' "$upload_asset")
    jq \
      --arg digest "$upload_digest" \
      --arg name "$upload_name" \
      --argjson size "$upload_size" \
      '.assets += [{name: $name, state: "uploaded", digest: $digest, size: $size}]' \
      "$FAKE_RELEASE_JSON" > "${FAKE_RELEASE_JSON}.tmp"
    mv "${FAKE_RELEASE_JSON}.tmp" "$FAKE_RELEASE_JSON"
  fi
elif [[ $1 == release && $2 == create ]]; then
  printf '%s\n' "$*" >> "$FAKE_RELEASE_LOG"
  touch "$FAKE_RELEASE_STATE"
  if [[ ${FAKE_CREATE_PARTIAL} == 1 ]]; then
    jq '.assets = []' "$FAKE_RELEASE_JSON" > "${FAKE_RELEASE_JSON}.tmp"
    mv "${FAKE_RELEASE_JSON}.tmp" "$FAKE_RELEASE_JSON"
  fi
else
  exit 64
fi
""",
    )
    release_path = tmp_path / "release.json"
    release_path.write_text(json.dumps(release), encoding="utf-8")
    release_log = tmp_path / "release.log"
    default_sha = "e" * 40
    compare = {
        "status": "ahead" if default_contains_source else "diverged",
        "merge_base_commit": {
            "sha": source_sha if default_contains_source else "f" * 40
        },
    }
    compare_path = tmp_path / "compare.json"
    compare_path.write_text(json.dumps(compare), encoding="utf-8")
    source_workflow_tree = "5" * 40
    default_workflow_tree = (
        source_workflow_tree if workflow_tree_matches else "6" * 40
    )
    env = os.environ | {
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "FAKE_ASSET": str(asset),
        "FAKE_REMOTE_ASSETS": str(remote_assets),
        "FAKE_RELEASE_JSON": str(release_path),
        "FAKE_RELEASE_LOG": str(release_log),
        "FAKE_RELEASE_ABSENT": "1" if release_absent else "0",
        "FAKE_RELEASE_STATE": str(tmp_path / "release-created"),
        "FAKE_CREATE_PARTIAL": "0",
        "FAKE_UPLOAD_NOOP": "0",
        "FAKE_REMOTE_TAG_SOURCE": remote_tag_source,
        "FAKE_TAG_OBJECT": "c" * 40,
        "FAKE_DEFAULT_SHA": default_sha,
        "FAKE_COMPARE_JSON": str(compare_path),
        "FAKE_SOURCE_SHA": source_sha,
        "FAKE_SOURCE_ROOT_TREE": "1" * 40,
        "FAKE_DEFAULT_ROOT_TREE": "2" * 40,
        "FAKE_SOURCE_GITHUB_TREE": "3" * 40,
        "FAKE_DEFAULT_GITHUB_TREE": "4" * 40,
        "FAKE_SOURCE_WORKFLOW_TREE": source_workflow_tree,
        "FAKE_DEFAULT_WORKFLOW_TREE": default_workflow_tree,
        "GITHUB_REPOSITORY": "Kanu-Coffee/antigravity-for-home-assistant",
        "GH_TOKEN": "synthetic-token",
    }
    return env, notes, asset, release_path


def test_existing_release_requires_exact_remote_tag_and_target(
    tmp_path: Path,
) -> None:
    source = "a" * 40
    script = ROOT / ".github/scripts/ensure-github-release.sh"

    same_dir = tmp_path / "same"
    same_dir.mkdir()
    env, notes, asset, _ = _release_environment(
        same_dir, source, source, source
    )
    result = _run(
        ["bash", str(script), "2.0.0", source, str(notes), str(asset)],
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert "same: GitHub Release" in result.stdout

    partial_dir = tmp_path / "partial"
    partial_dir.mkdir()
    env, notes, asset, release_path = _release_environment(
        partial_dir, source, source, source
    )
    partial_release = json.loads(release_path.read_text())
    partial_release["assets"] = []
    release_path.write_text(json.dumps(partial_release), encoding="utf-8")
    result = _run(
        ["bash", str(script), "2.0.0", source, str(notes), str(asset)],
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert "release upload" in Path(env["FAKE_RELEASE_LOG"]).read_text()

    noop_dir = tmp_path / "noop-upload"
    noop_dir.mkdir()
    env, notes, asset, release_path = _release_environment(
        noop_dir, source, source, source
    )
    noop_release = json.loads(release_path.read_text())
    noop_release["assets"] = []
    release_path.write_text(json.dumps(noop_release), encoding="utf-8")
    env = env | {"FAKE_UPLOAD_NOOP": "1"}
    result = _run(
        ["bash", str(script), "2.0.0", source, str(notes), str(asset)],
        env=env,
    )
    assert result.returncode != 0
    assert "still missing expected asset" in result.stderr
    assert "release upload" in Path(env["FAKE_RELEASE_LOG"]).read_text()

    extra_dir = tmp_path / "extra-asset"
    extra_dir.mkdir()
    env, notes, asset, release_path = _release_environment(
        extra_dir, source, source, source
    )
    extra_bytes = b"unexpected release asset\n"
    (Path(env["FAKE_REMOTE_ASSETS"]) / "evil.zip").write_bytes(extra_bytes)
    extra_release = json.loads(release_path.read_text())
    extra_release["assets"].append(
        {
            "name": "evil.zip",
            "state": "uploaded",
            "digest": _digest(extra_bytes),
            "size": len(extra_bytes),
        }
    )
    release_path.write_text(json.dumps(extra_release), encoding="utf-8")
    result = _run(
        ["bash", str(script), "2.0.0", source, str(notes), str(asset)],
        env=env,
    )
    assert result.returncode != 0
    assert "unexpected asset: evil.zip" in result.stderr
    assert not Path(env["FAKE_RELEASE_LOG"]).exists()

    optional_dir = tmp_path / "optional-acceptance"
    optional_dir.mkdir()
    env, notes, asset, release_path = _release_environment(
        optional_dir, source, source, source
    )
    acceptance_bytes = b'{"schema":"accepted"}\n'
    optional_release = json.loads(release_path.read_text())
    optional_release["assets"].append(
        {
            "name": "ha005-acceptance.json",
            "state": "uploaded",
            "digest": _digest(acceptance_bytes),
            "size": len(acceptance_bytes),
        }
    )
    optional_release["assets"].append(
        {
            "name": "public-install-acceptance.json",
            "state": "uploaded",
            "digest": _digest(b'{"schema":"public-install"}\n'),
            "size": len(b'{"schema":"public-install"}\n'),
        }
    )
    release_path.write_text(json.dumps(optional_release), encoding="utf-8")
    result = _run(
        ["bash", str(script), "2.0.0", source, str(notes), str(asset)],
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert not Path(env["FAKE_RELEASE_LOG"]).exists()

    mixed_dir = tmp_path / "missing-and-conflicting"
    mixed_dir.mkdir()
    env, notes, later_asset, release_path = _release_environment(
        mixed_dir, source, source, source
    )
    missing_asset = mixed_dir / "first-missing.json"
    missing_asset.write_text('{"missing":true}\n', encoding="utf-8")
    conflicting_bytes = b'{"conflicting":true}\n'
    (Path(env["FAKE_REMOTE_ASSETS"]) / later_asset.name).write_bytes(
        conflicting_bytes
    )
    mixed_release = json.loads(release_path.read_text())
    mixed_release["assets"][0]["digest"] = _digest(conflicting_bytes)
    mixed_release["assets"][0]["size"] = len(conflicting_bytes)
    release_path.write_text(json.dumps(mixed_release), encoding="utf-8")
    result = _run(
        [
            "bash",
            str(script),
            "2.0.0",
            source,
            str(notes),
            str(missing_asset),
            str(later_asset),
        ],
        env=env,
    )
    assert result.returncode != 0
    assert "asset metadata conflicts" in result.stderr
    assert not Path(env["FAKE_RELEASE_LOG"]).exists()

    target_dir = tmp_path / "target-conflict"
    target_dir.mkdir()
    env, notes, asset, _ = _release_environment(
        target_dir, source, "b" * 40, source
    )
    assert (
        _run(
            [
                "bash",
                str(script),
                "2.0.0",
                source,
                str(notes),
                str(asset),
            ],
            env=env,
        ).returncode
        != 0
    )

    unmerged_dir = tmp_path / "unmerged-release"
    unmerged_dir.mkdir()
    env, notes, asset, _ = _release_environment(
        unmerged_dir,
        source,
        source,
        source,
        release_absent=True,
        default_contains_source=False,
    )
    result = _run(
        ["bash", str(script), "2.0.0", source, str(notes), str(asset)],
        env=env,
    )
    assert result.returncode != 0
    assert "must be merged into the current default branch" in result.stderr
    assert not Path(env["FAKE_RELEASE_LOG"]).exists()

    workflow_drift_dir = tmp_path / "workflow-drift-release"
    workflow_drift_dir.mkdir()
    env, notes, asset, _ = _release_environment(
        workflow_drift_dir,
        source,
        source,
        source,
        release_absent=True,
        default_contains_source=True,
        workflow_tree_matches=False,
    )
    result = _run(
        ["bash", str(script), "2.0.0", source, str(notes), str(asset)],
        env=env,
    )
    assert result.returncode != 0
    assert "modifies .github/workflows" in result.stderr
    assert not Path(env["FAKE_RELEASE_LOG"]).exists()

    create_dir = tmp_path / "create-release"
    create_dir.mkdir()
    env, notes, asset, _ = _release_environment(
        create_dir,
        source,
        source,
        source,
        release_absent=True,
        default_contains_source=True,
    )
    result = _run(
        ["bash", str(script), "2.0.0", source, str(notes), str(asset)],
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert "release create" in Path(env["FAKE_RELEASE_LOG"]).read_text()

    partial_create_dir = tmp_path / "partial-create-release"
    partial_create_dir.mkdir()
    env, notes, asset, _ = _release_environment(
        partial_create_dir,
        source,
        source,
        source,
        release_absent=True,
        default_contains_source=True,
    )
    env = env | {"FAKE_CREATE_PARTIAL": "1"}
    result = _run(
        ["bash", str(script), "2.0.0", source, str(notes), str(asset)],
        env=env,
    )
    assert result.returncode != 0
    assert "still missing expected asset" in result.stderr
    assert "release create" in Path(env["FAKE_RELEASE_LOG"]).read_text()

    tag_dir = tmp_path / "tag-conflict"
    tag_dir.mkdir()
    env, notes, asset, _ = _release_environment(
        tag_dir, source, source, "d" * 40
    )
    assert (
        _run(
            [
                "bash",
                str(script),
                "2.0.0",
                source,
                str(notes),
                str(asset),
            ],
            env=env,
        ).returncode
        != 0
    )


def test_workflows_encode_exact_release_invariants() -> None:
    candidate = (ROOT / ".github/workflows/candidate.yaml").read_text()
    build = (ROOT / ".github/workflows/build-app.yaml").read_text()
    builder = (ROOT / ".github/workflows/builder.yaml").read_text()
    haos_evidence = (ROOT / ".github/workflows/haos-evidence.yaml").read_text()
    postpublish_ha005 = (
        ROOT / ".github/workflows/postpublish-ha005.yaml"
    ).read_text()
    postpublish_public_install = (
        ROOT / ".github/workflows/postpublish-public-install.yaml"
    ).read_text()
    ci = (ROOT / ".github/workflows/ci.yaml").read_text()
    release_oci = (ROOT / ".github/scripts/release-oci.sh").read_text()
    github_release = (
        ROOT / ".github/scripts/ensure-github-release.sh"
    ).read_text()
    haos_workflow = yaml.safe_load(haos_evidence)
    build_workflow = yaml.safe_load(build)
    postpublish_workflow = yaml.safe_load(postpublish_ha005)
    public_install_workflow = yaml.safe_load(postpublish_public_install)
    assert set(
        haos_workflow["on"]["workflow_dispatch"]["inputs"]["gate"]["options"]
    ) == CONTRACT.EXPECTED_MANUAL_GATES

    assert "candidate-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}" in candidate
    assert "uses: ./.github/workflows/ci.yaml" in candidate
    assert "needs: quality" in candidate
    assert "Finalize must be dispatched at the exact candidate source" in candidate
    assert "ref: ${{ steps.candidate.outputs.source_sha }}" in candidate
    assert "ubuntu-24.04-arm" in build
    assert 'TEST_PLATFORM: ${{ matrix.platform }}' in build
    assert 'HA_ARCH: ${{ matrix.ha_arch }}' in build
    assert build.count("suite: telegram-isolation") == 2
    assert build.count("suite: public-v1") == 1
    assert "public-v1) exec bash tests/public-v1-upgrade-smoke.sh" in build
    assert "Build exact public v1 source image for migration rehearsal" in build
    assert "refs/tags/v1.0.4:refs/tags/v1.0.4" in build
    assert "aba6805e8bf1f32e68976a67a46536c3ca362af8" in build
    assert "git archive v1.0.4 | tar --extract" in build
    assert "--tag antigravity-for-home-assistant:public-v1.0.4-local" in build
    assert (
        "antigravity-for-home-assistant:public-v1.0.4-local \"$image\" ;;"
        in build
    )
    assert "telegram-isolation) exec bash tests/telegram-isolation-smoke.sh" in build
    assert build.count("suite: update") == 2
    assert "- telegram-isolation" in ci
    assert "telegram-isolation-smoke.sh antigravity-for-home-assistant:test" in ci
    assert "CANDIDATE_DIGEST: ${{ needs.assemble-candidate.outputs.generic_digest }}" in build
    assert '"${IMAGE}@${CANDIDATE_DIGEST}"' in build
    assert "size >= 16777216" in build
    assert "Exact amd64 performance and durability release gate" in build
    assert "Create exact HAOS rehearsal tag without rebuilding" in build
    assert "Require anonymous HAOS rehearsal image access" in build
    assert "candidate_repository.py create" in build
    assert "candidate-repository-manifest.json" in build
    assert "--candidate-stage-digest \"$AMD64_STAGE_DIGEST\"" in build
    assert "--candidate-leaf-digest \"$AMD64_RUNTIME_DIGEST\"" in build
    assert "--gap007-evidence gap007-release.json" in build
    assert "gap007_performance_durability" in CONTRACT_PATH.read_text()
    assert "release-evidence/gap007-release.json" in candidate
    assert "release-evidence/haos-gates/*.json" in candidate
    assert "--haos-gates-dir haos-gates" in candidate
    assert "--gap007-evidence release-evidence/gap007-release.json" in builder
    assert "--haos-gates-dir release-evidence/haos-gates" in builder
    assert "release-evidence/haos-gates/*.json" in builder
    assert "Validate and preserve candidate-bound HAOS gate report" in haos_evidence
    assert "release_contract.py haos-report" in haos_evidence
    assert "release_contract.py haos-report-templates" in build
    assert "haos-report-templates/" in build
    assert "haos-report-templates/<gate>.json" in build
    assert "haos-report-templates/<gate>.json" in haos_evidence
    assert "manual-gate-evidence.json" in haos_evidence
    assert "actions/artifacts/${ARTIFACT_ID}/zip" in haos_evidence
    assert "haos_amd64_local_migration" in haos_evidence
    assert "local_migration_rollback" in haos_evidence
    assert "artifact_digest=\"sha256:${RAW_ARTIFACT_DIGEST}\"" in haos_evidence
    assert "Candidate-Run-ID:" in candidate
    assert "Release-Evidence-SHA256:" in candidate
    assert "artifact_digest=\"sha256:${RAW_ARTIFACT_DIGEST}\"" in candidate
    assert "printf 'digest=sha256:%s\\n'" in build
    candidate_upload = next(
        step
        for step in build_workflow["jobs"]["package-candidate"]["steps"]
        if step.get("id") == "upload"
    )
    assert candidate_upload["with"]["retention-days"] == 30
    assert "Require public anonymous candidate before numeric tags" in builder
    assert "release-oci.sh ensure-tag" in builder
    assert "--certificate-github-workflow-sha" in builder
    assert "--certificate-github-workflow-ref" in builder
    assert "--certificate-github-workflow-repository" in builder
    assert "--certificate-github-workflow-trigger push" in builder
    assert "https://spdx.dev/Document/v2.3" in builder
    assert builder.count("create-storage-record: false") == 3
    assert "artifact-metadata: write" not in builder
    assert "ensure-github-release.sh" in builder
    assert "parse-release-tag.sh" in builder
    assert "${{ github.run_id }}-${{ github.run_attempt }}" in ci
    assert "-o antigravity-for-home-assistant-amd64.tar.zst" in ci
    assert "--output antigravity-for-home-assistant-amd64.tar.zst" not in ci
    assert "((ba|da|k|z)?sh|bashio)" in ci
    assert "git grep -Il '^#!'" not in ci
    assert "registry absence was not established" in release_oci
    assert "compare/${source_sha}...${default_sha}" in github_release
    assert "must be merged into the current default branch" in github_release
    assert "source_workflow_tree" in github_release
    assert "default_workflow_tree" in github_release

    assert set(postpublish_workflow["on"]["workflow_dispatch"]["inputs"]) == {
        "version",
        "report_json",
    }
    assert postpublish_workflow["jobs"]["accept"]["permissions"] == {
        "actions": "read",
        "contents": "write",
    }
    assert "collaborators/${maintainer_login}/permission" in postpublish_ha005
    assert '[[ $GITHUB_REF == "refs/tags/${RELEASE_VERSION}" ]]' in postpublish_ha005
    assert "parse-release-tag.sh" in postpublish_ha005
    assert "release-evidence/release-evidence.json" in postpublish_ha005
    assert "cmp --silent" in postpublish_ha005
    assert "docker buildx imagetools inspect --raw" in postpublish_ha005
    assert "export DOCKER_CONFIG=$anonymous_config" in postpublish_ha005
    assert "release_contract.py ha005-report" in postpublish_ha005
    assert ".prerelease == true" in postpublish_ha005
    assert "ha005-acceptance-${{ inputs.version }}" in postpublish_ha005
    assert "ensure-release-acceptance.sh" in postpublish_ha005
    assert ".prerelease == true" in (
        ROOT / ".github/scripts/ensure-release-acceptance.sh"
    ).read_text()
    assert "Candidate / finalize" not in postpublish_ha005
    assert "ha005" not in " ".join(sorted(CONTRACT.EXPECTED_MANUAL_GATES))
    assert set(public_install_workflow["on"]["workflow_dispatch"]["inputs"]) == {
        "version",
        "report_json",
    }
    assert public_install_workflow["jobs"]["accept"]["permissions"] == {
        "actions": "read",
        "contents": "write",
    }
    for token in (
        "collaborators/${maintainer_login}/permission",
        '[[ $GITHUB_REF == "refs/tags/${RELEASE_VERSION}" ]]',
        "parse-release-tag.sh",
        "release-evidence/release-evidence.json",
        "cmp --silent",
        "release_contract.py release",
        "docker buildx imagetools inspect --raw",
        "export DOCKER_CONFIG=$anonymous_config",
        ".draft == false",
        ".prerelease == true",
        "expired == false",
    ):
        assert token in postpublish_public_install
    assert 'docker pull --platform linux/amd64 "${IMAGE}@${AMD64_DIGEST}"' in (
        postpublish_public_install
    )
    assert 'docker pull --platform linux/arm64 "${IMAGE}@${ARM64_DIGEST}"' in (
        postpublish_public_install
    )
    assert "release_contract.py public-install-report" in postpublish_public_install
    assert "--aarch64-runtime-digest \"$ARM64_DIGEST\"" in postpublish_public_install
    assert "public-install-acceptance-${{ inputs.version }}" in postpublish_public_install
    assert "public-install-acceptance.json" in postpublish_public_install
    assert "retention-days: 90" in postpublish_public_install
    assert "ensure-release-acceptance.sh" in postpublish_public_install
    assert "ha005-acceptance.json" not in postpublish_public_install
    assert "Candidate / finalize" not in postpublish_public_install
    assert "HA-008" not in " ".join(
        identifier
        for identifiers in CONTRACT.EXPECTED_HAOS_GATE_TEST_IDS.values()
        for identifier in identifiers
    )
    acceptance_helper = (
        ROOT / ".github/scripts/ensure-release-acceptance.sh"
    ).read_text()
    assert "ha005-acceptance.json)" in acceptance_helper
    assert "public-install-acceptance.json)" in acceptance_helper
    assert CONTRACT.HA005_REPORT_SCHEMA in acceptance_helper
    assert CONTRACT.PUBLIC_INSTALL_REPORT_SCHEMA in acceptance_helper
    assert "public-install-acceptance.json" in github_release
    for path in (
        ROOT / "tests/browser-approval-smoke.sh",
        ROOT / "tests/docker-smoke.sh",
        ROOT / "tests/feedback-smoke.sh",
        ROOT / "tests/managed-auth-smoke.sh",
        ROOT / "tests/managed-plugin-update-smoke.sh",
        ROOT / "tests/memory-smoke.sh",
        ROOT / "tests/telegram-isolation-smoke.sh",
        ROOT / "tests/update-smoke.sh",
        ROOT / "tests/user-files-update-smoke.sh",
    ):
        text = path.read_text()
        assert "TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}" in text
        assert "HA_ARCH=${HA_ARCH:-$EXPECTED_HA_ARCH}" in text
        assert "--platform linux/amd64" not in text


def test_candidate_attempt_policy_is_atomic_and_fail_closed() -> None:
    candidate = (ROOT / ".github/workflows/candidate.yaml").read_text()
    build = (ROOT / ".github/workflows/build-app.yaml").read_text()
    migration_release = (ROOT / "docs/v2/migration-release.md").read_text()
    test_plan = (ROOT / "docs/v2/test-plan.md").read_text()

    assert 'operators must use "Re-run all jobs"' in build
    assert '"Re-run failed jobs" is unsupported and intentionally fails closed' in build
    assert "**Re-run all jobs**" in test_plan
    assert "**Re-run failed jobs**" in test_plan
    assert "**Re-run all jobs**" in migration_release
    assert "**Re-run failed jobs**" in migration_release
    assert (
        "candidate-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}"
        in candidate
    )
    assert (
        "pattern: candidate-arch-digest-${{ github.run_id }}-${{ github.run_attempt }}-*"
        in build
    )
    for artifact_name in (
        "candidate-arch-digest-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.arch }}",
        "candidate-index-${{ github.run_id }}-${{ github.run_attempt }}",
        "candidate-sbom-${{ github.run_id }}-${{ github.run_attempt }}",
        "candidate-gap007-${{ github.run_id }}-${{ github.run_attempt }}",
    ):
        assert artifact_name in build
    assert (
        "pattern: candidate-*-${{ github.run_id }}-${{ github.run_attempt }}"
        in build
    )


def test_postpublish_effective_evidence_deadline_is_documented() -> None:
    contract = CONTRACT_PATH.read_text()
    postpublish = (ROOT / ".github/workflows/postpublish-ha005.yaml").read_text()
    test_plan = (ROOT / "docs/v2/test-plan.md").read_text()

    assert "observed_at >= now - timedelta(days=30)" in contract
    assert "release_contract.py release" in postpublish
    assert (
        "min(finalizer artifact expiry, oldest embedded HAOS observed_at_utc + 30 days)"
        in test_plan
    )
