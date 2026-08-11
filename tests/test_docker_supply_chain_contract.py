from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADDON = ROOT / "antigravity_home_assistant"
DOCKERFILE = ADDON / "Dockerfile"


def argument(dockerfile: str, name: str) -> str:
    match = re.search(rf"^ARG {re.escape(name)}=([^\s]+)$", dockerfile, re.MULTILINE)
    assert match, f"missing Docker build argument: {name}"
    return match.group(1)


def test_base_and_debian_packages_use_a_signed_fixed_snapshot() -> None:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    build_from = argument(dockerfile, "BUILD_FROM")
    snapshot = argument(dockerfile, "DEBIAN_SNAPSHOT")

    assert re.fullmatch(
        r"ghcr\.io/home-assistant/base-debian:bookworm@sha256:[0-9a-f]{64}",
        build_from,
    )
    assert not build_from.endswith("0" * 64)
    assert snapshot == "20260812T000000Z"
    assert re.fullmatch(r"\d{8}T\d{6}Z", snapshot)
    assert (
        "https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}"
        in dockerfile
    )
    assert (
        "https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}"
        in dockerfile
    )
    assert 'Acquire::Check-Valid-Until "false";' in dockerfile
    assert dockerfile.index("snapshot.debian.org") < dockerfile.index("apt-get update")
    assert "--allow-unauthenticated" not in dockerfile
    assert "trusted=yes" not in dockerfile
    assert "allow-insecure-repositories" not in dockerfile
    assert argument(dockerfile, "CHROMIUM_VERSION") == "151.0.7922.108"
    assert 'Chromium ${CHROMIUM_VERSION} ' in dockerfile


def test_every_external_archive_has_a_nonzero_pinned_checksum() -> None:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    checksum_arguments = {
        "ANTIGRAVITY_AMD64_SHA512": 128,
        "ANTIGRAVITY_ARM64_SHA512": 128,
        "NODE_AMD64_SHA256": 64,
        "NODE_ARM64_SHA256": 64,
        "GH_AMD64_SHA256": 64,
        "GH_ARM64_SHA256": 64,
        "TTYD_AMD64_SHA256": 64,
        "TTYD_ARM64_SHA256": 64,
    }
    for name, length in checksum_arguments.items():
        value = argument(dockerfile, name)
        assert re.fullmatch(rf"[0-9a-f]{{{length}}}", value), name
        assert value != "0" * length

    assert dockerfile.count("sha256sum --check --strict -") >= 3
    assert "sha512sum --check --strict -" in dockerfile
    assert "curl --fail --show-error --silent --location" in dockerfile


def test_npm_install_is_lockfile_only_and_every_tarball_has_integrity() -> None:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    lock = json.loads(
        (ADDON / "playwright/package-lock.json").read_text(encoding="utf-8")
    )

    assert lock["lockfileVersion"] == 3
    assert "npm ci --prefix /usr/local/lib/antigravity-ha/playwright" in dockerfile
    assert "--ignore-scripts" in dockerfile
    assert "npm install" not in dockerfile
    resolved = [
        package
        for name, package in lock["packages"].items()
        if name and "resolved" in package
    ]
    assert resolved
    assert all(
        re.fullmatch(r"sha512-[A-Za-z0-9+/]+={0,2}", package.get("integrity", ""))
        for package in resolved
    )
