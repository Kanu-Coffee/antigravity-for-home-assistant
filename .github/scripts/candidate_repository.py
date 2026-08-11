#!/usr/bin/env python3
"""Create and verify a source-bound Home Assistant candidate repository bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import sys
import zipfile
from pathlib import Path


APP_FILES = (
    "CHANGELOG.md",
    "DOCS.en.md",
    "DOCS.md",
    "README.en.md",
    "README.md",
    "apparmor.txt",
    "config.yaml",
    "icon.png",
    "logo.png",
    "translations/en.yaml",
    "translations/ko.yaml",
)
SOURCE_RE = re.compile(r"[0-9a-f]{40}\Z")
DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
VERSION_RE = re.compile(
    r"(?P<base>[0-9]+\.[0-9]+\.[0-9]+)-candidate\.[1-9][0-9]*\.[1-9][0-9]*\Z"
)
IMAGE = "ghcr.io/kanu-coffee/antigravity-for-home-assistant"
SLUG = "antigravity_home_assistant"


class BundleError(RuntimeError):
    """The candidate repository bundle is unsafe or inconsistent."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise BundleError(message)


def digest_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    path.chmod(0o644)


def read_regular(path: Path, name: str) -> bytes:
    try:
        metadata = path.lstat()
        value = path.read_bytes()
    except OSError as error:
        raise BundleError(f"cannot read {name}: {error}") from error
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, f"unsafe {name}")
    return value


def replace_candidate_version(config: bytes, version: str) -> bytes:
    try:
        text = config.decode("utf-8")
    except UnicodeError as error:
        raise BundleError(f"config.yaml is not UTF-8: {error}") from error
    version_match = VERSION_RE.fullmatch(version)
    require(version_match is not None, "invalid candidate rehearsal version")
    base_version = version_match.group("base")
    source_version_pattern = rf'^version: "{re.escape(base_version)}"$'
    matches = re.findall(source_version_pattern, text, flags=re.MULTILINE)
    require(len(matches) == 1, "source config version line is not exact")
    require(
        re.findall(rf"^image: {re.escape(IMAGE)}$", text, flags=re.MULTILINE)
        == [f"image: {IMAGE}"],
        "source config image is not exact",
    )
    return re.sub(
        source_version_pattern,
        f'version: "{version}"',
        text,
        count=1,
        flags=re.MULTILINE,
    ).encode()


def bundle_files(root: Path) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        metadata = path.lstat()
        require(not path.is_symlink(), f"bundle contains symbolic link: {relative}")
        if path.is_dir():
            require(stat.S_IMODE(metadata.st_mode) == 0o755, f"unsafe directory mode: {relative}")
            continue
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, f"unsafe bundle file: {relative}")
        require(stat.S_IMODE(metadata.st_mode) == 0o644, f"unsafe bundle file mode: {relative}")
        value = path.read_bytes()
        records.append(
            {
                "path": relative,
                "size": len(value),
                "sha256": digest_bytes(value),
                "mode": "0644",
            }
        )
    return records


