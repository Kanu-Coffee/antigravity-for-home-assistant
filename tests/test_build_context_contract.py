from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
from pathlib import Path
from types import ModuleType

import pytest


ROOT = Path(__file__).resolve().parents[1]
ADDON = ROOT / "antigravity_home_assistant"
ROOTFS = ADDON / "rootfs"
MANIFEST = ROOTFS / "usr/local/share/antigravity-ha/source-rootfs-manifest.json"
TOOL = ROOT / ".github/scripts/source-rootfs-manifest.py"


def load_tool() -> ModuleType:
    spec = importlib.util.spec_from_file_location("source_rootfs_manifest_context", TOOL)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SOURCE_MANIFEST = load_tool()


def docker_buildx_available() -> bool:
    if shutil.which("docker") is None:
        return False
    for command in (["docker", "info"], ["docker", "buildx", "version"]):
        try:
            result = subprocess.run(
                command,
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        if result.returncode != 0:
            return False
    return True


def test_docker_build_context_is_a_generated_exact_file_allowlist() -> None:
    document = SOURCE_MANIFEST.load_manifest(MANIFEST)
    dockerignore = (ADDON / ".dockerignore").read_text(
        encoding="utf-8"
    ).splitlines()

    assert dockerignore == SOURCE_MANIFEST.dockerignore_lines(document)
    assert dockerignore.count("**") == 1
    assert "!rootfs/**" not in dockerignore
    assert all(
        "*" not in pattern
        for pattern in dockerignore
        if pattern.startswith("!")
    )

    actual_files = {
        Path(pattern.removeprefix("!"))
        for pattern in dockerignore
        if pattern.startswith("!") and not pattern.endswith("/")
    }
    expected_files = set(SOURCE_MANIFEST.DOCKER_CONTEXT_FILES)
    expected_files.update(
        Path("rootfs") / item["path"].lstrip("/") for item in document["files"]
    )
    expected_files.add(Path("rootfs") / SOURCE_MANIFEST.MANIFEST_RELATIVE_PATH)
    assert actual_files == expected_files

    actual_directories = {
        Path(pattern.removeprefix("!").removesuffix("/"))
        for pattern in dockerignore
        if pattern.startswith("!") and pattern.endswith("/")
    }
    expected_directories = {Path("playwright"), Path("rootfs")}
    for file_path in expected_files:
        for parent in file_path.parents:
            if parent == Path("."):
                break
            expected_directories.add(parent)
    assert actual_directories == expected_directories
    assert {
        pattern
        for pattern in dockerignore
        if pattern.endswith("/*") and not pattern.startswith("!")
    } == {f"{path.as_posix()}/*" for path in expected_directories}

    dockerfile = (ADDON / "Dockerfile").read_text(encoding="utf-8")
    copy_sources = []
    for line in dockerfile.splitlines():
        stripped = line.strip()
        if stripped.startswith("COPY "):
            copy_sources.append(stripped)

    assert copy_sources == [
        "COPY playwright/package.json playwright/package-lock.json /usr/local/lib/antigravity-ha/playwright/",
        "COPY rootfs /",
    ]


def test_local_and_ignored_files_cannot_enter_the_image_context() -> None:
    allowed_top_level = {"Dockerfile", "playwright", "rootfs"}
    repository_only_paths = {
        path.name
        for path in ADDON.iterdir()
        if path.name not in allowed_top_level and path.name != ".dockerignore"
    }

    assert repository_only_paths
    assert {
        "config.yaml",
        "DOCS.md",
        "translations",
    }.issubset(repository_only_paths)

    dockerfile = (ADDON / "Dockerfile").read_text(encoding="utf-8")
    assert "--mount=type=bind,source=rootfs" in dockerfile
    assert 'test -z "$(find "${source_root}" -mindepth 1 ! -type d ! -type f' in dockerfile
    assert 'actual_count="$(find "${source_root}" -type f' in dockerfile
    assert '[[ "${actual_count}" == "${expected_count}" ]]' in dockerfile


@pytest.mark.skipif(not docker_buildx_available(), reason="Docker Buildx is unavailable")
def test_docker_buildx_filters_unmanifested_rootfs_canaries_before_copy(
    tmp_path: Path,
) -> None:
    context = tmp_path / "context"
    rootfs = context / "rootfs"
    runtime = rootfs / "safe/runtime.txt"
    runtime.parent.mkdir(parents=True)
    runtime.write_text("manifested runtime\n", encoding="utf-8")

    files = [
        {
            "path": "/safe/runtime.txt",
            "mode": "0644",
            "size": runtime.stat().st_size,
            "sha256": SOURCE_MANIFEST.file_digest(runtime),
        }
    ]
    document = {
        "schema": SOURCE_MANIFEST.SCHEMA,
        "source_rootfs_sha256": SOURCE_MANIFEST.rootfs_digest(files),
        "files": files,
    }
    manifest = rootfs / SOURCE_MANIFEST.MANIFEST_RELATIVE_PATH
    SOURCE_MANIFEST.write_manifest(manifest, document)
    SOURCE_MANIFEST.write_dockerignore(context / ".dockerignore", document)

    (rootfs / "safe/ignored-secret.txt").write_text(
        "must never reach the Docker daemon\n", encoding="utf-8"
    )
    nested_canary = rootfs / "safe/ignored-directory/deep-secret.txt"
    nested_canary.parent.mkdir()
    nested_canary.write_text(
        "must never reach the Docker daemon\n", encoding="utf-8"
    )
    (rootfs / "ignored-at-root.txt").write_text(
        "must never reach the Docker daemon\n", encoding="utf-8"
    )
    (context / "top-level-secret.txt").write_text(
        "must never reach the Docker daemon\n", encoding="utf-8"
    )
    playwright = context / "playwright"
    playwright.mkdir()
    (playwright / "package.json").write_text("{}\n", encoding="utf-8")
    (playwright / "package-lock.json").write_text(
        json.dumps({"lockfileVersion": 3}) + "\n", encoding="utf-8"
    )
    (playwright / "ignored-local.txt").write_text(
        "must never reach the Docker daemon\n", encoding="utf-8"
    )
    (context / "Dockerfile").write_text(
        "FROM scratch\n"
        "COPY rootfs /rootfs\n"
        "COPY playwright /playwright\n",
        encoding="utf-8",
    )

    output = tmp_path / "output"
    result = subprocess.run(
        [
            "docker",
            "buildx",
            "build",
            "--no-cache",
            "--progress=plain",
            "--output",
            f"type=local,dest={output}",
            str(context),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert (output / "rootfs/safe/runtime.txt").read_bytes() == runtime.read_bytes()
    assert (output / "rootfs" / SOURCE_MANIFEST.MANIFEST_RELATIVE_PATH).is_file()
    assert (output / "playwright/package.json").is_file()
    assert (output / "playwright/package-lock.json").is_file()
    assert not (output / "rootfs/safe/ignored-secret.txt").exists()
    assert not (output / "rootfs/safe/ignored-directory").exists()
    assert not (output / "rootfs/ignored-at-root.txt").exists()
    assert not (output / "playwright/ignored-local.txt").exists()
    assert not (output / "top-level-secret.txt").exists()
