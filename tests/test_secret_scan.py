import re
import subprocess
from pathlib import Path


TEXT_SUFFIXES = {
    "",
    ".conf",
    ".cjs",
    ".json",
    ".jsonc",
    ".js",
    ".jsx",
    ".md",
    ".mjs",
    ".mts",
    ".py",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}

MAX_HISTORY_TEXT_BYTES = 16 * 1024 * 1024
HISTORY_ALLOWED_FINDINGS = {
    # Historical test fixture that verifies rejection of an intentionally fake
    # key-shaped value. Keep the exact immutable blob allowlisted, not its text.
    ("88354c90c82cb52b262d9f112dfb569ad1187bbf", "OpenAI API key"),
}

FORBIDDEN_GENERATED_DIRECTORIES = {
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    "coverage",
    "node_modules",
}
FORBIDDEN_BUILD_DIRECTORIES = {"build", "dist"}
FORBIDDEN_ARTIFACT_SUFFIXES = {
    ".apk",
    ".deb",
    ".log",
    ".pyc",
    ".pyo",
    ".tar",
    ".tgz",
    ".whl",
    ".zip",
    ".zst",
}
FORBIDDEN_RUNTIME_MATERIAL_NAMES = {
    ".env",
    "home-assistant-browser.token",
    "options.json",
    "supervisor.token",
}


def secret_patterns(
    *, include_control_characters: bool = True
) -> dict[str, re.Pattern[str]]:
    private_key_marker = "-----BEGIN " + r"(?:OPENSSH|RSA|EC) PRIVATE KEY-----"
    patterns = {
        "private key": re.compile(private_key_marker),
        "OpenAI API key": re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b"),
        "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
        "JWT access token": re.compile(
            r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"
        ),
    }
    if include_control_characters:
        patterns["unexpected control character"] = re.compile(
            r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]"
        )
    return patterns


def is_repository_text_path(path: Path) -> bool:
    return path.suffix.lower() in TEXT_SUFFIXES or path.name == "Dockerfile"


def repository_files(repository_root: Path):
    result = subprocess.run(
        [
            "git",
            "-c",
            f"safe.directory={repository_root}",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        cwd=repository_root,
        check=True,
        capture_output=True,
        text=True,
    )
    for relative_path in result.stdout.split("\0"):
        if not relative_path:
            continue
        path = repository_root / relative_path
        if path.is_file():
            yield path


def repository_text_files(repository_root: Path):
    for path in repository_files(repository_root):
        if is_repository_text_path(path):
            yield path


def test_no_runtime_secret_files_are_present(repository_root: Path) -> None:
    forbidden_names = {"auth.json", "authorized_keys", "secrets.yaml"}
    forbidden_files = [
        str(path.relative_to(repository_root))
        for path in repository_files(repository_root)
        if path.name in forbidden_names
    ]
    private_host_keys = [
        str(path.relative_to(repository_root))
        for path in repository_files(repository_root)
        if path.name.startswith("ssh_host_") and path.name.endswith("_key")
    ]

    assert forbidden_files == []
    assert private_host_keys == []


def test_no_generated_build_or_runtime_artifacts_are_present(
    repository_root: Path,
) -> None:
    findings: list[str] = []
    for path in repository_files(repository_root):
        relative = path.relative_to(repository_root)
        parts = set(relative.parts)
        if parts & FORBIDDEN_GENERATED_DIRECTORIES:
            findings.append(f"{relative}: generated dependency/cache directory")
            continue
        if parts & FORBIDDEN_BUILD_DIRECTORIES:
            findings.append(f"{relative}: generated build directory")
            continue
        if path.suffix.lower() in FORBIDDEN_ARTIFACT_SUFFIXES:
            findings.append(f"{relative}: generated binary/archive artifact")
            continue
        if path.name in FORBIDDEN_RUNTIME_MATERIAL_NAMES:
            findings.append(f"{relative}: runtime credential/options material")

    assert findings == []


def test_no_common_secret_patterns_are_committed(repository_root: Path) -> None:
    findings: list[str] = []

    for path in repository_text_files(repository_root):
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for label, pattern in secret_patterns().items():
            if pattern.search(content):
                findings.append(f"{path.relative_to(repository_root)}: {label}")

    assert findings == []


def test_no_common_secret_patterns_in_git_history(
    repository_root: Path,
) -> None:
    commits = subprocess.run(
        [
            "git",
            "-c",
            f"safe.directory={repository_root}",
            "rev-list",
            "--all",
        ],
        cwd=repository_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    assert commits

    blobs: dict[str, set[str]] = {}
    for commit in commits:
        tree = subprocess.run(
            [
                "git",
                "-c",
                f"safe.directory={repository_root}",
                "ls-tree",
                "-r",
                "-z",
                "--full-tree",
                commit,
            ],
            cwd=repository_root,
            check=True,
            capture_output=True,
        ).stdout
        for raw_entry in tree.split(b"\0"):
            if not raw_entry:
                continue
            metadata, raw_path = raw_entry.split(b"\t", maxsplit=1)
            _mode, object_type, object_id = metadata.decode("ascii").split()
            path = raw_path.decode("utf-8", errors="surrogateescape")
            if object_type != "blob" or not is_repository_text_path(Path(path)):
                continue
            blobs.setdefault(object_id, set()).add(path)

    findings: list[str] = []
    for object_id, paths in blobs.items():
        size = int(
            subprocess.run(
                [
                    "git",
                    "-c",
                    f"safe.directory={repository_root}",
                    "cat-file",
                    "-s",
                    object_id,
                ],
                cwd=repository_root,
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        )
        label_path = sorted(paths)[0]
        if size > MAX_HISTORY_TEXT_BYTES:
            findings.append(
                f"{label_path}@{object_id[:12]}: historical text blob exceeds scan limit"
            )
            continue
        raw = subprocess.run(
            [
                "git",
                "-c",
                f"safe.directory={repository_root}",
                "cat-file",
                "blob",
                object_id,
            ],
            cwd=repository_root,
            check=True,
            capture_output=True,
        ).stdout
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for label, pattern in secret_patterns(
            include_control_characters=False
        ).items():
            if pattern.search(content):
                if (object_id, label) not in HISTORY_ALLOWED_FINDINGS:
                    findings.append(f"{label_path}@{object_id[:12]}: {label}")

    assert findings == []
