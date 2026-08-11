from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
from pathlib import Path
from types import ModuleType

import pytest


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


def _manual(candidate: dict[str, object], payload_digest: str) -> dict:
    return {
        "schema": "antigravity-ha-manual-evidence/v1",
        "version": candidate["version"],
        "source_sha": candidate["source_sha"],
        "candidate_manifest_digest": candidate["images"]["generic"][
            "digest"
        ],
        "gates": {
            name: {
                "status": "PASS",
                "evidence_uri": (
                    "https://api.github.com/repos/Kanu-Coffee/"
                    "antigravity-for-home-assistant/actions/artifacts/42/zip"
                ),
                "sha256": payload_digest,
            }
            for name in CONTRACT.EXPECTED_MANUAL_GATES
        },
    }


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
    not_run["gates"]["rollback"]["status"] = "NOT_RUN"
    with pytest.raises(CONTRACT.ContractError, match="not PASS"):
        CONTRACT.validate_manual(candidate, not_run)

    foreign_uri = json.loads(json.dumps(manual))
    foreign_uri["gates"]["rollback"]["evidence_uri"] = (
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
        "finalizer": {"actor": "maintainer", "run_id": 202, "run_attempt": 1},
    }
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
    payload = b"sanitized-haos-evidence-archive"
    manual_path = tmp_path / "manual.json"
    manual_path.write_text(
        json.dumps(_manual(_candidate(), _digest(payload))), encoding="utf-8"
    )
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _write_executable(
        fake_bin / "curl",
        """#!/usr/bin/env bash
set -Eeuo pipefail
output=
while (($#)); do
  if [[ $1 == --output ]]; then output=$2; shift 2; else shift; fi
done
printf '%s' 'sanitized-haos-evidence-archive' > "$output"
""",
    )
    env = os.environ | {
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "GH_TOKEN": "synthetic-token",
    }
    script = ROOT / ".github/scripts/verify-manual-evidence.sh"
    assert _run(["bash", str(script), str(manual_path)], env=env).returncode == 0

    broken = _manual(_candidate(), _digest("different"))
    manual_path.write_text(json.dumps(broken), encoding="utf-8")
    result = _run(["bash", str(script), str(manual_path)], env=env)
    assert result.returncode != 0
    assert "downloaded evidence digest mismatch" in result.stderr


def _registry_fake_environment(
    tmp_path: Path,
    versions: object,
    raw_manifest: bytes,
    expected_digest: str,
    gh_exit: int = 0,
    precheck_not_found: bool = False,
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
    echo 'manifest unknown' >&2
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
    release = {
        "tag_name": "2.0.0",
        "target_commitish": target_commitish,
        "draft": False,
        "prerelease": True,
        "body": "deterministic notes",
        "assets": [{"name": asset.name}],
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
  cp "$FAKE_ASSET" "$directory/$pattern"
elif [[ $1 == release && $2 == upload ]]; then
  printf '%s\n' "$*" >> "$FAKE_RELEASE_LOG"
elif [[ $1 == release && $2 == create ]]; then
  printf '%s\n' "$*" >> "$FAKE_RELEASE_LOG"
  touch "$FAKE_RELEASE_STATE"
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
        "FAKE_RELEASE_JSON": str(release_path),
        "FAKE_RELEASE_LOG": str(release_log),
        "FAKE_RELEASE_ABSENT": "1" if release_absent else "0",
        "FAKE_RELEASE_STATE": str(tmp_path / "release-created"),
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
    ci = (ROOT / ".github/workflows/ci.yaml").read_text()
    release_oci = (ROOT / ".github/scripts/release-oci.sh").read_text()
    github_release = (
        ROOT / ".github/scripts/ensure-github-release.sh"
    ).read_text()

    assert "candidate-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}" in candidate
    assert "uses: ./.github/workflows/ci.yaml" in candidate
    assert "needs: quality" in candidate
    assert "Finalize must be dispatched at the exact candidate source" in candidate
    assert "ref: ${{ steps.candidate.outputs.source_sha }}" in candidate
    assert "ubuntu-24.04-arm" in build
    assert 'TEST_PLATFORM: ${{ matrix.platform }}' in build
    assert 'HA_ARCH: ${{ matrix.ha_arch }}' in build
    assert build.count("suite: telegram-isolation") == 2
    assert "telegram-isolation) exec bash tests/telegram-isolation-smoke.sh" in build
    assert build.count("suite: update") == 2
    assert "- telegram-isolation" in ci
    assert "telegram-isolation-smoke.sh antigravity-for-home-assistant:test" in ci
    assert "CANDIDATE_DIGEST: ${{ needs.assemble-candidate.outputs.generic_digest }}" in build
    assert '"${IMAGE}@${CANDIDATE_DIGEST}"' in build
    assert "size >= 16777216" in build
    assert "Exact amd64 performance and durability release gate" in build
    assert "--candidate-stage-digest \"$AMD64_STAGE_DIGEST\"" in build
    assert "--candidate-leaf-digest \"$AMD64_RUNTIME_DIGEST\"" in build
    assert "--gap007-evidence gap007-release.json" in build
    assert "gap007_performance_durability" in CONTRACT_PATH.read_text()
    assert "release-evidence/gap007-release.json" in candidate
    assert "--gap007-evidence release-evidence/gap007-release.json" in builder
    assert "Candidate-Run-ID:" in candidate
    assert "Release-Evidence-SHA256:" in candidate
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
    assert "((ba|da|k|z)?sh|bashio)" in ci
    assert "git grep -Il '^#!'" not in ci
    assert "registry absence was not established" in release_oci
    assert "compare/${source_sha}...${default_sha}" in github_release
    assert "must be merged into the current default branch" in github_release
    assert "source_workflow_tree" in github_release
    assert "default_workflow_tree" in github_release

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
