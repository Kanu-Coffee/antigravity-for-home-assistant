from __future__ import annotations

import json
import os
import shutil
import subprocess
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / ".github/scripts/candidate_repository.py"
SOURCE = "a" * 40
DIGEST = "sha256:" + "b" * 64
VERSION = "3.0.1-candidate.101.2"
IMAGE = "ghcr.io/kanu-coffee/antigravity-for-home-assistant"


def _restrictive_umask() -> None:
    os.umask(0o077)


def _run(
    *arguments: str,
    restrictive_umask: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(SCRIPT), *arguments],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        preexec_fn=_restrictive_umask if restrictive_umask else None,
    )


def _create(
    tmp_path: Path,
    *,
    app_directory: Path = ROOT / "antigravity_home_assistant",
    version: str = VERSION,
) -> tuple[Path, Path]:
    repository = tmp_path / "candidate-repository"
    manifest = tmp_path / "candidate-repository-manifest.json"
    result = _run(
        "create",
        "--app-directory",
        str(app_directory),
        "--repository-yaml",
        str(ROOT / "repository.yaml"),
        "--source-sha",
        SOURCE,
        "--version",
        version,
        "--image",
        IMAGE,
        "--digest",
        DIGEST,
        "--output",
        str(repository),
        "--manifest",
        str(manifest),
    )
    assert result.returncode == 0, result.stderr
    return repository, manifest


def test_candidate_repository_derives_source_version_from_candidate(
    tmp_path: Path,
) -> None:
    source_app = tmp_path / "source-app"
    shutil.copytree(ROOT / "antigravity_home_assistant", source_app)
    source_config = source_app / "config.yaml"
    source_text = source_config.read_text(encoding="utf-8")
    assert source_text.count('version: "3.0.1"') == 1
    source_config.write_text(
        source_text.replace('version: "3.0.1"', 'version: "3.0.2"'),
        encoding="utf-8",
    )

    candidate_version = "3.0.2-candidate.101.2"
    repository, manifest_path = _create(
        tmp_path,
        app_directory=source_app,
        version=candidate_version,
    )
    candidate_config = (
        repository / "antigravity_home_assistant/config.yaml"
    ).read_text(encoding="utf-8")
    assert candidate_config.count(f'version: "{candidate_version}"') == 1
    assert json.loads(manifest_path.read_text(encoding="utf-8"))["version"] == candidate_version

    mismatched_root = tmp_path / "mismatched"
    mismatched_root.mkdir()
    result = _run(
        "create",
        "--app-directory",
        str(source_app),
        "--repository-yaml",
        str(ROOT / "repository.yaml"),
        "--source-sha",
        SOURCE,
        "--version",
        "3.0.1-candidate.101.2",
        "--image",
        IMAGE,
        "--digest",
        DIGEST,
        "--output",
        str(mismatched_root / "candidate-repository"),
        "--manifest",
        str(mismatched_root / "candidate-repository-manifest.json"),
    )
    assert result.returncode != 0
    assert "source config version line is not exact" in result.stderr


def test_candidate_repository_is_source_digest_and_version_bound(
    tmp_path: Path,
) -> None:
    repository, manifest_path = _create(tmp_path)
    manifest = json.loads(manifest_path.read_text())
    assert manifest["source_sha"] == SOURCE
    assert manifest["version"] == VERSION
    assert manifest["manifest_digest"] == DIGEST
    assert manifest["files"]
    config = (
        repository / "antigravity_home_assistant/config.yaml"
    ).read_text()
    assert f'version: "{VERSION}"' in config
    assert f"image: {IMAGE}" in config
    result = _run(
        "verify",
        "--repository",
        str(repository),
        "--manifest",
        str(manifest_path),
    )
    assert result.returncode == 0, result.stderr
    archive = tmp_path / "candidate-repository.zip"
    result = _run(
        "archive",
        "--repository",
        str(repository),
        "--manifest",
        str(manifest_path),
        "--output",
        str(archive),
    )
    assert result.returncode == 0, result.stderr
    result = _run(
        "verify-archive",
        "--repository",
        str(repository),
        "--manifest",
        str(manifest_path),
        "--archive",
        str(archive),
    )
    assert result.returncode == 0, result.stderr

    repeat_root = tmp_path / "repeat"
    repeat_root.mkdir()
    repeat_repository, repeat_manifest = _create(repeat_root)
    repeat_archive = repeat_root / "candidate-repository.zip"
    result = _run(
        "archive",
        "--repository",
        str(repeat_repository),
        "--manifest",
        str(repeat_manifest),
        "--output",
        str(repeat_archive),
    )
    assert result.returncode == 0, result.stderr
    assert manifest_path.read_bytes() == repeat_manifest.read_bytes()
    assert archive.read_bytes() == repeat_archive.read_bytes()

    with zipfile.ZipFile(archive, "a") as bundle:
        bundle.comment = b"unexpected archive metadata"
    result = _run(
        "verify-archive",
        "--repository",
        str(repository),
        "--manifest",
        str(manifest_path),
        "--archive",
        str(archive),
    )
    assert result.returncode != 0
    assert "archive comment is forbidden" in result.stderr