def create(args: argparse.Namespace) -> None:
    require(SOURCE_RE.fullmatch(args.source_sha) is not None, "invalid candidate source SHA")
    require(DIGEST_RE.fullmatch(args.digest) is not None, "invalid candidate manifest digest")
    require(VERSION_RE.fullmatch(args.version) is not None, "invalid candidate rehearsal version")
    require(args.image == IMAGE, "unexpected candidate image")
    require(not args.output.exists() and not args.output.is_symlink(), "output already exists")
    require(not args.manifest.exists() and not args.manifest.is_symlink(), "manifest output already exists")
    output_path = args.output.resolve(strict=False)
    manifest_path = args.manifest.resolve(strict=False)
    require(
        manifest_path != output_path and output_path not in manifest_path.parents,
        "manifest output must be outside the candidate repository",
    )
    try:
        app_metadata = args.app_directory.lstat()
    except OSError as error:
        raise BundleError(f"cannot read App directory: {error}") from error
    require(stat.S_ISDIR(app_metadata.st_mode), "unsafe App directory")
    app_directory = args.app_directory
    repository_yaml = args.repository_yaml
    repository_bytes = read_regular(repository_yaml, "repository.yaml")
    app_values: dict[str, bytes] = {}
    for relative in APP_FILES:
        value = read_regular(app_directory / relative, f"App file {relative}")
        if relative == "config.yaml":
            value = replace_candidate_version(value, args.version)
        app_values[relative] = value

    args.output.mkdir(mode=0o755, parents=False)
    args.output.chmod(0o755)
    app_output = args.output / SLUG
    translations_output = app_output / "translations"
    app_output.mkdir(mode=0o755)
    app_output.chmod(0o755)
    translations_output.mkdir(mode=0o755)
    translations_output.chmod(0o755)

    (args.output / "repository.yaml").write_bytes(repository_bytes)
    (args.output / "repository.yaml").chmod(0o644)
    for relative, value in app_values.items():
        target = app_output / relative
        target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        target.parent.chmod(0o755)
        target.write_bytes(value)
        target.chmod(0o644)

    binding = {
        "schema": "antigravity-ha-candidate-repository-binding/v1",
        "source_sha": args.source_sha,
        "version": args.version,
        "image": args.image,
        "manifest_digest": args.digest,
    }
    write_json(args.output / "candidate-binding.json", binding)
    records = bundle_files(args.output)
    manifest = {
        "schema": "antigravity-ha-candidate-repository-manifest/v1",
        "source_sha": args.source_sha,
        "version": args.version,
        "image": args.image,
        "manifest_digest": args.digest,
        "files": records,
    }
    write_json(args.manifest, manifest)
    verify_bundle(args.output, args.manifest)


