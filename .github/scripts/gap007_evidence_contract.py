#!/usr/bin/env python3
"""Fail-closed validation for GAP-007 candidate and evidence binding."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import NoReturn


IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
BUDGET_SCHEMA = "antigravity-ha-performance-budget/v1"


class ContractError(ValueError):
    """Raised when release evidence is incomplete or over-claims its scope."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ContractError(f"JSON input is unreadable: {error}") from error
    require(isinstance(value, dict), "JSON input must be an object")
    return value


def validate_candidate_binding(
    *,
    image_id: str,
    revision: str,
    source_rootfs_sha256: str,
    expected_revision: str,
    expected_source_rootfs_sha256: str,
) -> None:
    require(bool(IMAGE_ID.fullmatch(image_id)), "candidate image ID is not immutable")
    require(
        bool(REVISION.fullmatch(revision)) and revision != "0" * 40,
        "candidate revision label is missing or invalid",
    )
    require(
        bool(DIGEST.fullmatch(source_rootfs_sha256)),
        "candidate source-rootfs label is missing or invalid",
    )
    require(revision == expected_revision, "candidate revision is stale")
    require(
        source_rootfs_sha256 == expected_source_rootfs_sha256,
        "candidate source-rootfs label does not match current source",
    )


def validate_budget(document: dict) -> dict:
    require(
        set(document) == {
            "schema",
            "baseline_evidence_sha256",
            "baseline",
            "limits",
        },
        "performance budget keys are not exact",
    )
    require(document["schema"] == BUDGET_SCHEMA, "performance budget schema is invalid")
    require(
        isinstance(document["baseline_evidence_sha256"], str)
        and bool(DIGEST.fullmatch(document["baseline_evidence_sha256"])),
        "performance baseline digest is missing",
    )
    limits = document["limits"]
    require(
        isinstance(limits, dict)
        and set(limits) == {
            "max_average_cpu_percent",
            "max_peak_rss_bytes",
            "max_image_size_bytes",
        },
        "performance limits are missing",
    )
    require(
        isinstance(limits["max_average_cpu_percent"], (int, float))
        and 0 < limits["max_average_cpu_percent"] <= 100,
        "average CPU budget is invalid",
    )
    for name in ("max_peak_rss_bytes", "max_image_size_bytes"):
        require(
            isinstance(limits[name], int) and limits[name] > 0,
            f"{name} budget is invalid",
        )
    return limits


def validate_component(
    document: dict,
    *,
    image_id: str,
    candidate_leaf_digest: str,
    candidate_stage_digest: str,
    revision: str,
    source_rootfs_sha256: str,
    expect_closure: bool = False,
) -> None:
    require(document.get("mode") == "release", "component evidence is not release mode")
    require(document.get("result") == "PASS", "component evidence did not pass")
    require(
        document.get("closure_eligible") is expect_closure,
        "evidence closure state is invalid for its validation phase",
    )
    provenance = document.get("provenance")
    require(isinstance(provenance, dict), "component provenance is missing")
    require(
        provenance.get("candidate_image_id") == image_id,
        "component candidate image ID is stale",
    )
    require(
        bool(DIGEST.fullmatch(candidate_leaf_digest))
        and provenance.get("candidate_leaf_digest") == candidate_leaf_digest,
        "component candidate leaf digest is stale",
    )
    require(
        bool(DIGEST.fullmatch(candidate_stage_digest))
        and provenance.get("candidate_stage_digest") == candidate_stage_digest,
        "component candidate staging digest is stale",
    )
    require(provenance.get("git_commit") == revision, "component revision is stale")
    require(
        provenance.get("source_rootfs_sha256") == source_rootfs_sha256,
        "component source-rootfs is stale",
    )
    require(
        provenance.get("module_origin") == "packaged_image",
        "synthetic host-only component evidence is forbidden",
    )
    require(
        provenance.get("telegram_bridge_module_path")
        == "/usr/local/share/antigravity-ha/telegram-bridge.mjs",
        "packaged Telegram module path was not verified",
    )
    require(
        document.get("telegram", {}).get("required_elapsed_seconds") == 1800
        and document["telegram"].get("actual_elapsed_seconds", 0) >= 1800,
        "Telegram soak threshold was not met",
    )
    failure = document.get("failure_injection", {})
    require(
        failure.get("required_elapsed_seconds") == 900
        and failure.get("actual_elapsed_seconds", 0) >= 900,
        "simultaneous outage threshold was not met",
    )
    require(
        failure.get("backoff_implementation") == "packaged_telegram_bridge",
        "packaged Telegram backoff state machine was not exercised",
    )
    require(
        failure.get("backoff_reset_after_recovery") is True,
        "packaged Telegram backoff was not reset after recovery",
    )
    require(failure.get("external_calls") == 0, "component made an external call")
    require(
        document.get("bounded_io", {}).get("indexed_entities") == 1000,
        "1,000-entity fixture was not indexed",
    )
    require(
        document.get("rapid_restart", {}).get("required_count") == 20
        and document["rapid_restart"].get("completed_count") == 20,
        "packaged broker restart threshold was not met",
    )