def test_candidate_repository_rejects_tamper_extra_and_unsafe_source(
    tmp_path: Path,
) -> None:
    repository, manifest = _create(tmp_path)
    docs = repository / "antigravity_home_assistant/DOCS.md"
    docs.chmod(0o600)
    result = _run(
        "verify",
        "--repository",
        str(repository),
        "--manifest",
        str(manifest),
    )
    assert result.returncode != 0
    assert "unsafe bundle file mode" in result.stderr

    docs.chmod(0o644)
    docs.write_text(docs.read_text() + "tamper\n")
    result = _run(
        "verify",
        "--repository",
        str(repository),
        "--manifest",
        str(manifest),
    )
    assert result.returncode != 0
    assert "file set or digest differs" in result.stderr

    second = tmp_path / "second"
    second_manifest = tmp_path / "second-manifest.json"
    result = _run(
        "create",
        "--app-directory",
        str(ROOT / "antigravity_home_assistant"),
        "--repository-yaml",
        str(ROOT / "repository.yaml"),
        "--source-sha",
        "not-a-source",
        "--version",
        VERSION,
        "--image",
        IMAGE,
        "--digest",
        DIGEST,
        "--output",
        str(second),
        "--manifest",
        str(second_manifest),
    )
    assert result.returncode != 0
    assert "source SHA" in result.stderr


def test_candidate_repository_refuses_existing_manifest_and_archive_symlink(
    tmp_path: Path,
) -> None:
    output = tmp_path / "refused-repository"
    existing_manifest = tmp_path / "existing-manifest.json"
    existing_manifest.write_text("sentinel\n", encoding="utf-8")
    result = _run(
        "create",
        "--app-directory",
        str(ROOT / "antigravity_home_assistant"),
        "--repository-yaml",
        str(ROOT / "repository.yaml"),
        "--source-sha",
        SOURCE,
        "--version",
        VERSION,
        "--image",
        IMAGE,
        "--digest",
        DIGEST,
        "--output",
        str(output),
        "--manifest",
        str(existing_manifest),
    )
    assert result.returncode != 0
    assert "manifest output already exists" in result.stderr
    assert existing_manifest.read_text(encoding="utf-8") == "sentinel\n"
    assert not output.exists()

    repository_yaml_link = tmp_path / "repository-link.yaml"
    repository_yaml_link.symlink_to(ROOT / "repository.yaml")
    linked_output = tmp_path / "linked-source-repository"
    result = _run(
        "create",
        "--app-directory",
        str(ROOT / "antigravity_home_assistant"),
        "--repository-yaml",
        str(repository_yaml_link),
        "--source-sha",
        SOURCE,
        "--version",
        VERSION,
        "--image",
        IMAGE,
        "--digest",
        DIGEST,
        "--output",
        str(linked_output),
        "--manifest",
        str(tmp_path / "linked-source-manifest.json"),
    )
    assert result.returncode != 0
    assert "unsafe repository.yaml" in result.stderr
    assert not linked_output.exists()

    repository, manifest = _create(tmp_path)
    archive = tmp_path / "candidate-repository.zip"
    assert (
        _run(
            "archive",
            "--repository",
            str(repository),
            "--manifest",
            str(manifest),
            "--output",
            str(archive),
        ).returncode
        == 0
    )
    archive_link = tmp_path / "candidate-repository-link.zip"
    archive_link.symlink_to(archive)
    result = _run(
        "verify-archive",
        "--repository",
        str(repository),
        "--manifest",
        str(manifest),
        "--archive",
        str(archive_link),
    )
    assert result.returncode != 0
    assert "archive is unsafe" in result.stderr


def test_candidate_repository_normalizes_directory_modes_with_restrictive_umask(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "candidate-repository"
    manifest = tmp_path / "candidate-repository-manifest.json"
    result = _run(
        "create",
        "--app-directory",
        str(ROOT / "antigravity_home_assistant"),
        "--repository-yaml",
        str(ROOT / "repository.yaml"),
        "--source-sha",
        SOURCE,
        "--version",
        VERSION,
        "--image",
        IMAGE,
        "--digest",
        DIGEST,
        "--output",
        str(repository),
        "--manifest",
        str(manifest),
        restrictive_umask=True,
    )
    assert result.returncode == 0, result.stderr
    assert repository.stat().st_mode & 0o777 == 0o755
    assert (repository / "antigravity_home_assistant").stat().st_mode & 0o777 == 0o755
    assert (
        repository / "antigravity_home_assistant/translations"
    ).stat().st_mode & 0o777 == 0o755
