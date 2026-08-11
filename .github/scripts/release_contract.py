#!/usr/bin/env python3
"""Fail-closed release evidence and OCI descriptor validation."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


SHA256_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
TAG_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+\Z")
IMAGE_RE = re.compile(
    r"ghcr\.io/kanu-coffee/"
    r"(?:amd64-|aarch64-)?antigravity-for-home-assistant\Z"
)
ARTIFACT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}\Z")
EVIDENCE_URI_RE = re.compile(
    r"(?:"
    r"https://api\.github\.com/repos/Kanu-Coffee/"
    r"antigravity-for-home-assistant/actions/artifacts/[1-9][0-9]*/zip"
    r"|"
    r"https://github\.com/Kanu-Coffee/antigravity-for-home-assistant/"
    r"releases/download/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+"
    r")\Z"
)

OCI_INDEX = "application/vnd.oci.image.index.v1+json"
OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
ATTESTATION_TYPE = "attestation-manifest"
EXPECTED_PLATFORMS = {
    "amd64": {"architecture": "amd64", "os": "linux"},
    "aarch64": {"architecture": "arm64", "os": "linux"},
}
EXPECTED_MANUAL_GATES = {
    "apparmor_enforce",
    "haos_aarch64_install_update",
    "haos_amd64_install_update",
    "migration_modes",
    "native_updater_canary",
    "repository_install_update",
    "rollback",
    "telegram_modes",
}
GAP007_BASELINE_EVIDENCE_SHA256 = (
    "sha256:b2cb64cac2c5f12c61d4a779c06a4bca1307799e485086d9512974e231d51d09"
)
GAP007_LIMITS = {
    "max_average_cpu_percent": 5.0,
    "max_peak_rss_bytes": 201326592,
    "max_image_size_bytes": 600000000,
}
GAP007_MODULE_PATH = "/usr/local/share/antigravity-ha/telegram-bridge.mjs"


class ContractError(RuntimeError):
    """A release input does not satisfy the fail-closed contract."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ContractError(f"cannot read valid JSON from {path}: {error}") from error


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def digest_bytes(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def digest_file(path: Path) -> str:
    try:
        return digest_bytes(path.read_bytes())
    except OSError as error:
        raise ContractError(f"cannot hash evidence file {path}: {error}") from error


def validate_digest(value: Any, name: str) -> str:
    require(isinstance(value, str) and SHA256_RE.fullmatch(value), f"invalid {name}")
    return value


def validate_source_sha(value: Any, name: str = "source SHA") -> str:
    require(isinstance(value, str) and SHA_RE.fullmatch(value), f"invalid {name}")
    return value


def validate_version(value: Any) -> str:
    require(isinstance(value, str) and TAG_RE.fullmatch(value), "invalid numeric version")
    return value


def validate_run_number(value: Any, name: str) -> int:
    if isinstance(value, str):
        require(value.isascii() and value.isdigit(), f"invalid {name}")
        value = int(value)
    require(isinstance(value, int) and not isinstance(value, bool) and value > 0, f"invalid {name}")
    return value


def descriptor_digest(descriptor: Any, name: str) -> str:
    require(isinstance(descriptor, dict), f"{name} is not an object")
    require(descriptor.get("mediaType") == OCI_MANIFEST, f"{name} is not an OCI image manifest")
    require(
        isinstance(descriptor.get("size"), int)
        and not isinstance(descriptor.get("size"), bool)
        and descriptor["size"] > 0,
        f"{name} has invalid size",
    )
    return validate_digest(descriptor.get("digest"), f"{name} digest")


def validate_index_document(
    document: Any,
    expected_arches: tuple[str, ...],
) -> dict[str, str]:
    require(isinstance(document, dict), "OCI index is not an object")
    require(document.get("schemaVersion") == 2, "OCI index schemaVersion is not 2")
    require(document.get("mediaType") == OCI_INDEX, "top-level object is not an OCI index")
    manifests = document.get("manifests")
    require(isinstance(manifests, list), "OCI index manifests is not an array")

    runtime: dict[str, str] = {}
    attestations: list[tuple[str, str]] = []
    for position, descriptor in enumerate(manifests):
        digest = descriptor_digest(descriptor, f"descriptor {position}")
        platform = descriptor.get("platform")
        if platform == {"architecture": "amd64", "os": "linux"}:
            require("amd64" not in runtime, "duplicate linux/amd64 runtime descriptor")
            runtime["amd64"] = digest
            continue
        if platform == {"architecture": "arm64", "os": "linux"}:
            require("aarch64" not in runtime, "duplicate linux/arm64 runtime descriptor")
            runtime["aarch64"] = digest
            continue
        require(
            platform == {"architecture": "unknown", "os": "unknown"},
            f"unexpected runnable or malformed platform descriptor at {position}",
        )
        annotations = descriptor.get("annotations")
        require(isinstance(annotations, dict), f"attestation descriptor {position} lacks annotations")
        require(
            annotations.get("vnd.docker.reference.type") == ATTESTATION_TYPE,
            f"unknown descriptor type at {position}",
        )
        subject = validate_digest(
            annotations.get("vnd.docker.reference.digest"),
            f"attestation subject at {position}",
        )
        attestations.append((digest, subject))

    require(set(runtime) == set(expected_arches), "runtime platform set is not exact")
    runtime_digests = set(runtime.values())
    for _, subject in attestations:
        require(subject in runtime_digests, "attestation points outside the runtime descriptor set")
    require(len({digest for digest, _ in attestations}) == len(attestations), "duplicate attestation descriptor")
    return runtime


def validate_index_file(path: Path, expected_arches: tuple[str, ...]) -> dict[str, str]:
    raw = path.read_bytes()
    result = validate_index_document(json.loads(raw), expected_arches)
    result["index_digest"] = digest_bytes(raw)
    return result


def emit_github_output(path: Path | None, values: dict[str, Any]) -> None:
    if path is None:
        return
    with path.open("a", encoding="utf-8") as stream:
        for key, value in values.items():
            require(re.fullmatch(r"[a-z][a-z0-9_]*", key) is not None, "unsafe output key")
            rendered = str(value)
            require("\n" not in rendered and "\r" not in rendered, f"newline in output {key}")
            stream.write(f"{key}={rendered}\n")


def command_index(args: argparse.Namespace) -> None:
    expected = tuple(args.expected_arch)
    require(len(expected) in {1, 2} and len(set(expected)) == len(expected), "invalid expected architecture list")
    require(set(expected) <= set(EXPECTED_PLATFORMS), "unsupported expected architecture")
    values = validate_index_file(args.manifest, expected)
    if args.expected_digest:
        require(values["index_digest"] == args.expected_digest, "raw manifest digest differs from expected digest")
    emit_github_output(args.github_output, values)
    print(json.dumps(values, sort_keys=True))


def validate_candidate(candidate: Any) -> dict[str, Any]:
    require(isinstance(candidate, dict), "candidate record is not an object")
    require(
        set(candidate)
        == {
            "schema",
            "version",
            "source_sha",
            "run_id",
            "run_attempt",
            "candidate_tag",
            "images",
            "automated_gates",
            "gap007_release",
        },
        "candidate record keys are not exact",
    )
    require(candidate.get("schema") == "antigravity-ha-release-candidate/v1", "wrong candidate schema")
    validate_version(candidate.get("version"))
    source_sha = validate_source_sha(candidate.get("source_sha"))
    run_id = validate_run_number(candidate.get("run_id"), "candidate run ID")
    run_attempt = validate_run_number(candidate.get("run_attempt"), "candidate run attempt")
    expected_candidate_tag = f"candidate-{source_sha}-{run_id}-{run_attempt}"
    require(
        isinstance(candidate.get("candidate_tag"), str)
        and re.fullmatch(r"candidate-[0-9a-f]{40}-[1-9][0-9]*-[1-9][0-9]*", candidate["candidate_tag"]),
        "invalid candidate tag",
    )
    require(candidate["candidate_tag"] == expected_candidate_tag, "candidate tag binding differs from source/run")
    images = candidate.get("images")
    require(isinstance(images, dict) and set(images) == {"generic", "amd64", "aarch64"}, "candidate image set is not exact")
    generic = images["generic"]
    require(isinstance(generic, dict) and set(generic) == {"name", "digest"}, "invalid generic image record")
    require(generic.get("name") == "ghcr.io/kanu-coffee/antigravity-for-home-assistant", "unexpected generic image")
    validate_digest(generic.get("digest"), "generic candidate digest")
    for arch, platform in (("amd64", "linux/amd64"), ("aarch64", "linux/arm64")):
        record = images[arch]
        require(
            isinstance(record, dict)
            and set(record) == {"name", "platform", "runtime_digest", "stage_digest"},
            f"invalid {arch} image record",
        )
        require(IMAGE_RE.fullmatch(record.get("name", "")) is not None, f"unexpected {arch} image")
        expected_prefix = "amd64-" if arch == "amd64" else "aarch64-"
        require(record["name"].split("/")[-1].startswith(expected_prefix), f"wrong package for {arch}")
        require(record.get("platform") == platform, f"wrong platform for {arch}")
        validate_digest(record.get("stage_digest"), f"{arch} stage digest")
        validate_digest(record.get("runtime_digest"), f"{arch} runtime digest")
    gates = candidate.get("automated_gates")
    require(
        gates
        == {
            "exact_digest_smoke": "PASS",
            "gap007_performance_durability": "PASS",
            "native_arm64_full_feasible": "PASS",
            "source_quality": "PASS",
            "spdx_leaf_sbom": "PASS",
        },
        "automated candidate gates are incomplete",
    )
    gap007 = candidate.get("gap007_release")
    require(
        isinstance(gap007, dict)
        and set(gap007)
        == {
            "schema",
            "evidence_sha256",
            "source_sha",
            "amd64_stage_digest",
            "amd64_runtime_digest",
            "candidate_image_id",
            "source_rootfs_sha256",
        },
        "GAP-007 candidate binding is incomplete",
    )
    require(
        gap007.get("schema") == "antigravity-ha-gap007-binding/v1",
        "wrong GAP-007 candidate binding schema",
    )
    validate_digest(gap007.get("evidence_sha256"), "GAP-007 evidence digest")
    validate_digest(gap007.get("candidate_image_id"), "GAP-007 candidate image ID")
    validate_digest(
        gap007.get("source_rootfs_sha256"), "GAP-007 source-rootfs digest"
    )
    require(gap007.get("source_sha") == source_sha, "GAP-007 source differs from candidate")
    require(
        gap007.get("amd64_stage_digest") == images["amd64"]["stage_digest"],
        "GAP-007 amd64 staging digest differs from candidate",
    )
    require(
        gap007.get("amd64_runtime_digest") == images["amd64"]["runtime_digest"],
        "GAP-007 amd64 leaf digest differs from candidate",
    )
    return candidate


def validate_gap007_release(
    candidate: dict[str, Any],
    evidence: Any,
    evidence_sha256: str,
) -> dict[str, Any]:
    require(isinstance(evidence, dict), "GAP-007 evidence is not an object")
    require(
        set(evidence)
        == {
            "schema_version",
            "requirement_id",
            "mode",
            "scope",
            "closure_eligible",
            "result",
            "started_at_utc",
            "finished_at_utc",
            "actual_elapsed_seconds",
            "threshold_policy",
            "provenance",
            "telegram",
            "failure_injection",
            "bounded_io",
            "rapid_restart",
            "resources",
            "sanitization",
            "remaining_gap",
        },
        "GAP-007 evidence keys are not exact",
    )
    binding = candidate["gap007_release"]
    require(
        evidence_sha256 == binding["evidence_sha256"],
        "GAP-007 evidence file hash differs from candidate",
    )
    require(evidence.get("schema_version") == 1, "wrong GAP-007 evidence schema")
    require(evidence.get("requirement_id") == "GAP-007", "wrong GAP-007 requirement")
    require(evidence.get("mode") == "release", "GAP-007 evidence is not release mode")
    require(evidence.get("result") == "PASS", "GAP-007 evidence did not pass")
    require(evidence.get("closure_eligible") is True, "GAP-007 evidence cannot close the gate")
    require(
        evidence.get("threshold_policy")
        == {
            "duration_override_supported": False,
            "override_detected": False,
            "release_soak_seconds": 1800,
            "release_outage_seconds": 900,
            "release_restart_count": 20,
        },
        "GAP-007 threshold policy is stale",
    )
    require(
        isinstance(evidence.get("actual_elapsed_seconds"), (int, float))
        and evidence["actual_elapsed_seconds"] >= 1800,
        "GAP-007 total elapsed time is too short",
    )

    provenance = evidence.get("provenance")
    require(isinstance(provenance, dict), "GAP-007 provenance is missing")
    require(
        provenance.get("git_commit") == candidate["source_sha"]
        and provenance.get("candidate_revision") == candidate["source_sha"],
        "GAP-007 source differs from candidate",
    )
    require(
        provenance.get("candidate_stage_digest")
        == candidate["images"]["amd64"]["stage_digest"],
        "GAP-007 amd64 staging digest differs from candidate",
    )
    require(
        provenance.get("candidate_leaf_digest")
        == candidate["images"]["amd64"]["runtime_digest"],
        "GAP-007 amd64 leaf digest differs from candidate",
    )
    require(
        provenance.get("candidate_image_id") == binding["candidate_image_id"],
        "GAP-007 candidate image ID differs from candidate record",
    )
    require(
        provenance.get("source_rootfs_sha256")
        == binding["source_rootfs_sha256"],
        "GAP-007 source-rootfs differs from candidate record",
    )
    require(
        provenance.get("source_tree_stable") is True,
        "GAP-007 source-rootfs was not stable",
    )
    source_image = provenance.get("source_image_verification")
    require(
        isinstance(source_image, dict)
        and set(source_image)
        == {
            "schema",
            "image_id",
            "revision",
            "source_rootfs_sha256",
            "verified_files",
        },
        "GAP-007 independent source-image verification is missing",
    )
    require(
        source_image.get("schema")
        == "antigravity-ha-source-image-verification/v1"
        and source_image.get("image_id") == binding["candidate_image_id"]
        and source_image.get("revision") == candidate["source_sha"]
        and source_image.get("source_rootfs_sha256")
        == binding["source_rootfs_sha256"]
        and isinstance(source_image.get("verified_files"), int)
        and source_image["verified_files"] > 0,
        "GAP-007 source image, manifest, OCI labels, and source are not bound",
    )
    require(
        provenance.get("module_origin") == "packaged_image"
        and provenance.get("telegram_bridge_module_path") == GAP007_MODULE_PATH,
        "GAP-007 did not exercise the packaged Telegram state machine",
    )
    require(
        provenance.get("candidate_architecture") == "amd64",
        "GAP-007 candidate architecture is not amd64",
    )

    telegram = evidence.get("telegram", {})
    require(
        telegram.get("required_elapsed_seconds") == 1800
        and telegram.get("actual_elapsed_seconds", 0) >= 1800,
        "GAP-007 Telegram soak threshold was not met",
    )
    failure = evidence.get("failure_injection", {})
    require(
        failure.get("required_elapsed_seconds") == 900
        and failure.get("actual_elapsed_seconds", 0) >= 900,
        "GAP-007 outage threshold was not met",
    )
    require(
        failure.get("backoff_implementation") == "packaged_telegram_bridge"
        and failure.get("backoff_reset_after_recovery") is True
        and failure.get("external_calls") == 0,
        "GAP-007 packaged backoff or isolation evidence is invalid",
    )
    require(
        evidence.get("bounded_io", {}).get("indexed_entities") == 1000,
        "GAP-007 bounded entity fixture is incomplete",
    )
    restart = evidence.get("rapid_restart", {})
    candidate_restart = restart.get("candidate_container", {})
    require(
        restart.get("required_count") == 20
        and restart.get("completed_count") == 20
        and candidate_restart.get("required_count") == 20
        and candidate_restart.get("completed_count") == 20,
        "GAP-007 restart threshold was not met",
    )
    require(
        candidate_restart.get("pending_journal_count") == 0
        and candidate_restart.get("zombie_process_count") == 0
        and candidate_restart.get("stale_socket_count") == 0,
        "GAP-007 restart durability checks did not pass",
    )

    measured = evidence.get("resources", {}).get("candidate_budget", {})
    require(
        isinstance(measured, dict) and measured,
        "GAP-007 resource budget is missing",
    )
    require(
        measured.get("baseline_evidence_sha256")
        == GAP007_BASELINE_EVIDENCE_SHA256,
        "GAP-007 performance baseline is stale",
    )
    require(
        measured.get("limits") == GAP007_LIMITS and measured.get("result") == "PASS",
        "GAP-007 resource budget is missing or stale",
    )
    observed = measured.get("observed", {})
    for name, maximum in GAP007_LIMITS.items():
        observed_name = name.removeprefix("max_")
        value = observed.get(observed_name)
        require(
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and 0 <= value <= maximum,
            f"GAP-007 observed resource exceeds {name}",
        )
    sanitization = evidence.get("sanitization", {})
    require(
        sanitization
        == {
            "external_calls": 0,
            "contains_credentials": False,
            "contains_entity_or_chat_identifiers": False,
            "contains_raw_logs_or_prompts": False,
        },
        "GAP-007 evidence sanitization record is invalid",
    )
    return evidence


def validate_manual(candidate: dict[str, Any], manual: Any) -> dict[str, Any]:
    require(isinstance(manual, dict), "manual evidence is not an object")
    require(manual.get("schema") == "antigravity-ha-manual-evidence/v1", "wrong manual evidence schema")
    require(set(manual) == {"schema", "version", "source_sha", "candidate_manifest_digest", "gates"}, "manual evidence keys are not exact")
    require(manual["version"] == candidate["version"], "manual evidence version differs from candidate")
    require(manual["source_sha"] == candidate["source_sha"], "manual evidence source differs from candidate")
    require(
        manual["candidate_manifest_digest"] == candidate["images"]["generic"]["digest"],
        "manual evidence digest differs from exact candidate",
    )
    gates = manual.get("gates")
    require(isinstance(gates, dict) and set(gates) == EXPECTED_MANUAL_GATES, "manual gate set is not exact")
    for name, gate in gates.items():
        require(isinstance(gate, dict) and set(gate) == {"status", "evidence_uri", "sha256"}, f"invalid gate record: {name}")
        require(gate.get("status") == "PASS", f"manual gate is not PASS: {name}")
        require(
            isinstance(gate.get("evidence_uri"), str)
            and EVIDENCE_URI_RE.fullmatch(gate["evidence_uri"]),
            f"invalid or unbound evidence URI: {name}",
        )
        validate_digest(gate.get("sha256"), f"manual evidence digest: {name}")
    return manual


def command_candidate(args: argparse.Namespace) -> None:
    generic = validate_index_file(args.manifest, ("amd64", "aarch64"))
    require(generic["index_digest"] == args.generic_digest, "candidate index digest mismatch")
    require(generic["amd64"] == args.amd64_runtime_digest, "candidate amd64 leaf mismatch")
    require(generic["aarch64"] == args.aarch64_runtime_digest, "candidate arm64 leaf mismatch")
    gap007_evidence = load_json(args.gap007_evidence)
    gap007_provenance = gap007_evidence.get("provenance", {})
    candidate = {
        "schema": "antigravity-ha-release-candidate/v1",
        "version": args.version,
        "source_sha": args.source_sha,
        "run_id": validate_run_number(args.run_id, "candidate run ID"),
        "run_attempt": validate_run_number(args.run_attempt, "candidate run attempt"),
        "candidate_tag": args.candidate_tag,
        "images": {
            "generic": {"name": args.generic_image, "digest": args.generic_digest},
            "amd64": {
                "name": args.amd64_image,
                "platform": "linux/amd64",
                "stage_digest": args.amd64_stage_digest,
                "runtime_digest": args.amd64_runtime_digest,
            },
            "aarch64": {
                "name": args.aarch64_image,
                "platform": "linux/arm64",
                "stage_digest": args.aarch64_stage_digest,
                "runtime_digest": args.aarch64_runtime_digest,
            },
        },
        "automated_gates": {
            "exact_digest_smoke": "PASS",
            "gap007_performance_durability": "PASS",
            "native_arm64_full_feasible": "PASS",
            "source_quality": "PASS",
            "spdx_leaf_sbom": "PASS",
        },
        "gap007_release": {
            "schema": "antigravity-ha-gap007-binding/v1",
            "evidence_sha256": digest_file(args.gap007_evidence),
            "source_sha": args.source_sha,
            "amd64_stage_digest": args.amd64_stage_digest,
            "amd64_runtime_digest": args.amd64_runtime_digest,
            "candidate_image_id": gap007_provenance.get("candidate_image_id"),
            "source_rootfs_sha256": gap007_provenance.get(
                "source_rootfs_sha256"
            ),
        },
    }
    validate_candidate(candidate)
    validate_gap007_release(
        candidate,
        gap007_evidence,
        digest_file(args.gap007_evidence),
    )
    write_json(args.output, candidate)


def command_manual(args: argparse.Namespace) -> None:
    candidate = validate_candidate(load_json(args.candidate))
    validate_manual(candidate, load_json(args.manual))


def command_finalize(args: argparse.Namespace) -> None:
    candidate = validate_candidate(load_json(args.candidate))
    validate_gap007_release(
        candidate,
        load_json(args.gap007_evidence),
        digest_file(args.gap007_evidence),
    )
    manual = validate_manual(candidate, load_json(args.manual))
    evidence = {
        "schema": "antigravity-ha-release-evidence/v1",
        "candidate": candidate,
        "candidate_artifact_digest": validate_digest(
            args.candidate_artifact_digest, "candidate artifact digest"
        ),
        "manual_evidence": manual,
        "finalizer": {
            "actor": args.actor,
            "run_id": validate_run_number(args.run_id, "evidence run ID"),
            "run_attempt": validate_run_number(args.run_attempt, "evidence run attempt"),
        },
    }
    require(re.fullmatch(r"[A-Za-z0-9-]{1,100}", args.actor) is not None, "invalid finalizer actor")
    write_json(args.output, evidence)


def validate_release_evidence(evidence: Any) -> dict[str, Any]:
    require(isinstance(evidence, dict), "release evidence is not an object")
    require(
        set(evidence) == {"schema", "candidate", "candidate_artifact_digest", "manual_evidence", "finalizer"},
        "release evidence keys are not exact",
    )
    require(evidence.get("schema") == "antigravity-ha-release-evidence/v1", "wrong release evidence schema")
    candidate = validate_candidate(evidence.get("candidate"))
    validate_digest(evidence.get("candidate_artifact_digest"), "candidate artifact digest")
    validate_manual(candidate, evidence.get("manual_evidence"))
    finalizer = evidence.get("finalizer")
    require(isinstance(finalizer, dict) and set(finalizer) == {"actor", "run_id", "run_attempt"}, "invalid finalizer record")
    require(
        isinstance(finalizer.get("actor"), str)
        and re.fullmatch(r"[A-Za-z0-9-]{1,100}", finalizer["actor"]) is not None,
        "invalid finalizer actor",
    )
    validate_run_number(finalizer.get("run_id"), "evidence run ID")
    validate_run_number(finalizer.get("run_attempt"), "evidence run attempt")
    return evidence


def command_release(args: argparse.Namespace) -> None:
    evidence = validate_release_evidence(load_json(args.evidence))
    candidate = evidence["candidate"]
    validate_gap007_release(
        candidate,
        load_json(args.gap007_evidence),
        digest_file(args.gap007_evidence),
    )
    require(candidate["version"] == args.version, "tag version differs from evidence")
    require(candidate["source_sha"] == args.source_sha, "tag commit differs from evidence")
    require(candidate["run_id"] == validate_run_number(args.candidate_run_id, "candidate run ID"), "candidate run ID differs from tag")
    require(candidate["run_attempt"] == validate_run_number(args.candidate_run_attempt, "candidate run attempt"), "candidate run attempt differs from tag")
    finalizer = evidence["finalizer"]
    require(finalizer["run_id"] == validate_run_number(args.evidence_run_id, "evidence run ID"), "evidence run ID differs from tag")
    require(finalizer["run_attempt"] == validate_run_number(args.evidence_run_attempt, "evidence run attempt"), "evidence run attempt differs from tag")
    images = candidate["images"]
    values = {
        "image": images["generic"]["name"],
        "generic_digest": images["generic"]["digest"],
        "candidate_tag": candidate["candidate_tag"],
        "amd64_image": images["amd64"]["name"],
        "amd64_stage_digest": images["amd64"]["stage_digest"],
        "amd64_digest": images["amd64"]["runtime_digest"],
        "arm64_image": images["aarch64"]["name"],
        "arm64_stage_digest": images["aarch64"]["stage_digest"],
        "arm64_digest": images["aarch64"]["runtime_digest"],
    }
    emit_github_output(args.github_output, values)
    print(json.dumps(values, sort_keys=True))


def command_notes(args: argparse.Namespace) -> None:
    evidence = validate_release_evidence(load_json(args.evidence))
    candidate = evidence["candidate"]
    validate_gap007_release(
        candidate,
        load_json(args.gap007_evidence),
        digest_file(args.gap007_evidence),
    )
    images = candidate["images"]
    notes = f"""# Antigravity for Home Assistant {candidate['version']}

This is the fail-closed v2 prerelease built from `{candidate['source_sha']}`.

## Immutable images

- Generic OCI index: `{images['generic']['name']}@{images['generic']['digest']}`
- linux/amd64 leaf: `{images['amd64']['runtime_digest']}`
- linux/arm64 leaf: `{images['aarch64']['runtime_digest']}`

## Breaking upgrade

Read the App documentation before updating. v2 replaces the Telegram execution path,
uses native Antigravity settings/plugins, and applies conservative migration modes.
Back up the App data first; rollback can require restoring the matching migration backup.

The attached release evidence binds the exact candidate, both leaf SPDX documents,
the fixed-duration GAP-007 amd64 performance/durability gate, native arm64 automated
smoke, and the required sanitized HAOS rehearsals. Post-publish anonymous install/update
verification remains a separate release acceptance gate.
"""
    args.output.write_text(notes, encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)

    index = commands.add_parser("index")
    index.add_argument("--manifest", type=Path, required=True)
    index.add_argument("--expected-arch", action="append", required=True, choices=sorted(EXPECTED_PLATFORMS))
    index.add_argument("--expected-digest")
    index.add_argument("--github-output", type=Path)
    index.set_defaults(handler=command_index)

    candidate = commands.add_parser("candidate")
    for name in ("version", "source-sha", "run-id", "run-attempt", "candidate-tag", "generic-image", "generic-digest", "amd64-image", "amd64-stage-digest", "amd64-runtime-digest", "aarch64-image", "aarch64-stage-digest", "aarch64-runtime-digest"):
        candidate.add_argument(f"--{name}", required=True)
    candidate.add_argument("--manifest", type=Path, required=True)
    candidate.add_argument("--gap007-evidence", type=Path, required=True)
    candidate.add_argument("--output", type=Path, required=True)
    candidate.set_defaults(handler=command_candidate)

    manual = commands.add_parser("manual")
    manual.add_argument("--candidate", type=Path, required=True)
    manual.add_argument("--manual", type=Path, required=True)
    manual.set_defaults(handler=command_manual)

    finalize = commands.add_parser("finalize")
    finalize.add_argument("--candidate", type=Path, required=True)
    finalize.add_argument("--manual", type=Path, required=True)
    finalize.add_argument("--candidate-artifact-digest", required=True)
    finalize.add_argument("--gap007-evidence", type=Path, required=True)
    finalize.add_argument("--actor", required=True)
    finalize.add_argument("--run-id", required=True)
    finalize.add_argument("--run-attempt", required=True)
    finalize.add_argument("--output", type=Path, required=True)
    finalize.set_defaults(handler=command_finalize)

    release = commands.add_parser("release")
    release.add_argument("--evidence", type=Path, required=True)
    release.add_argument("--gap007-evidence", type=Path, required=True)
    for name in ("version", "source-sha", "candidate-run-id", "candidate-run-attempt", "evidence-run-id", "evidence-run-attempt"):
        release.add_argument(f"--{name}", required=True)
    release.add_argument("--github-output", type=Path)
    release.set_defaults(handler=command_release)

    notes = commands.add_parser("notes")
    notes.add_argument("--evidence", type=Path, required=True)
    notes.add_argument("--gap007-evidence", type=Path, required=True)
    notes.add_argument("--output", type=Path, required=True)
    notes.set_defaults(handler=command_notes)
    return parser


def main() -> int:
    try:
        args = build_parser().parse_args()
        args.handler(args)
    except (ContractError, OSError, UnicodeError, json.JSONDecodeError) as error:
        print(f"release contract failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
