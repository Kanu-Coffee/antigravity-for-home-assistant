#!/usr/bin/env python3
"""Fail-closed release evidence and OCI descriptor validation."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import shutil
import stat
import sys
import zipfile
from datetime import datetime, timedelta, timezone
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
    "haos_aarch64_install_persistence",
    "haos_amd64_local_migration",
    "local_migration_rollback",
    "migration_modes",
    "oauth_isolation_persistence",
    "native_updater_canary",
    "telegram_modes",
}
HAOS_GATE_REPORT_SCHEMA = "antigravity-ha-haos-gate-evidence/v1"
HAOS_GATE_REPORT_KEYS = {
    "schema",
    "gate",
    "status",
    "version",
    "source_sha",
    "candidate_manifest_digest",
    "candidate_images",
    "haos_rehearsal",
    "test_ids",
    "checks",
    "environment",
    "previous_release",
    "observed_at_utc",
    "sanitization",
    "attestation",
}
HAOS_GATE_ENVIRONMENT_KEYS = {
    "platform",
    "architectures",
    "haos_version",
    "supervisor_version",
    "core_version",
    "app_version",
    "apparmor_mode",
}
HAOS_LOCAL_V1_GATES = {
    "haos_amd64_local_migration",
    "local_migration_rollback",
    "migration_modes",
}
EXPECTED_HAOS_GATE_TEST_IDS = {
    "apparmor_enforce": ["AA-001"],
    "haos_aarch64_install_persistence": ["HA-001", "HA-002", "HA-003", "HA-006"],
    "haos_amd64_local_migration": ["HA-001", "HA-002", "HA-003", "HA-007"],
    "local_migration_rollback": ["HA-007"],
    "migration_modes": ["HA-007"],
    "oauth_isolation_persistence": ["HA-001", "HA-004", "HA-006", "AA-001"],
    "native_updater_canary": ["HA-001", "HA-006"],
    "telegram_modes": ["HA-004"],
}
EXPECTED_HAOS_GATE_ARCHITECTURES = {
    "apparmor_enforce": ["amd64", "aarch64"],
    "haos_aarch64_install_persistence": ["aarch64"],
    "haos_amd64_local_migration": ["amd64"],
    "local_migration_rollback": ["amd64"],
    "migration_modes": ["amd64"],
    "oauth_isolation_persistence": ["amd64", "aarch64"],
    "native_updater_canary": ["amd64", "aarch64"],
    "telegram_modes": ["amd64", "aarch64"],
}
EXPECTED_HAOS_GATE_CHECKS = {
    "apparmor_enforce": {
        "all_named_profiles_enforced",
        "expected_denials_only",
        "interactive_positive_paths",
        "other_pid_proc_denied",
        "restricted_sensitive_reads_denied",
        "sensitive_read_only_writes_denied",
        "ssh_sftp_ttyd_positive",
        "telegram_browser_memory_broker_isolated",
    },
    "haos_aarch64_install_persistence": {
        "clean_install_start_restart",
        "config_memory_browser_read_tools",
        "fresh_v2_candidate_install",
        "ingress_desktop_mobile",
        "native_plugin_and_cli",
        "profile_enforce",
        "ssh_public_key_and_host_key_persistence",
        "restart_preserves_user_state",
    },
    "haos_amd64_local_migration": {
        "clean_v1_source_build_start_restart",
        "config_memory_browser_read_tools",
        "exact_public_v1_source_sha",
        "ingress_desktop_mobile",
        "native_plugin_and_cli",
        "native_updater_disabled_after_migration",
        "oauth_browser_memory_persist_after_update",
        "profile_enforce",
        "public_v1_source_build_installed",
        "same_local_repository_candidate_update",
        "same_local_repository_identity",
        "ssh_public_key_and_host_key_persistence",
        "update_preserves_user_state",
    },
    "local_migration_rollback": {
        "exact_public_v1_source_sha",
        "managed_state_restored",
        "previous_local_source_image_selected",
        "rollback_postconditions",
        "same_local_repository_identity",
        "user_data_preserved",
    },
    "migration_modes": {
        "crash_recovery",
        "exact_public_v1_source_sha",
        "legacy_options_conservative",
        "preserve",
        "refresh_managed_one_shot",
        "reset_v2_conflict_fail_closed",
        "same_local_repository_identity",
        "user_data_preserved",
    },
    "oauth_isolation_persistence": {
        "credential_non_disclosure",
        "interactive_login",
        "interactive_restart_persistence",
        "same_process_residual_risk_recorded",
        "telegram_separate_identity_login",
        "telegram_reply_log_network_non_disclosure",
        "telegram_restart_persistence",
        "restart_persistence_both_arches",
        "user_global_mcp_absent_before_and_after_auth",
    },
    "native_updater_canary": {
        "auto_update_process_absent",
        "binary_digest_stable_after_restart",
        "cli_version_1_1_11",
        "disable_environment_all_launchers",
    },
    "telegram_modes": {
        "amd64_and_aarch64_sessions",
        "autonomous_low_risk_only",
        "bot_api_interruption_no_duplicate_mutation",
        "cancel_expiry_and_restart",
        "confirm_changes_high_risk_confirmation",
        "pairing_and_static_allowlist",
        "replay_and_cross_user_denied",
        "safe_device_test_restored",
        "telegram_home_customization_isolated",
        "oauth_canary_not_disclosed",
    },
}
HAOS_EVIDENCE_MAX_BYTES = 1_048_576
PUBLIC_V1_SOURCE_SHA = "aba6805e8bf1f32e68976a67a46536c3ca362af8"
PUBLIC_REPOSITORY_URL = (
    "https://github.com/Kanu-Coffee/antigravity-for-home-assistant"
)
PUBLIC_APP_SLUG = "antigravity_home_assistant"
PUBLIC_GENERIC_IMAGE = "ghcr.io/kanu-coffee/antigravity-for-home-assistant"
HA005_REPORT_SCHEMA = "antigravity-ha-ha005-acceptance/v1"
HA005_MAX_BYTES = 1_048_576
EXPECTED_HA005_CHECKS = {
    "data_identity_preserved",
    "matching_managed_backup_restored",
    "native_updater_absent_and_binary_stable",
    "oauth_ssh_browser_memory_config_and_settings_preserved",
    "original_custom_repository_public_v1_installed",
    "public_v1_source_and_local_image_verified",
    "published_amd64_runtime_digest_verified",
    "published_generic_digest_verified",
    "published_v2_preserve_update",
    "refresh_managed_one_shot",
    "reset_v2_conflict_and_restart_idempotency",
    "rollback_prior_local_image_selected",
    "rollback_repository_addon_data_and_recovery_verified",
    "same_repository_and_addon_identity",
}
PUBLIC_INSTALL_REPORT_SCHEMA = "antigravity-ha-public-install-acceptance/v1"
PUBLIC_INSTALL_MAX_BYTES = 60_000
EXPECTED_PUBLIC_INSTALL_CHECKS = {
    "app_absent_before_install",
    "apparmor_enforce",
    "app_start_stop_restart",
    "data_identity_persisted_after_restart",
    "fresh_install_from_original_public_repository",
    "local_candidate_repository_absent",
    "numeric_version_visible_in_repository_metadata",
    "original_public_repository_added",
    "prebuilt_image_used_without_source_build",
    "published_generic_digest_verified",
    "published_runtime_digest_verified",
    "supervisor_healthy_after_restart",
}
VERSION_STRING_RE = re.compile(r"[0-9]+(?:\.[0-9]+){0,2}\Z")
UTC_TIMESTAMP_RE = re.compile(
    r"[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
    r"T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z\Z"
)
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
            "haos_rehearsal",
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
    rehearsal = candidate.get("haos_rehearsal")
    require(
        isinstance(rehearsal, dict)
        and set(rehearsal)
        == {
            "version",
            "image",
            "digest",
            "repository_manifest_sha256",
            "repository_archive_sha256",
        },
        "HAOS rehearsal binding is incomplete",
    )
    require(
        rehearsal.get("version")
        == f"{candidate['version']}-candidate.{run_id}.{run_attempt}",
        "HAOS rehearsal version differs from candidate run",
    )
    require(rehearsal.get("image") == generic["name"], "HAOS rehearsal image differs")
    require(rehearsal.get("digest") == generic["digest"], "HAOS rehearsal digest differs")
    validate_digest(
        rehearsal.get("repository_manifest_sha256"),
        "HAOS rehearsal repository manifest digest",
    )
    validate_digest(
        rehearsal.get("repository_archive_sha256"),
        "HAOS rehearsal repository archive digest",
    )
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
    evidence_bindings: set[tuple[str, str]] = set()
    evidence_digests: set[str] = set()
    for name, gate in gates.items():
        require(
            isinstance(gate, dict)
            and set(gate) == {"status", "evidence_uri", "sha256", "format"},
            f"invalid gate record: {name}",
        )
        require(gate.get("status") == "PASS", f"manual gate is not PASS: {name}")
        require(
            isinstance(gate.get("evidence_uri"), str)
            and EVIDENCE_URI_RE.fullmatch(gate["evidence_uri"]),
            f"invalid or unbound evidence URI: {name}",
        )
        validate_digest(gate.get("sha256"), f"manual evidence digest: {name}")
        require(
            gate.get("format") in {"github_actions_zip", "json"},
            f"invalid manual evidence format: {name}",
        )
        is_actions_zip = gate["evidence_uri"].startswith("https://api.github.com/")
        require(
            (is_actions_zip and gate["format"] == "github_actions_zip")
            or (
                not is_actions_zip
                and gate["format"] == "json"
                and gate["evidence_uri"].endswith(".json")
            ),
            f"manual evidence URI/format mismatch: {name}",
        )
        binding = (gate["evidence_uri"], gate["sha256"])
        require(binding not in evidence_bindings, "manual evidence archive is reused across gates")
        require(gate["sha256"] not in evidence_digests, "manual evidence digest is reused across gates")
        evidence_bindings.add(binding)
        evidence_digests.add(gate["sha256"])
    return manual


def strict_json_object(raw: bytes, name: str) -> Any:
    require(not raw.startswith(b"\xef\xbb\xbf"), f"{name} must not contain a UTF-8 BOM")

    def reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            require(key not in result, f"duplicate JSON key in {name}: {key}")
            result[key] = value
        return result

    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=reject_duplicate_pairs)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ContractError(f"{name} is not valid UTF-8 JSON: {error}") from error


def load_haos_gate_report(path: Path, gate: str, evidence_format: str) -> Any:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise ContractError(f"cannot read downloaded HAOS evidence: {error}") from error
    require(len(raw) <= 67_108_864, "downloaded HAOS evidence exceeds 64 MiB")
    if evidence_format == "json":
        require(not zipfile.is_zipfile(io.BytesIO(raw)), "JSON evidence must not be a ZIP archive")
        require(len(raw) <= HAOS_EVIDENCE_MAX_BYTES, "HAOS gate JSON exceeds 1 MiB")
        return strict_json_object(raw, "HAOS gate evidence")

    require(evidence_format == "github_actions_zip", "unknown HAOS evidence format")
    require(zipfile.is_zipfile(io.BytesIO(raw)), "GitHub Actions evidence must be a ZIP archive")
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            members = archive.infolist()
            names = [member.filename for member in members]
            require(len(names) == len(set(names)), "HAOS evidence archive has duplicate members")
            require(names == ["manual-gate-evidence.json"], "HAOS evidence archive member set is not exact")
            for member in members:
                require(not member.is_dir(), "HAOS evidence archive contains a directory")
                require(member.flag_bits & 0x1 == 0, "encrypted HAOS evidence is forbidden")
                require(
                    member.compress_type in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED},
                    "unsupported HAOS evidence compression",
                )
                require(
                    member.file_size <= HAOS_EVIDENCE_MAX_BYTES,
                    "HAOS evidence archive member exceeds 1 MiB",
                )
                unix_mode = member.external_attr >> 16
                require(
                    not unix_mode or stat.S_IFMT(unix_mode) in {0, stat.S_IFREG},
                    "HAOS evidence archive member is not a regular file",
                )
                require(
                    member.compress_size == 0
                    or member.file_size <= member.compress_size * 100,
                    "HAOS evidence archive compression ratio exceeds 100",
                )
            payload = archive.read("manual-gate-evidence.json")
    except (OSError, zipfile.BadZipFile, NotImplementedError, RuntimeError) as error:
        raise ContractError(f"cannot read HAOS evidence archive: {error}") from error
    return strict_json_object(payload, "HAOS gate report")


def validate_haos_gate_report(
    candidate: dict[str, Any],
    gate: str,
    report: Any,
) -> dict[str, Any]:
    require(gate in EXPECTED_MANUAL_GATES, "unknown HAOS evidence gate")
    require(isinstance(report, dict), "HAOS gate report is not an object")
    require(
        set(report) == HAOS_GATE_REPORT_KEYS,
        "HAOS gate report keys are not exact",
    )
    require(
        report.get("schema") == HAOS_GATE_REPORT_SCHEMA,
        "wrong HAOS gate report schema",
    )
    require(report.get("gate") == gate, "HAOS report gate binding differs")
    require(report.get("status") == "PASS", "HAOS report did not pass")
    require(report.get("version") == candidate["version"], "HAOS report version differs")
    require(report.get("source_sha") == candidate["source_sha"], "HAOS report source differs")
    require(
        report.get("candidate_manifest_digest")
        == candidate["images"]["generic"]["digest"],
        "HAOS report candidate manifest differs",
    )
    require(
        report.get("candidate_images")
        == {
            "generic_manifest_digest": candidate["images"]["generic"]["digest"],
            "amd64_stage_digest": candidate["images"]["amd64"]["stage_digest"],
            "amd64_runtime_digest": candidate["images"]["amd64"]["runtime_digest"],
            "aarch64_stage_digest": candidate["images"]["aarch64"]["stage_digest"],
            "aarch64_runtime_digest": candidate["images"]["aarch64"]["runtime_digest"],
        },
        "HAOS report image binding differs",
    )
    require(
        report.get("haos_rehearsal") == candidate["haos_rehearsal"],
        "HAOS report rehearsal repository binding differs",
    )
    require(
        report.get("test_ids") == EXPECTED_HAOS_GATE_TEST_IDS[gate],
        "HAOS report test ID set is not exact",
    )
    checks = report.get("checks")
    require(
        isinstance(checks, dict)
        and set(checks) == EXPECTED_HAOS_GATE_CHECKS[gate]
        and set(checks.values()) == {"PASS"},
        "HAOS report required checks are incomplete",
    )
    environment = report.get("environment")
    require(
        isinstance(environment, dict) and set(environment) == HAOS_GATE_ENVIRONMENT_KEYS,
        "HAOS report environment is not exact",
    )
    require(environment.get("platform") == "HAOS", "HAOS report platform is not HAOS")
    require(
        environment.get("architectures") == EXPECTED_HAOS_GATE_ARCHITECTURES[gate],
        "HAOS report architecture coverage is incomplete",
    )
    for version_name in ("haos_version", "supervisor_version", "core_version"):
        version_value = environment.get(version_name)
        require(
            isinstance(version_value, str)
            and len(version_value) <= 32
            and VERSION_STRING_RE.fullmatch(version_value),
            f"HAOS report {version_name} is invalid",
        )
    expected_app_version = expected_haos_app_version(candidate, gate)
    require(
        environment.get("app_version") == expected_app_version,
        "HAOS report installed App version differs from gate postcondition",
    )
    require(environment.get("apparmor_mode") == "enforce", "HAOS report AppArmor is not enforce")
    previous_release = report.get("previous_release")
    requires_local_v1 = gate in HAOS_LOCAL_V1_GATES
    if requires_local_v1:
        require(
            isinstance(previous_release, dict)
            and set(previous_release)
            == {
                "version",
                "source_sha",
                "image_id",
                "installation_source",
                "repository_identity",
                "image_digest_verified",
            },
            "HAOS report previous release binding is incomplete",
        )
        require(previous_release.get("version") == "1.0.4", "HAOS report previous version differs")
        require(
            previous_release.get("source_sha") == PUBLIC_V1_SOURCE_SHA,
            "HAOS report previous source differs",
        )
        validate_digest(previous_release.get("image_id"), "HAOS report previous local image ID")
        require(
            previous_release.get("installation_source") == "local_addons_source_build",
            "HAOS report previous installation source differs",
        )
        require(
            previous_release.get("repository_identity")
            == "same_local_repository_identity",
            "HAOS report local repository identity differs",
        )
        require(
            previous_release.get("image_digest_verified") is True,
            "HAOS report previous image digest was not verified",
        )
    else:
        require(previous_release is None, "unexpected previous release binding")
    require(
        isinstance(report.get("observed_at_utc"), str)
        and UTC_TIMESTAMP_RE.fullmatch(report["observed_at_utc"]),
        "HAOS report timestamp is invalid",
    )
    try:
        observed_at = datetime.strptime(
            report["observed_at_utc"], "%Y-%m-%dT%H:%M:%SZ"
        ).replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise ContractError("HAOS report timestamp is invalid") from error
    now = datetime.now(timezone.utc)
    require(observed_at <= now + timedelta(minutes=5), "HAOS report timestamp is in the future")
    require(observed_at >= now - timedelta(days=30), "HAOS report is older than 30 days")
    require(
        report.get("sanitization")
        == {
            "contains_credentials": False,
            "contains_entity_or_chat_identifiers": False,
            "contains_raw_logs_or_prompts": False,
        },
        "HAOS report sanitization contract failed",
    )
    require(
        report.get("attestation")
        == {
            "candidate_digest_verified": True,
            "real_haos_device": True,
            "sanitized_by_maintainer": True,
            "scope_reviewed": True,
        },
        "HAOS report trusted-attestor declaration is incomplete",
    )
    return report


def command_manual_report(args: argparse.Namespace) -> None:
    candidate = validate_candidate(load_json(args.candidate))
    manual = validate_manual(candidate, load_json(args.manual))
    gate = args.gate
    require(gate in manual["gates"], "downloaded report gate is absent from manual evidence")
    require(
        digest_file(args.evidence) == manual["gates"][gate]["sha256"],
        "downloaded HAOS evidence digest differs from manual record",
    )
    report = load_haos_gate_report(
        args.evidence,
        gate,
        manual["gates"][gate]["format"],
    )
    validate_haos_gate_report(
        candidate,
        gate,
        report,
    )
    if args.output:
        write_json(args.output, report)


def command_haos_report(args: argparse.Namespace) -> None:
    candidate = validate_candidate(load_json(args.candidate))
    report = load_haos_gate_report(args.evidence, args.gate, "json")
    validate_haos_gate_report(candidate, args.gate, report)
    if args.output:
        write_json(args.output, report)


def expected_haos_app_version(candidate: dict[str, Any], gate: str) -> str:
    require(gate in EXPECTED_MANUAL_GATES, "unknown HAOS evidence gate")
    return (
        "1.0.4"
        if gate == "local_migration_rollback"
        else candidate["haos_rehearsal"]["version"]
    )


def build_haos_report_template(
    candidate: dict[str, Any], gate: str
) -> dict[str, Any]:
    require(gate in EXPECTED_MANUAL_GATES, "unknown HAOS evidence gate")
    images = candidate["images"]
    previous_release: dict[str, Any] | None = None
    if gate in HAOS_LOCAL_V1_GATES:
        previous_release = {
            "version": "1.0.4",
            "source_sha": PUBLIC_V1_SOURCE_SHA,
            "image_id": "",
            "installation_source": "local_addons_source_build",
            "repository_identity": "same_local_repository_identity",
            "image_digest_verified": False,
        }
    return {
        "schema": HAOS_GATE_REPORT_SCHEMA,
        "gate": gate,
        "status": "NOT_RUN",
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
        "test_ids": EXPECTED_HAOS_GATE_TEST_IDS[gate],
        "checks": {
            name: "NOT_RUN" for name in sorted(EXPECTED_HAOS_GATE_CHECKS[gate])
        },
        "environment": {
            "platform": "HAOS",
            "architectures": EXPECTED_HAOS_GATE_ARCHITECTURES[gate],
            "haos_version": "",
            "supervisor_version": "",
            "core_version": "",
            "app_version": "",
            "apparmor_mode": "",
        },
        "previous_release": previous_release,
        "observed_at_utc": "",
        "sanitization": {
            "contains_credentials": True,
            "contains_entity_or_chat_identifiers": True,
            "contains_raw_logs_or_prompts": True,
        },
        "attestation": {
            "candidate_digest_verified": False,
            "real_haos_device": False,
            "sanitized_by_maintainer": False,
            "scope_reviewed": False,
        },
    }


def command_haos_report_templates(args: argparse.Namespace) -> None:
    candidate = validate_candidate(load_json(args.candidate))
    output_directory = args.output_dir
    require(
        not output_directory.exists() and not output_directory.is_symlink(),
        "HAOS template output directory already exists or is a symlink",
    )
    parent = output_directory.parent
    require(
        parent.is_dir() and not parent.is_symlink(),
        "HAOS template output parent is unsafe",
    )
    output_directory.mkdir(mode=0o700)
    try:
        for gate in sorted(EXPECTED_MANUAL_GATES):
            path = output_directory / f"{gate}.json"
            payload = json.dumps(
                build_haos_report_template(candidate, gate),
                indent=2,
                sort_keys=True,
                ensure_ascii=False,
            ) + "\n"
            with path.open("x", encoding="utf-8") as stream:
                stream.write(payload)
        require(
            {path.name for path in output_directory.iterdir()}
            == {f"{gate}.json" for gate in EXPECTED_MANUAL_GATES},
            "generated HAOS template file set is not exact",
        )
    except BaseException:
        shutil.rmtree(output_directory)
        raise


def parse_utc_timestamp(value: Any, name: str) -> datetime:
    require(
        isinstance(value, str) and UTC_TIMESTAMP_RE.fullmatch(value),
        f"{name} is invalid",
    )
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc
        )
    except ValueError as error:
        raise ContractError(f"{name} is invalid") from error


def load_ha005_report(path: Path) -> Any:
    try:
        metadata = path.lstat()
        raw = path.read_bytes()
    except OSError as error:
        raise ContractError(f"cannot read HA-005 report: {error}") from error
    require(
        stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1,
        "HA-005 report path is not a single regular file",
    )
    require(len(raw) <= HA005_MAX_BYTES, "HA-005 report exceeds 1 MiB")
    return strict_json_object(raw, "HA-005 report")


def validate_ha005_report(
    release_evidence: Any,
    report: Any,
    *,
    version: str,
    source_sha: str,
    generic_digest: str,
    amd64_runtime_digest: str,
    published_at_utc: str,
) -> dict[str, Any]:
    evidence = validate_release_evidence(release_evidence)
    candidate = evidence["candidate"]
    expected_version = validate_version(version)
    require(expected_version.split(".", 1)[0] == "2", "HA-005 requires a numeric v2 release")
    expected_source_sha = validate_source_sha(source_sha, "HA-005 release source SHA")
    expected_generic_digest = validate_digest(
        generic_digest, "HA-005 public generic digest"
    )
    expected_amd64_digest = validate_digest(
        amd64_runtime_digest, "HA-005 public amd64 runtime digest"
    )
    published_at = parse_utc_timestamp(
        published_at_utc, "HA-005 GitHub Release published timestamp"
    )
    now = datetime.now(timezone.utc)
    require(
        published_at <= now + timedelta(minutes=5),
        "HA-005 GitHub Release published timestamp is in the future",
    )
    require(candidate["version"] == expected_version, "HA-005 release version differs from evidence")
    require(candidate["source_sha"] == expected_source_sha, "HA-005 release source differs from evidence")
    require(
        candidate["images"]["generic"]
        == {"name": PUBLIC_GENERIC_IMAGE, "digest": expected_generic_digest},
        "HA-005 generic image differs from release evidence",
    )
    require(
        candidate["images"]["amd64"]["runtime_digest"]
        == expected_amd64_digest,
        "HA-005 amd64 runtime digest differs from release evidence",
    )

    require(isinstance(report, dict), "HA-005 report is not an object")
    require(
        set(report)
        == {
            "schema",
            "test_id",
            "status",
            "release",
            "previous_release",
            "transitions",
            "checks",
            "environment",
            "observed_at_utc",
            "sanitization",
            "attestation",
        },
        "HA-005 report keys are not exact",
    )
    require(report.get("schema") == HA005_REPORT_SCHEMA, "wrong HA-005 report schema")
    require(report.get("test_id") == "HA-005", "wrong HA-005 test ID")
    require(report.get("status") == "PASS", "HA-005 report did not pass")
    require(
        report.get("release")
        == {
            "version": expected_version,
            "source_sha": expected_source_sha,
            "published_at_utc": published_at_utc,
            "generic_image": PUBLIC_GENERIC_IMAGE,
            "generic_digest": expected_generic_digest,
            "amd64_runtime_digest": expected_amd64_digest,
        },
        "HA-005 report release binding differs",
    )

    previous = report.get("previous_release")
    require(
        isinstance(previous, dict)
        and set(previous)
        == {
            "version",
            "source_sha",
            "repository_url",
            "addon_slug",
            "installation_source",
            "repository_id_sha256",
            "local_image_id",
            "data_identity_sha256",
        },
        "HA-005 previous release binding is incomplete",
    )
    require(previous.get("version") == "1.0.4", "HA-005 previous version differs")
    require(
        previous.get("source_sha") == PUBLIC_V1_SOURCE_SHA,
        "HA-005 previous source differs",
    )
    require(
        previous.get("repository_url") == PUBLIC_REPOSITORY_URL,
        "HA-005 repository URL is not the original custom repository",
    )
    require(previous.get("addon_slug") == PUBLIC_APP_SLUG, "HA-005 App slug differs")
    require(
        previous.get("installation_source")
        == "original_custom_repository_source_build",
        "HA-005 previous installation source is not public source-build",
    )
    previous_identity_digests = {
        validate_digest(
            previous.get("repository_id_sha256"), "HA-005 repository identity digest"
        ),
        validate_digest(previous.get("local_image_id"), "HA-005 previous local image ID"),
        validate_digest(
            previous.get("data_identity_sha256"), "HA-005 data identity digest"
        ),
    }
    require(
        len(previous_identity_digests) == 3,
        "HA-005 prior identity digests must be distinct",
    )

    transitions = report.get("transitions")
    require(
        isinstance(transitions, dict) and set(transitions) == {"update", "rollback"},
        "HA-005 transition set is not exact",
    )
    require(
        transitions.get("update")
        == {
            "status": "PASS",
            "from_version": "1.0.4",
            "to_version": expected_version,
            "repository_id_sha256": previous["repository_id_sha256"],
            "addon_slug": PUBLIC_APP_SLUG,
            "data_identity_sha256": previous["data_identity_sha256"],
            "observed_generic_digest": expected_generic_digest,
            "observed_amd64_runtime_digest": expected_amd64_digest,
        },
        "HA-005 public update transition binding differs",
    )
    require(
        transitions.get("rollback")
        == {
            "status": "PASS",
            "from_version": expected_version,
            "to_version": "1.0.4",
            "repository_id_sha256": previous["repository_id_sha256"],
            "addon_slug": PUBLIC_APP_SLUG,
            "data_identity_sha256": previous["data_identity_sha256"],
            "source_sha": PUBLIC_V1_SOURCE_SHA,
            "selected_local_image_id": previous["local_image_id"],
            "matching_managed_backup_restored": True,
        },
        "HA-005 rollback transition binding differs",
    )
    require(
        transitions["rollback"]["matching_managed_backup_restored"] is True,
        "HA-005 rollback managed-backup attestation is not boolean true",
    )

    checks = report.get("checks")
    require(
        isinstance(checks, dict)
        and set(checks) == EXPECTED_HA005_CHECKS
        and set(checks.values()) == {"PASS"},
        "HA-005 required checks are incomplete",
    )
    environment = report.get("environment")
    require(
        isinstance(environment, dict)
        and set(environment)
        == {
            "platform",
            "architecture",
            "haos_version",
            "supervisor_version",
            "core_version",
            "final_app_version",
        },
        "HA-005 environment is not exact",
    )
    require(environment.get("platform") == "HAOS", "HA-005 platform is not HAOS")
    require(environment.get("architecture") == "amd64", "HA-005 architecture is not amd64")
    for version_name in ("haos_version", "supervisor_version", "core_version"):
        version_value = environment.get(version_name)
        require(
            isinstance(version_value, str)
            and len(version_value) <= 32
            and VERSION_STRING_RE.fullmatch(version_value),
            f"HA-005 {version_name} is invalid",
        )
    require(
        environment.get("final_app_version") == "1.0.4",
        "HA-005 final App version does not prove rollback",
    )

    observed_at = parse_utc_timestamp(
        report.get("observed_at_utc"), "HA-005 observation timestamp"
    )
    require(
        observed_at >= published_at,
        "HA-005 observation predates the GitHub Release",
    )
    require(observed_at <= now + timedelta(minutes=5), "HA-005 report timestamp is in the future")
    require(observed_at >= now - timedelta(days=30), "HA-005 report is older than 30 days")
    sanitization = report.get("sanitization")
    require(
        sanitization
        == {
            "contains_credentials": False,
            "contains_entity_or_chat_identifiers": False,
            "contains_raw_logs_or_prompts": False,
            "contains_private_host_or_user_identifiers": False,
        },
        "HA-005 report sanitization contract failed",
    )
    require(
        all(value is False for value in sanitization.values()),
        "HA-005 report sanitization flags are not boolean false",
    )
    attestation = report.get("attestation")
    require(
        attestation
        == {
            "real_haos_device": True,
            "original_public_repository_verified": True,
            "public_release_observed_after_publish": True,
            "sanitized_by_maintainer": True,
            "scope_reviewed": True,
        },
        "HA-005 trusted-attestor declaration is incomplete",
    )
    require(
        all(value is True for value in attestation.values()),
        "HA-005 trusted-attestor flags are not boolean true",
    )
    return report


def command_ha005_report(args: argparse.Namespace) -> None:
    release_evidence = load_json(args.release_evidence)
    report = load_ha005_report(args.report)
    validate_ha005_report(
        release_evidence,
        report,
        version=args.version,
        source_sha=args.source_sha,
        generic_digest=args.generic_digest,
        amd64_runtime_digest=args.amd64_runtime_digest,
        published_at_utc=args.published_at_utc,
    )
    write_json(args.output, report)


def load_public_install_report(path: Path) -> Any:
    try:
        metadata = path.lstat()
        raw = path.read_bytes()
    except OSError as error:
        raise ContractError(f"cannot read public-install report: {error}") from error
    require(
        stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1,
        "public-install report path is not a single regular file",
    )
    require(
        len(raw) <= PUBLIC_INSTALL_MAX_BYTES,
        "public-install report exceeds 60000 bytes",
    )
    return strict_json_object(raw, "public-install report")


def validate_public_install_report(
    release_evidence: Any,
    report: Any,
    *,
    version: str,
    source_sha: str,
    generic_digest: str,
    amd64_runtime_digest: str,
    aarch64_runtime_digest: str,
    published_at_utc: str,
) -> dict[str, Any]:
    evidence = validate_release_evidence(release_evidence)
    candidate = evidence["candidate"]
    expected_version = validate_version(version)
    require(
        expected_version.split(".", 1)[0] == "2",
        "public-install acceptance requires a numeric v2 release",
    )
    expected_source_sha = validate_source_sha(
        source_sha, "public-install release source SHA"
    )
    expected_generic_digest = validate_digest(
        generic_digest, "public-install public generic digest"
    )
    expected_runtime_digests = {
        "amd64": validate_digest(
            amd64_runtime_digest, "public-install public amd64 runtime digest"
        ),
        "aarch64": validate_digest(
            aarch64_runtime_digest,
            "public-install public aarch64 runtime digest",
        ),
    }
    published_at = parse_utc_timestamp(
        published_at_utc,
        "public-install GitHub Release published timestamp",
    )
    now = datetime.now(timezone.utc)
    require(
        published_at <= now + timedelta(minutes=5),
        "public-install GitHub Release published timestamp is in the future",
    )
    require(
        candidate["version"] == expected_version,
        "public-install release version differs from evidence",
    )
    require(
        candidate["source_sha"] == expected_source_sha,
        "public-install release source differs from evidence",
    )
    require(
        candidate["images"]["generic"]
        == {"name": PUBLIC_GENERIC_IMAGE, "digest": expected_generic_digest},
        "public-install generic image differs from release evidence",
    )
    for architecture, expected_digest in expected_runtime_digests.items():
        require(
            candidate["images"][architecture]["runtime_digest"]
            == expected_digest,
            f"public-install {architecture} runtime digest differs from release evidence",
        )

    require(isinstance(report, dict), "public-install report is not an object")
    require(
        set(report)
        == {
            "schema",
            "test_id",
            "status",
            "release",
            "installations",
            "sanitization",
            "attestation",
        },
        "public-install report keys are not exact",
    )
    require(
        report.get("schema") == PUBLIC_INSTALL_REPORT_SCHEMA,
        "wrong public-install report schema",
    )
    require(report.get("test_id") == "HA-008", "wrong public-install test ID")
    require(report.get("status") == "PASS", "public-install report did not pass")
    require(
        report.get("release")
        == {
            "version": expected_version,
            "source_sha": expected_source_sha,
            "published_at_utc": published_at_utc,
            "repository_url": PUBLIC_REPOSITORY_URL,
            "addon_slug": PUBLIC_APP_SLUG,
            "generic_image": PUBLIC_GENERIC_IMAGE,
            "generic_digest": expected_generic_digest,
            "runtime_digests": expected_runtime_digests,
        },
        "public-install report release binding differs",
    )

    installations = report.get("installations")
    require(
        isinstance(installations, dict)
        and set(installations) == {"amd64", "aarch64"},
        "public-install architecture set is not exact",
    )
    data_identities: set[str] = set()
    for architecture in ("amd64", "aarch64"):
        installation = installations[architecture]
        label = f"public-install {architecture}"
        require(
            isinstance(installation, dict)
            and set(installation)
            == {
                "status",
                "installation_source",
                "repository_id_sha256",
                "data_identity_before_restart_sha256",
                "data_identity_after_restart_sha256",
                "observed_repository_version",
                "observed_generic_digest",
                "observed_runtime_digest",
                "checks",
                "environment",
                "observed_at_utc",
            },
            f"{label} record keys are not exact",
        )
        require(
            installation.get("status") == "PASS",
            f"{label} record did not pass",
        )
        require(
            installation.get("installation_source")
            == "original_custom_repository_prebuilt_image",
            f"{label} installation source is not the original public repository prebuilt image",
        )
        repository_identity = validate_digest(
            installation.get("repository_id_sha256"),
            f"{label} repository identity digest",
        )
        data_identity_before = validate_digest(
            installation.get("data_identity_before_restart_sha256"),
            f"{label} data identity before restart digest",
        )
        data_identity_after = validate_digest(
            installation.get("data_identity_after_restart_sha256"),
            f"{label} data identity after restart digest",
        )
        require(
            data_identity_before == data_identity_after,
            f"{label} data identity changed across restart",
        )
        require(
            repository_identity != data_identity_before,
            f"{label} repository and data identity digests must be distinct",
        )
        require(
            data_identity_before not in data_identities,
            "public-install data identities must be unique across architectures",
        )
        data_identities.add(data_identity_before)
        require(
            installation.get("observed_repository_version") == expected_version,
            f"{label} repository metadata version differs",
        )
        require(
            installation.get("observed_generic_digest")
            == expected_generic_digest,
            f"{label} observed generic digest differs",
        )
        require(
            installation.get("observed_runtime_digest")
            == expected_runtime_digests[architecture],
            f"{label} observed runtime digest differs",
        )
        checks = installation.get("checks")
        require(
            isinstance(checks, dict)
            and set(checks) == EXPECTED_PUBLIC_INSTALL_CHECKS
            and set(checks.values()) == {"PASS"},
            f"{label} required checks are incomplete",
        )
        environment = installation.get("environment")
        require(
            isinstance(environment, dict)
            and set(environment)
            == {
                "platform",
                "architecture",
                "haos_version",
                "supervisor_version",
                "core_version",
                "final_app_version",
                "apparmor_mode",
            },
            f"{label} environment is not exact",
        )
        require(environment.get("platform") == "HAOS", f"{label} platform is not HAOS")
        require(
            environment.get("architecture") == architecture,
            f"{label} architecture differs",
        )
        for version_name in ("haos_version", "supervisor_version", "core_version"):
            version_value = environment.get(version_name)
            require(
                isinstance(version_value, str)
                and len(version_value) <= 32
                and VERSION_STRING_RE.fullmatch(version_value),
                f"{label} {version_name} is invalid",
            )
        require(
            environment.get("final_app_version") == expected_version,
            f"{label} final App version differs",
        )
        require(
            environment.get("apparmor_mode") == "enforce",
            f"{label} AppArmor mode is not enforce",
        )
        observed_at = parse_utc_timestamp(
            installation.get("observed_at_utc"),
            f"{label} observation timestamp",
        )
        require(
            observed_at >= published_at,
            f"{label} observation predates the GitHub Release",
        )
        require(
            observed_at <= now + timedelta(minutes=5),
            f"{label} report timestamp is in the future",
        )
        require(
            observed_at >= now - timedelta(days=30),
            f"{label} report is older than 30 days",
        )

    sanitization = report.get("sanitization")
    require(
        sanitization
        == {
            "contains_credentials": False,
            "contains_entity_or_chat_identifiers": False,
            "contains_raw_logs_or_prompts": False,
            "contains_private_host_or_user_identifiers": False,
        },
        "public-install report sanitization contract failed",
    )
    require(
        all(value is False for value in sanitization.values()),
        "public-install report sanitization flags are not boolean false",
    )
    attestation = report.get("attestation")
    require(
        attestation
        == {
            "real_haos_devices": True,
            "original_public_repository_verified": True,
            "public_release_observed_after_publish": True,
            "independent_fresh_installs_verified": True,
            "both_architectures_scope_reviewed": True,
            "sanitized_by_maintainer": True,
        },
        "public-install trusted-attestor declaration is incomplete",
    )
    require(
        all(value is True for value in attestation.values()),
        "public-install trusted-attestor flags are not boolean true",
    )
    return report


def command_public_install_report(args: argparse.Namespace) -> None:
    release_evidence = load_json(args.release_evidence)
    report = load_public_install_report(args.report)
    validate_public_install_report(
        release_evidence,
        report,
        version=args.version,
        source_sha=args.source_sha,
        generic_digest=args.generic_digest,
        amd64_runtime_digest=args.amd64_runtime_digest,
        aarch64_runtime_digest=args.aarch64_runtime_digest,
        published_at_utc=args.published_at_utc,
    )
    write_json(args.output, report)


def validate_haos_gate_directory(
    candidate: dict[str, Any],
    manual: dict[str, Any],
    directory: Path,
) -> dict[str, str]:
    require(directory.is_dir() and not directory.is_symlink(), "HAOS gate directory is unsafe")
    try:
        entries = list(directory.iterdir())
    except OSError as error:
        raise ContractError(f"cannot list HAOS gate directory: {error}") from error
    expected_names = {f"{gate}.json" for gate in EXPECTED_MANUAL_GATES}
    require({entry.name for entry in entries} == expected_names, "embedded HAOS gate file set is not exact")
    digests: dict[str, str] = {}
    for gate in sorted(EXPECTED_MANUAL_GATES):
        path = directory / f"{gate}.json"
        try:
            metadata = path.lstat()
            raw = path.read_bytes()
        except OSError as error:
            raise ContractError(f"cannot read embedded HAOS gate report {gate}: {error}") from error
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, f"unsafe embedded HAOS gate report: {gate}")
        require(len(raw) <= HAOS_EVIDENCE_MAX_BYTES, f"embedded HAOS gate report is too large: {gate}")
        validate_haos_gate_report(
            candidate,
            gate,
            strict_json_object(raw, f"embedded HAOS gate report {gate}"),
        )
        digests[gate] = digest_bytes(raw)
    return digests


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
        "haos_rehearsal": {
            "version": args.rehearsal_version,
            "image": args.generic_image,
            "digest": args.rehearsal_digest,
            "repository_manifest_sha256": digest_file(
                args.rehearsal_repository_manifest
            ),
            "repository_archive_sha256": digest_file(
                args.rehearsal_repository_archive
            ),
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
    haos_gate_evidence = validate_haos_gate_directory(
        candidate,
        manual,
        args.haos_gates_dir,
    )
    evidence = {
        "schema": "antigravity-ha-release-evidence/v1",
        "candidate": candidate,
        "candidate_artifact_digest": validate_digest(
            args.candidate_artifact_digest, "candidate artifact digest"
        ),
        "manual_evidence": manual,
        "haos_gate_evidence": haos_gate_evidence,
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
        set(evidence)
        == {
            "schema",
            "candidate",
            "candidate_artifact_digest",
            "manual_evidence",
            "haos_gate_evidence",
            "finalizer",
        },
        "release evidence keys are not exact",
    )
    require(evidence.get("schema") == "antigravity-ha-release-evidence/v1", "wrong release evidence schema")
    candidate = validate_candidate(evidence.get("candidate"))
    validate_digest(evidence.get("candidate_artifact_digest"), "candidate artifact digest")
    validate_manual(candidate, evidence.get("manual_evidence"))
    haos_gate_evidence = evidence.get("haos_gate_evidence")
    require(
        isinstance(haos_gate_evidence, dict)
        and set(haos_gate_evidence) == EXPECTED_MANUAL_GATES,
        "embedded HAOS gate digest set is not exact",
    )
    for gate, digest in haos_gate_evidence.items():
        validate_digest(digest, f"embedded HAOS gate digest: {gate}")
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
    require(
        validate_haos_gate_directory(
            candidate,
            evidence["manual_evidence"],
            args.haos_gates_dir,
        )
        == evidence["haos_gate_evidence"],
        "embedded HAOS gate report digest differs from release evidence",
    )
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
    require(
        validate_haos_gate_directory(
            candidate,
            evidence["manual_evidence"],
            args.haos_gates_dir,
        )
        == evidence["haos_gate_evidence"],
        "embedded HAOS gate report digest differs from release evidence",
    )
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
    for name in ("version", "source-sha", "run-id", "run-attempt", "candidate-tag", "generic-image", "generic-digest", "amd64-image", "amd64-stage-digest", "amd64-runtime-digest", "aarch64-image", "aarch64-stage-digest", "aarch64-runtime-digest", "rehearsal-version", "rehearsal-digest"):
        candidate.add_argument(f"--{name}", required=True)
    candidate.add_argument("--manifest", type=Path, required=True)
    candidate.add_argument("--rehearsal-repository-manifest", type=Path, required=True)
    candidate.add_argument("--rehearsal-repository-archive", type=Path, required=True)
    candidate.add_argument("--gap007-evidence", type=Path, required=True)
    candidate.add_argument("--output", type=Path, required=True)
    candidate.set_defaults(handler=command_candidate)

    manual = commands.add_parser("manual")
    manual.add_argument("--candidate", type=Path, required=True)
    manual.add_argument("--manual", type=Path, required=True)
    manual.set_defaults(handler=command_manual)

    manual_report = commands.add_parser("manual-report")
    manual_report.add_argument("--candidate", type=Path, required=True)
    manual_report.add_argument("--manual", type=Path, required=True)
    manual_report.add_argument("--gate", required=True, choices=sorted(EXPECTED_MANUAL_GATES))
    manual_report.add_argument("--evidence", type=Path, required=True)
    manual_report.add_argument("--output", type=Path)
    manual_report.set_defaults(handler=command_manual_report)

    haos_report = commands.add_parser("haos-report")
    haos_report.add_argument("--candidate", type=Path, required=True)
    haos_report.add_argument("--gate", required=True, choices=sorted(EXPECTED_MANUAL_GATES))
    haos_report.add_argument("--evidence", type=Path, required=True)
    haos_report.add_argument("--output", type=Path)
    haos_report.set_defaults(handler=command_haos_report)

    haos_templates = commands.add_parser("haos-report-templates")
    haos_templates.add_argument("--candidate", type=Path, required=True)
    haos_templates.add_argument("--output-dir", type=Path, required=True)
    haos_templates.set_defaults(handler=command_haos_report_templates)

    ha005_report = commands.add_parser("ha005-report")
    ha005_report.add_argument("--release-evidence", type=Path, required=True)
    ha005_report.add_argument("--report", type=Path, required=True)
    for name in (
        "version",
        "source-sha",
        "generic-digest",
        "amd64-runtime-digest",
        "published-at-utc",
    ):
        ha005_report.add_argument(f"--{name}", required=True)
    ha005_report.add_argument("--output", type=Path, required=True)
    ha005_report.set_defaults(handler=command_ha005_report)

    public_install_report = commands.add_parser("public-install-report")
    public_install_report.add_argument(
        "--release-evidence", type=Path, required=True
    )
    public_install_report.add_argument("--report", type=Path, required=True)
    for name in (
        "version",
        "source-sha",
        "generic-digest",
        "amd64-runtime-digest",
        "aarch64-runtime-digest",
        "published-at-utc",
    ):
        public_install_report.add_argument(f"--{name}", required=True)
    public_install_report.add_argument("--output", type=Path, required=True)
    public_install_report.set_defaults(handler=command_public_install_report)

    finalize = commands.add_parser("finalize")
    finalize.add_argument("--candidate", type=Path, required=True)
    finalize.add_argument("--manual", type=Path, required=True)
    finalize.add_argument("--candidate-artifact-digest", required=True)
    finalize.add_argument("--gap007-evidence", type=Path, required=True)
    finalize.add_argument("--haos-gates-dir", type=Path, required=True)
    finalize.add_argument("--actor", required=True)
    finalize.add_argument("--run-id", required=True)
    finalize.add_argument("--run-attempt", required=True)
    finalize.add_argument("--output", type=Path, required=True)
    finalize.set_defaults(handler=command_finalize)

    release = commands.add_parser("release")
    release.add_argument("--evidence", type=Path, required=True)
    release.add_argument("--gap007-evidence", type=Path, required=True)
    release.add_argument("--haos-gates-dir", type=Path, required=True)
    for name in ("version", "source-sha", "candidate-run-id", "candidate-run-attempt", "evidence-run-id", "evidence-run-attempt"):
        release.add_argument(f"--{name}", required=True)
    release.add_argument("--github-output", type=Path)
    release.set_defaults(handler=command_release)

    notes = commands.add_parser("notes")
    notes.add_argument("--evidence", type=Path, required=True)
    notes.add_argument("--gap007-evidence", type=Path, required=True)
    notes.add_argument("--haos-gates-dir", type=Path, required=True)
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
