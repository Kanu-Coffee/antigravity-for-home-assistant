from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tarfile
from pathlib import Path
from types import ModuleType

import pytest


ROOT = Path(__file__).resolve().parents[1]
ROOTFS = ROOT / "antigravity_home_assistant/rootfs"
MANIFEST = (
    ROOTFS / "usr/local/share/antigravity-ha/source-rootfs-manifest.json"
)
TOOL = ROOT / ".github/scripts/source-rootfs-manifest.py"
DOCKERFILE = ROOT / "antigravity_home_assistant/Dockerfile"


def load_tool() -> ModuleType:
    spec = importlib.util.spec_from_file_location("source_rootfs_manifest", TOOL)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SOURCE_MANIFEST = load_tool()


def test_checked_in_source_manifest_matches_rootfs_content() -> None:
    document = SOURCE_MANIFEST.load_manifest(MANIFEST)
    actual = SOURCE_MANIFEST.build_manifest(ROOTFS)

    assert actual == document
    assert MANIFEST.as_posix().endswith(SOURCE_MANIFEST.MANIFEST_RELATIVE_PATH.as_posix())


def test_manifest_detects_mutation_revision_and_symlink(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    assert subprocess.run(
        ["git", "init", "--quiet"], cwd=repository, check=False
    ).returncode == 0
    rootfs = repository / "rootfs"
    rootfs.mkdir()
    source = rootfs / "runtime.mjs"
    source.write_text("export const value = 1;\n", encoding="utf-8")
    (repository / ".gitignore").write_text("rootfs/ignored.txt\n", encoding="utf-8")
    (rootfs / "ignored.txt").write_text("local-only\n", encoding="utf-8")
    manifest_path = tmp_path / "manifest.json"
    SOURCE_MANIFEST.write_manifest(
        manifest_path,
        SOURCE_MANIFEST.build_manifest(rootfs),
    )
    assert SOURCE_MANIFEST.verify_source(rootfs, manifest_path)
    assert all(
        item["path"] != "/ignored.txt"
        for item in SOURCE_MANIFEST.load_manifest(manifest_path)["files"]
    )

    source.write_text("export const value = 2;\n", encoding="utf-8")
    with pytest.raises(SOURCE_MANIFEST.ManifestError, match="does not match"):
        SOURCE_MANIFEST.verify_source(rootfs, manifest_path)

    source.unlink()
    source.symlink_to("elsewhere")
    with pytest.raises(SOURCE_MANIFEST.ManifestError, match="non-regular"):
        SOURCE_MANIFEST.build_manifest(rootfs)

    source.unlink()
    os.mkfifo(source)
    with pytest.raises(SOURCE_MANIFEST.ManifestError, match="non-regular"):
        SOURCE_MANIFEST.build_manifest(rootfs)


def test_dockerignore_generator_rejects_drift_and_pattern_paths(
    tmp_path: Path,
) -> None:
    document = SOURCE_MANIFEST.load_manifest(MANIFEST)
    dockerignore = tmp_path / ".dockerignore"
    SOURCE_MANIFEST.write_dockerignore(dockerignore, document)
    SOURCE_MANIFEST.verify_dockerignore(dockerignore, document)

    with dockerignore.open("a", encoding="utf-8") as stream:
        stream.write("!rootfs/**\n")
    with pytest.raises(
        SOURCE_MANIFEST.ManifestError,
        match="stale or contains unmanifested patterns",
    ):
        SOURCE_MANIFEST.verify_dockerignore(dockerignore, document)

    unsafe_files = [
        {
            "path": "/unsafe/*.txt",
            "mode": "0644",
            "size": 0,
            "sha256": f"sha256:{'0' * 64}",
        }
    ]
    unsafe_document = {
        "schema": SOURCE_MANIFEST.SCHEMA,
        "source_rootfs_sha256": SOURCE_MANIFEST.rootfs_digest(unsafe_files),
        "files": unsafe_files,
    }
    with pytest.raises(
        SOURCE_MANIFEST.ManifestError,
        match="cannot be represented exactly",
    ):
        SOURCE_MANIFEST.dockerignore_lines(unsafe_document)


def test_create_and_verify_cli_bind_manifest_to_context_allowlist(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repository"
    addon = repository / "addon"
    rootfs = addon / "rootfs"
    runtime = rootfs / "usr/local/bin/runtime"
    runtime.parent.mkdir(parents=True)
    runtime.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    runtime.chmod(0o755)
    playwright = addon / "playwright"
    playwright.mkdir(parents=True)
    (addon / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8")
    (playwright / "package.json").write_text("{}\n", encoding="utf-8")
    (playwright / "package-lock.json").write_text(
        '{"lockfileVersion":3}\n', encoding="utf-8"
    )
    subprocess.run(["git", "init", "--quiet"], cwd=repository, check=True)

    manifest = rootfs / SOURCE_MANIFEST.MANIFEST_RELATIVE_PATH
    create = subprocess.run(
        [
            "python3",
            str(TOOL),
            "create",
            "--root",
            str(rootfs),
            "--manifest",
            str(manifest),
        ],
        cwd=repository,
        check=False,
        capture_output=True,
        text=True,
    )
    assert create.returncode == 0, create.stdout + create.stderr
    document = SOURCE_MANIFEST.load_manifest(manifest)
    dockerignore = addon / ".dockerignore"
    assert dockerignore.read_text(encoding="utf-8") == (
        SOURCE_MANIFEST.dockerignore_content(document)
    )

    with dockerignore.open("a", encoding="utf-8") as stream:
        stream.write("!rootfs/**\n")
    verify = subprocess.run(
        [
            "python3",
            str(TOOL),
            "verify",
            "--root",
            str(rootfs),
            "--manifest",
            str(manifest),
        ],
        cwd=repository,
        check=False,
        capture_output=True,
        text=True,
    )
    assert verify.returncode == 1
    assert "stale or contains unmanifested patterns" in verify.stderr

    dockerfile = addon / "Dockerfile"
    dockerfile.unlink()
    dockerfile.symlink_to("elsewhere")
    create = subprocess.run(
        [
            "python3",
            str(TOOL),
            "create",
            "--root",
            str(rootfs),
            "--manifest",
            str(manifest),
        ],
        cwd=repository,
        check=False,
        capture_output=True,
        text=True,
    )
    assert create.returncode == 1
    assert "Docker context source is not a regular file" in create.stderr


def test_build_and_workflows_bind_revision_and_rootfs_digest() -> None:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    build_workflow = (ROOT / ".github/workflows/build-app.yaml").read_text(
        encoding="utf-8"
    )
    ci_workflow = (ROOT / ".github/workflows/ci.yaml").read_text(encoding="utf-8")
    local_builder = (ROOT / "tools/development/build-app").read_text(
        encoding="utf-8"
    )

    for fragment in (
        "ARG SOURCE_REVISION=",
        "ARG SOURCE_ROOTFS_SHA256=",
        'org.opencontainers.image.revision="${SOURCE_REVISION}"',
        'io.antigravity-ha.source-rootfs-sha256="${SOURCE_ROOTFS_SHA256}"',
        "source-rootfs-manifest.json",
        "--mount=type=bind,source=rootfs",
        "actual_count=",
        "stat -c '%u:%g'",
        "sha256sum",
    ):
        assert fragment in dockerfile

    for workflow in (build_workflow, local_builder):
        assert ".github/scripts/source-rootfs-manifest.py" in workflow
        assert "source_rootfs_sha256" in workflow
        assert "verify-installed" in workflow
        assert "SOURCE_REVISION" in workflow or "org.opencontainers.image.revision" in workflow

    assert "tools/development/build-app build" in ci_workflow
    assert "build-args: |" in build_workflow


def test_manifest_document_has_exact_schema_and_no_self_entry() -> None:
    document = json.loads(MANIFEST.read_text(encoding="utf-8"))
    validated = SOURCE_MANIFEST.validate_manifest(document)

    assert set(validated) == {
        "schema",
        "source_rootfs_sha256",
        "files",
    }
    assert all(
        item["path"] != f"/{SOURCE_MANIFEST.MANIFEST_RELATIVE_PATH.as_posix()}"
        for item in validated["files"]
    )


def test_exact_installed_verification_rejects_gitignored_rootfs_canary(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repository"
    rootfs = repository / "rootfs"
    rootfs.mkdir(parents=True)
    subprocess.run(["git", "init", "--quiet"], cwd=repository, check=True)
    source = rootfs / "runtime.mjs"
    source.write_text("export const runtime = true;\n", encoding="utf-8")
    (repository / ".gitignore").write_text("rootfs/ignored-canary.txt\n", encoding="utf-8")
    ignored = rootfs / "ignored-canary.txt"
    ignored.write_text("must not enter Docker context\n", encoding="utf-8")
    manifest = rootfs / SOURCE_MANIFEST.MANIFEST_RELATIVE_PATH
    SOURCE_MANIFEST.write_manifest(manifest, SOURCE_MANIFEST.build_manifest(rootfs))

    with pytest.raises(SOURCE_MANIFEST.ManifestError, match="unmanifested"):
        SOURCE_MANIFEST.verify_installed(rootfs, manifest, exact=True)
    ignored.unlink()
    assert SOURCE_MANIFEST.verify_installed(rootfs, manifest, exact=True)


def test_exported_image_archive_is_verified_without_image_binaries(tmp_path: Path) -> None:
    rootfs = tmp_path / "rootfs"
    runtime = rootfs / "usr/local/share/antigravity-ha/runtime.mjs"
    runtime.parent.mkdir(parents=True)
    runtime.write_text("export const verified = true;\n", encoding="utf-8")
    files = [{
        "path": "/usr/local/share/antigravity-ha/runtime.mjs",
        "mode": "0644",
        "size": runtime.stat().st_size,
        "sha256": SOURCE_MANIFEST.file_digest(runtime),
    }]
    document = {
        "schema": SOURCE_MANIFEST.SCHEMA,
        "source_rootfs_sha256": SOURCE_MANIFEST.rootfs_digest(files),
        "files": files,
    }
    manifest = rootfs / SOURCE_MANIFEST.MANIFEST_RELATIVE_PATH
    SOURCE_MANIFEST.write_manifest(manifest, document)

    def root_owned(member: tarfile.TarInfo) -> tarfile.TarInfo:
        member.uid = 0
        member.gid = 0
        member.uname = "root"
        member.gname = "root"
        return member

    archive = tmp_path / "rootfs.tar"
    with tarfile.open(archive, "w") as stream:
        stream.add(
            runtime,
            arcname=files[0]["path"].lstrip("/"),
            recursive=False,
            filter=root_owned,
        )
        stream.add(
            manifest,
            arcname=SOURCE_MANIFEST.MANIFEST_RELATIVE_PATH.as_posix(),
            recursive=False,
            filter=root_owned,
        )
    assert SOURCE_MANIFEST.verify_image_archive(archive) == document

    def non_root_owned(member: tarfile.TarInfo) -> tarfile.TarInfo:
        member.uid = 1000
        member.gid = 1000
        return member

    unowned = tmp_path / "unowned.tar"
    with tarfile.open(unowned, "w") as stream:
        stream.add(
            runtime,
            arcname=files[0]["path"].lstrip("/"),
            recursive=False,
            filter=non_root_owned,
        )
        stream.add(
            manifest,
            arcname=SOURCE_MANIFEST.MANIFEST_RELATIVE_PATH.as_posix(),
            recursive=False,
            filter=root_owned,
        )
    with pytest.raises(SOURCE_MANIFEST.ManifestError, match="ownership differs"):
        SOURCE_MANIFEST.verify_image_archive(unowned)

    runtime.write_text("export const verified = false;\n", encoding="utf-8")
    tampered = tmp_path / "tampered.tar"
    with tarfile.open(tampered, "w") as stream:
        stream.add(
            runtime,
            arcname=files[0]["path"].lstrip("/"),
            recursive=False,
            filter=root_owned,
        )
        stream.add(
            manifest,
            arcname=SOURCE_MANIFEST.MANIFEST_RELATIVE_PATH.as_posix(),
            recursive=False,
            filter=root_owned,
        )
    with pytest.raises(SOURCE_MANIFEST.ManifestError, match="size differs|digest differs"):
        SOURCE_MANIFEST.verify_image_archive(tampered)


def test_verify_image_cli_is_fail_closed_and_returns_sanitized_binding() -> None:
    source = TOOL.read_text(encoding="utf-8")
    for fragment in (
        'subparsers.add_parser("verify-image")',
        '["docker", "image", "inspect", image]',
        '"/bin/true",\n                    image_id,',
        '["docker", "export", "--output"',
        '"antigravity-ha-source-image-verification/v1"',
        '"verified_files"',
    ):
        assert fragment in source