def validate_final(
    document: dict,
    *,
    image_id: str,
    candidate_leaf_digest: str,
    candidate_stage_digest: str,
    revision: str,
    source_rootfs_sha256: str,
    budget: dict,
) -> None:
    validate_component(
        document,
        image_id=image_id,
        candidate_leaf_digest=candidate_leaf_digest,
        candidate_stage_digest=candidate_stage_digest,
        revision=revision,
        source_rootfs_sha256=source_rootfs_sha256,
        expect_closure=True,
    )
    require(
        document["provenance"].get("source_tree_stable") is True,
        "source-rootfs was not stable for the full release run",
    )
    require(
        document["provenance"].get("candidate_architecture") == "amd64"
        and document["provenance"].get("candidate_revision") == revision,
        "candidate architecture or revision is stale",
    )
    source_image = document["provenance"].get("source_image_verification")
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
        "independent source-image verification is missing",
    )
    require(
        source_image.get("schema")
        == "antigravity-ha-source-image-verification/v1"
        and source_image.get("image_id") == image_id
        and source_image.get("revision") == revision
        and source_image.get("source_rootfs_sha256") == source_rootfs_sha256
        and isinstance(source_image.get("verified_files"), int)
        and source_image["verified_files"] > 0,
        "source image, manifest, label, and source revision are not bound",
    )
    candidate_restart = document.get("rapid_restart", {}).get("candidate_container", {})
    require(
        candidate_restart.get("required_count") == 20
        and candidate_restart.get("completed_count") == 20,
        "candidate container restart threshold was not met",
    )
    require(
        candidate_restart.get("pending_journal_count") == 0
        and candidate_restart.get("zombie_process_count") == 0
        and candidate_restart.get("stale_socket_count") == 0,
        "candidate restart durability checks did not pass",
    )
    limits = validate_budget(budget)
    measured = document.get("resources", {}).get("candidate_budget")
    require(isinstance(measured, dict), "candidate resource budget evidence is missing")
    require(measured.get("result") == "PASS", "candidate resource budget did not pass")
    require(
        measured.get("baseline_evidence_sha256")
        == budget["baseline_evidence_sha256"],
        "candidate performance baseline is stale",
    )
    require(measured.get("limits") == limits, "candidate resource limits are stale")
    observed = measured.get("observed", {})
    require(
        observed.get("average_cpu_percent", float("inf"))
        <= limits["max_average_cpu_percent"],
        "candidate average CPU exceeded its budget",
    )
    require(
        observed.get("peak_rss_bytes", float("inf")) <= limits["max_peak_rss_bytes"],
        "candidate peak RSS exceeded its budget",
    )
    require(
        observed.get("image_size_bytes", float("inf"))
        <= limits["max_image_size_bytes"],
        "candidate image size exceeded its budget",
    )


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    candidate = subparsers.add_parser("candidate")
    for name in (
        "image-id",
        "revision",
        "source-rootfs-sha256",
        "expected-revision",
        "expected-source-rootfs-sha256",
    ):
        candidate.add_argument(f"--{name}", required=True)
    for command in ("component", "final"):
        evidence = subparsers.add_parser(command)
        evidence.add_argument("--evidence", required=True, type=Path)
        evidence.add_argument("--image-id", required=True)
        evidence.add_argument("--candidate-leaf-digest", required=True)
        evidence.add_argument("--candidate-stage-digest", required=True)
        evidence.add_argument("--revision", required=True)
        evidence.add_argument("--source-rootfs-sha256", required=True)
        if command == "final":
            evidence.add_argument("--budget", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    try:
        if arguments.command == "candidate":
            validate_candidate_binding(
                image_id=arguments.image_id,
                revision=arguments.revision,
                source_rootfs_sha256=arguments.source_rootfs_sha256,
                expected_revision=arguments.expected_revision,
                expected_source_rootfs_sha256=(
                    arguments.expected_source_rootfs_sha256
                ),
            )
        elif arguments.command == "component":
            validate_component(
                read_json(arguments.evidence),
                image_id=arguments.image_id,
                candidate_leaf_digest=arguments.candidate_leaf_digest,
                candidate_stage_digest=arguments.candidate_stage_digest,
                revision=arguments.revision,
                source_rootfs_sha256=arguments.source_rootfs_sha256,
            )
        else:
            validate_final(
                read_json(arguments.evidence),
                image_id=arguments.image_id,
                candidate_leaf_digest=arguments.candidate_leaf_digest,
                candidate_stage_digest=arguments.candidate_stage_digest,
                revision=arguments.revision,
                source_rootfs_sha256=arguments.source_rootfs_sha256,
                budget=read_json(arguments.budget),
            )
        return 0
    except ContractError as error:
        print(f"GAP-007 evidence contract failed: {error}", file=__import__("sys").stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