def load_manifest(path: Path) -> dict[str, object]:
    try:
        value = json.loads(read_regular(path, "candidate repository manifest"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise BundleError(f"candidate repository manifest is invalid: {error}") from error
    require(isinstance(value, dict), "candidate repository manifest is not an object")
    require(
        set(value) == {"schema", "source_sha", "version", "image", "manifest_digest", "files"},
        "candidate repository manifest keys are not exact",
    )
    require(value.get("schema") == "antigravity-ha-candidate-repository-manifest/v1", "wrong candidate repository manifest schema")
    require(SOURCE_RE.fullmatch(str(value.get("source_sha", ""))) is not None, "invalid manifest source SHA")
    require(VERSION_RE.fullmatch(str(value.get("version", ""))) is not None, "invalid manifest version")
    require(value.get("image") == IMAGE, "invalid manifest image")
    require(DIGEST_RE.fullmatch(str(value.get("manifest_digest", ""))) is not None, "invalid image manifest digest")
    require(isinstance(value.get("files"), list), "manifest file records are not an array")
    return value


def verify_bundle(root: Path, manifest_path: Path) -> dict[str, object]:
    try:
        root_metadata = root.lstat()
    except OSError as error:
        raise BundleError(f"cannot read candidate repository root: {error}") from error
    require(
        stat.S_ISDIR(root_metadata.st_mode)
        and stat.S_IMODE(root_metadata.st_mode) == 0o755,
        "candidate repository root is unsafe",
    )
    manifest = load_manifest(manifest_path)
    actual_records = bundle_files(root)
    require(manifest["files"] == actual_records, "candidate repository file set or digest differs")
    config = read_regular(root / SLUG / "config.yaml", "candidate config").decode("utf-8")
    require(
        re.findall(
            rf'^version: "{re.escape(str(manifest["version"]))}"$',
            config,
            flags=re.MULTILINE,
        )
        == [f'version: "{manifest["version"]}"'],
        "candidate config version differs from manifest",
    )
    require(
        re.findall(rf"^image: {re.escape(IMAGE)}$", config, flags=re.MULTILINE)
        == [f"image: {IMAGE}"],
        "candidate config image differs from manifest",
    )
    binding = json.loads(read_regular(root / "candidate-binding.json", "candidate binding"))
    require(
        binding
        == {
            "schema": "antigravity-ha-candidate-repository-binding/v1",
            "source_sha": manifest["source_sha"],
            "version": manifest["version"],
            "image": manifest["image"],
            "manifest_digest": manifest["manifest_digest"],
        },
        "candidate repository binding differs from manifest",
    )
    return manifest


def verify(args: argparse.Namespace) -> None:
    result = verify_bundle(args.repository, args.manifest)
    print(json.dumps(result, sort_keys=True))


def expected_archive_members(
    repository: Path, manifest_path: Path
) -> dict[str, bytes]:
    manifest = verify_bundle(repository, manifest_path)
    members = {
        "candidate-repository-manifest.json": read_regular(
            manifest_path, "candidate repository manifest"
        )
    }
    for record in manifest["files"]:
        relative = str(record["path"])
        members[f"candidate-repository/{relative}"] = read_regular(
            repository / relative,
            f"candidate repository file {relative}",
        )
    return members


def archive(args: argparse.Namespace) -> None:
    require(not args.output.exists() and not args.output.is_symlink(), "archive output already exists")
    members = expected_archive_members(args.repository, args.manifest)
    with zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_STORED) as bundle:
        for name in sorted(members):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_STORED
            bundle.writestr(info, members[name])
    args.output.chmod(0o644)


def verify_archive(args: argparse.Namespace) -> None:
    expected = expected_archive_members(args.repository, args.manifest)
    try:
        archive_metadata = args.archive.lstat()
        require(
            stat.S_ISREG(archive_metadata.st_mode)
            and archive_metadata.st_nlink == 1,
            "candidate repository archive is unsafe",
        )
        with zipfile.ZipFile(args.archive) as bundle:
            require(bundle.comment == b"", "candidate repository archive comment is forbidden")
            infos = bundle.infolist()
            require(
                [info.filename for info in infos] == sorted(expected),
                "candidate repository archive member set is not exact",
            )
            for info in infos:
                require(
                    info.create_system == 3
                    and info.external_attr >> 16 == 0o100644
                    and info.date_time == (1980, 1, 1, 0, 0, 0)
                    and info.compress_type == zipfile.ZIP_STORED
                    and info.flag_bits == 0
                    and info.extra == b""
                    and info.comment == b"",
                    f"unsafe candidate repository archive metadata: {info.filename}",
                )
                require(
                    bundle.read(info.filename) == expected[info.filename],
                    f"candidate repository archive content differs: {info.filename}",
                )
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        raise BundleError(f"cannot read candidate repository archive: {error}") from error


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    commands = result.add_subparsers(dest="command", required=True)
    create_parser = commands.add_parser("create")
    create_parser.add_argument("--app-directory", type=Path, required=True)
    create_parser.add_argument("--repository-yaml", type=Path, required=True)
    create_parser.add_argument("--source-sha", required=True)
    create_parser.add_argument("--version", required=True)
    create_parser.add_argument("--image", required=True)
    create_parser.add_argument("--digest", required=True)
    create_parser.add_argument("--output", type=Path, required=True)
    create_parser.add_argument("--manifest", type=Path, required=True)
    create_parser.set_defaults(handler=create)
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--repository", type=Path, required=True)
    verify_parser.add_argument("--manifest", type=Path, required=True)
    verify_parser.set_defaults(handler=verify)
    archive_parser = commands.add_parser("archive")
    archive_parser.add_argument("--repository", type=Path, required=True)
    archive_parser.add_argument("--manifest", type=Path, required=True)
    archive_parser.add_argument("--output", type=Path, required=True)
    archive_parser.set_defaults(handler=archive)
    verify_archive_parser = commands.add_parser("verify-archive")
    verify_archive_parser.add_argument("--repository", type=Path, required=True)
    verify_archive_parser.add_argument("--manifest", type=Path, required=True)
    verify_archive_parser.add_argument("--archive", type=Path, required=True)
    verify_archive_parser.set_defaults(handler=verify_archive)
    return result


def main() -> int:
    try:
        args = parser().parse_args()
        args.handler(args)
    except (BundleError, OSError, UnicodeError, json.JSONDecodeError) as error:
        print(f"candidate repository failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
