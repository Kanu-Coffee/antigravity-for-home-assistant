"""Contracts separating host development from the HA App runtime."""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import tomllib
from pathlib import Path


DEVELOPMENT_GUIDANCE = "AGENTS.md"
RUNTIME_GUIDANCE = (
    "antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/AGENTS.md"
)
DEVELOPMENT_FILES = {
    DEVELOPMENT_GUIDANCE,
    ".codex/config.toml",
    "tools/development/setup",
    "tools/development/ha-memory-mcp",
    "tools/development/ha-feedback",
    "tools/development/memory-mcp-probe.mjs",
    ".agents/skills/ha-feedback-development/SKILL.md",
    "docs/local-development.md",
}
READ_ONLY_MEMORY_TOOLS = {"memory_search", "memory_status"}
PINNED_IMAGE = re.compile(
    r"ghcr\.io/kanu-coffee/antigravity-for-home-assistant"
    r"@sha256:[0-9a-f]{64}"
)


def _read(root: Path, relative_path: str) -> str:
    return (root / relative_path).read_text(encoding="utf-8")


def _normalized_shell(source: str) -> str:
    return re.sub(r"\s+", " ", source.replace("=", " ")).strip()


def test_host_development_assets_are_complete_and_executable(
    repository_root: Path,
) -> None:
    for relative_path in DEVELOPMENT_FILES:
        path = repository_root / relative_path
        assert path.is_file(), relative_path
        assert path.read_text(encoding="utf-8").strip(), relative_path

    for relative_path in (
        "tools/development/setup",
        "tools/development/ha-memory-mcp",
        "tools/development/ha-feedback",
    ):
        mode = (repository_root / relative_path).stat().st_mode
        assert mode & stat.S_IXUSR, f"{relative_path} is not executable"


def test_host_and_runtime_guidance_are_explicitly_separated(
    repository_root: Path,
) -> None:
    development = _read(repository_root, DEVELOPMENT_GUIDANCE)
    runtime = _read(repository_root, RUNTIME_GUIDANCE)
    ignore = _read(repository_root, ".gitignore")

    normalized_development = " ".join(development.split()).lower()
    for fragment in (
        "host development",
        "not running inside",
        "live home assistant app",
        "tools/development/ha-feedback",
        "memory_search",
        "memory_status",
        "rootfs/usr/local/share/antigravity-ha/agents.md",
    ):
        assert fragment in normalized_development
    for forbidden_claim in (
        "write all of `/config`",
        "production administrator access",
        "/data/antigravity-ha-memory/memory.sqlite3",
    ):
        assert forbidden_claim not in development

    for fragment in (
        "runs inside a live Home Assistant App",
        "Treat that access as production administrator access",
        "/data/antigravity-ha-memory/memory.sqlite3",
        "/usr/local/bin/ha-feedback",
        "call `memory_search`",
        "SUPERVISOR_TOKEN",
    ):
        assert fragment in runtime
    assert "tools/development" not in runtime
    assert "host development" not in runtime.lower()
    assert "AGENTS.override.md" not in ignore
    assert not (repository_root / "AGENTS.override.md").exists()
    assert not (repository_root / "tools/development/host-AGENTS.override.md").exists()


def test_project_codex_config_enables_only_read_only_memory_tools(
    repository_root: Path,
) -> None:
    config = tomllib.loads(_read(repository_root, ".codex/config.toml"))
    servers = config.get("mcp_servers")
    assert isinstance(servers, dict)
    assert len(servers) == 1
    server_name, server = next(iter(servers.items()))
    assert server_name.startswith("ha_memory")
    assert isinstance(server, dict)
    assert server.get("command") == "/bin/bash"
    assert server.get("args") == ["tools/development/ha-memory-mcp"]
    assert server.get("cwd") == "."
    assert server.get("required") is False
    assert 1 <= server.get("startup_timeout_sec", 0) <= 30
    assert 1 <= server.get("tool_timeout_sec", 0) <= 60
    assert set(server.get("enabled_tools", ())) == READ_ONLY_MEMORY_TOOLS
    assert len(server["enabled_tools"]) == len(READ_ONLY_MEMORY_TOOLS)

    serialized = repr(server).lower()
    for forbidden in (
        "memory_remember_explicit",
        "memory_propose",
        "memory_apply_candidate",
        "memory_begin_change",
        "memory_verify_change",
        "memory_rollback",
        "supervisor_token",
    ):
        assert forbidden not in serialized


def test_setup_is_repository_scoped(repository_root: Path) -> None:
    setup = _read(repository_root, "tools/development/setup")
    memory = _read(repository_root, "tools/development/ha-memory-mcp")
    for required in (
        "check",
        "install",
        "AGENTS.md",
        "memory-mcp-probe.mjs",
    ):
        assert required in setup
    for forbidden in (
        "/usr/local/bin",
        "$HOME/.codex",
        "~/.codex",
        "sudo ",
        "git config --global",
    ):
        assert forbidden not in setup
    assert "AGENTS.override.md" not in setup
    assert set(PINNED_IMAGE.findall(setup)) == set(PINNED_IMAGE.findall(memory))


def test_development_memory_wrapper_is_digest_pinned_and_hardened(
    repository_root: Path,
) -> None:
    memory = _read(repository_root, "tools/development/ha-memory-mcp")
    assert memory.startswith("#!/usr/bin/env bash\n")
    assert "set -Eeuo pipefail" in memory
    assert len(set(PINNED_IMAGE.findall(memory))) == 1
    normalized = _normalized_shell(memory)
    for option in (
        "--rm",
        "--pull never",
        "--network none",
        "--read-only",
        "--cap-drop ALL",
    ):
        assert option in normalized
    assert re.search(
        r"--security-opt\s+no-new-privileges(?::true)?", normalized
    )
    assert re.search(r"(?:^|\s)(?:-i|--interactive)(?:\s|$)", memory)
    assert "/usr/local/bin/ha-memory-mcp" in memory
    assert "HA_TELEGRAM_USER_ID=1" in memory
    assert "HA_TELEGRAM_CHAT_ID=1" in memory
    assert "type=volume" in memory and "volume-nocopy" in memory
    for forbidden in (
        "--privileged",
        "--network host",
        "/var/run/docker.sock",
        "SUPERVISOR_TOKEN=",
        "/config:",
        "/run/antigravity-ha",
    ):
        assert forbidden not in memory


def test_feedback_wrapper_runs_current_source_in_an_isolated_container(
    repository_root: Path,
) -> None:
    feedback = _read(repository_root, "tools/development/ha-feedback")
    assert feedback.startswith("#!/usr/bin/env bash\n")
    assert "set -Eeuo pipefail" in feedback
    assert "HA_FEEDBACK_TEST_MODE" in feedback
    assert "rootfs/usr/local/share/antigravity-ha/ha-feedback.mjs" in feedback
    assert len(set(PINNED_IMAGE.findall(feedback))) == 1
    normalized = _normalized_shell(feedback)
    for option in (
        "--rm",
        "--pull never",
        "--network none",
        "--read-only",
        "--cap-drop ALL",
    ):
        assert option in normalized
    assert re.search(
        r"--security-opt\s+no-new-privileges(?::true)?", normalized
    )
    assert "--entrypoint /usr/bin/env" in normalized
    assert " -i " in f" {normalized} "
    for allowed_command in ("collect", "validate", "render"):
        assert allowed_command in feedback
    for forbidden in (
        "gh issue",
        "--privileged",
        "SUPERVISOR_TOKEN=",
        "GH_TOKEN=",
        "GITHUB_TOKEN=",
    ):
        assert forbidden not in feedback

    memory = _read(repository_root, "tools/development/ha-memory-mcp")
    assert set(PINNED_IMAGE.findall(feedback)) == set(PINNED_IMAGE.findall(memory))


def test_feedback_development_skill_cannot_submit(
    repository_root: Path,
) -> None:
    skill = _read(
        repository_root,
        ".agents/skills/ha-feedback-development/SKILL.md",
    )
    assert "TODO" not in skill
    assert "Structuring This Skill" not in skill
    normalized = " ".join(skill.split()).lower()
    for fragment in (
        "ha-feedback-development",
        "tools/development/ha-feedback",
        "test mode",
        "collect",
        "validate",
        "render",
    ):
        assert fragment in normalized
    for forbidden_instruction in (
        "gh issue create",
        "github submit --confirm",
        "/usr/local/bin/ha-feedback",
    ):
        assert forbidden_instruction not in normalized
    assert re.search(r"github.{0,80}(?:reject|forbid|disabled|unavailable)", normalized)


def test_feedback_development_wrapper_rejects_github_before_helper(
    repository_root: Path,
) -> None:
    environment = os.environ.copy()
    for arguments in (
        ("github", "status"),
        ("github", "login"),
        ("github", "url", "report.json"),
        ("github", "submit", "report.json"),
    ):
        result = subprocess.run(
            [str(repository_root / "tools/development/ha-feedback"), *arguments],
            cwd=repository_root,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
        )
        assert result.returncode != 0, arguments
        assert "github" in result.stderr.lower(), arguments


def test_feedback_wrapper_mounts_only_reviewed_development_inputs(
    repository_root: Path,
    tmp_path: Path,
) -> None:
    invocation = tmp_path / "docker-arguments"
    docker = tmp_path / "docker"
    docker.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' \"$@\" > {invocation}\n",
        encoding="utf-8",
    )
    docker.chmod(0o755)
    input_path = tmp_path / "input.json"
    input_path.write_text("{}\n", encoding="utf-8")
    input_path.chmod(0o600)

    environment = os.environ.copy()
    environment["ANTIGRAVITY_HA_DEV_TEST_MODE"] = "1"
    environment["ANTIGRAVITY_HA_DEV_DOCKER_BIN"] = str(docker)
    environment["ANTIGRAVITY_HA_DEV_FEEDBACK_STATE_ROOT"] = str(
        tmp_path / "feedback-state"
    )
    result = subprocess.run(
        [
            str(repository_root / "tools/development/ha-feedback"),
            "collect",
            "bug",
            "--input",
            str(input_path),
        ],
        cwd=repository_root,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    arguments = invocation.read_text(encoding="utf-8").splitlines()
    joined = " ".join(arguments)
    for option in (
        "--pull never",
        "--network none",
        "--read-only",
        "--cap-drop ALL",
        "no-new-privileges:true",
    ):
        assert option in joined
    assert str(input_path.resolve()) in joined
    assert "ha-feedback.mjs" in joined
    assert str(tmp_path / "feedback-state") in joined
    for forbidden in (
        "/var/run/docker.sock",
        "/run/antigravity-ha",
        "SUPERVISOR_TOKEN",
        "GITHUB_TOKEN",
        "GH_TOKEN",
    ):
        assert forbidden not in joined


def test_memory_wrapper_test_hook_preserves_the_sandbox(
    repository_root: Path,
    tmp_path: Path,
) -> None:
    invocation = tmp_path / "docker-arguments"
    docker = tmp_path / "docker"
    docker.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' \"$@\" > {invocation}\n",
        encoding="utf-8",
    )
    docker.chmod(0o755)

    environment = os.environ.copy()
    environment["ANTIGRAVITY_HA_DEV_TEST_MODE"] = "1"
    environment["ANTIGRAVITY_HA_DEV_DOCKER_BIN"] = str(docker)
    environment["ANTIGRAVITY_HA_DEV_MEMORY_VOLUME"] = "antigravity-ha-contract-test"
    wrapper = repository_root / "tools/development/ha-memory-mcp"
    result = subprocess.run(
        [str(wrapper)],
        cwd=repository_root,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=10,
    )
    assert result.returncode == 0, result.stderr

    arguments = invocation.read_text(encoding="utf-8").splitlines()
    joined = " ".join(arguments).replace("=", " ")
    assert arguments[0] == "run"
    for option in (
        "--rm",
        "--pull never",
        "--network none",
        "--read-only",
        "--cap-drop ALL",
    ):
        assert option in joined
    assert "--interactive" in arguments or "-i" in arguments
    assert re.search(r"--security-opt\s+no-new-privileges(?::true)?", joined)
    assert any(PINNED_IMAGE.fullmatch(argument) for argument in arguments)
    assert "/usr/local/bin/ha-memory-mcp" in joined
    assert "HA_TELEGRAM_USER_ID" in joined
    assert "HA_TELEGRAM_CHAT_ID" in joined
    assert "/var/run/docker.sock" not in joined
    assert "/config" not in joined

    invocation.unlink()
    rejected = subprocess.run(
        [str(wrapper), "unexpected"],
        cwd=repository_root,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=10,
    )
    assert rejected.returncode == 64
    assert not invocation.exists(), "invalid arguments reached Docker"


def test_development_docker_override_requires_explicit_test_mode(
    repository_root: Path,
    tmp_path: Path,
) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    path_marker = tmp_path / "path-docker"
    override_marker = tmp_path / "override-docker"

    path_docker = fake_bin / "docker"
    path_docker.write_text(
        f"#!/bin/sh\n: > {path_marker}\nexit 70\n",
        encoding="utf-8",
    )
    path_docker.chmod(0o755)
    override_docker = tmp_path / "override"
    override_docker.write_text(
        f"#!/bin/sh\n: > {override_marker}\nexit 71\n",
        encoding="utf-8",
    )
    override_docker.chmod(0o755)

    environment = os.environ.copy()
    environment.pop("ANTIGRAVITY_HA_DEV_TEST_MODE", None)
    environment["ANTIGRAVITY_HA_DEV_DOCKER_BIN"] = str(override_docker)
    environment["PATH"] = f"{fake_bin}:{environment.get('PATH', '')}"
    result = subprocess.run(
        [str(repository_root / "tools/development/ha-memory-mcp")],
        cwd=repository_root,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=10,
    )
    assert result.returncode != 0
    assert not override_marker.exists(), "test-only Docker override escaped test mode"


def test_setup_prepares_tools_without_creating_instruction_files(
    repository_root: Path,
    tmp_path: Path,
) -> None:
    checkout = tmp_path / "checkout"
    shutil.copytree(repository_root / "tools", checkout / "tools")
    shutil.copytree(repository_root / ".codex", checkout / ".codex")
    shutil.copy2(repository_root / ".gitignore", checkout / ".gitignore")
    shutil.copy2(repository_root / "AGENTS.md", checkout / "AGENTS.md")
    addon = checkout / "antigravity_home_assistant"
    addon.mkdir()
    shutil.copy2(
        repository_root / "antigravity_home_assistant/config.yaml",
        addon / "config.yaml",
    )
    subprocess.run(
        ["git", "init", "--quiet"],
        cwd=checkout,
        check=True,
        capture_output=True,
        timeout=10,
    )

    setup = checkout / "tools/development/setup"
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    docker_marker = tmp_path / "docker-was-called"
    fake_docker = fake_bin / "docker"
    fake_docker.write_text(
        f"#!/bin/sh\n: > {docker_marker}\nexit 0\n",
        encoding="utf-8",
    )
    fake_docker.chmod(0o755)
    environment = os.environ.copy()
    environment["PATH"] = f"{fake_bin}:{environment.get('PATH', '')}"
    environment["ANTIGRAVITY_HA_DEV_TEST_MODE"] = "1"
    environment["ANTIGRAVITY_HA_DEV_DOCKER_BIN"] = str(fake_docker)
    for _ in range(2):
        result = subprocess.run(
            [str(setup), "install"],
            cwd=checkout,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
        )
        assert result.returncode == 0, result.stderr
        assert not (checkout / "AGENTS.override.md").exists()
        assert (checkout / "AGENTS.md").read_bytes() == (
            repository_root / "AGENTS.md"
        ).read_bytes()

    invalid = subprocess.run(
        [str(setup), "unknown"],
        cwd=checkout,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=10,
    )
    assert invalid.returncode == 64


def test_memory_probe_is_deterministic_and_fail_closed(
    repository_root: Path,
) -> None:
    source = _read(repository_root, "tools/development/memory-mcp-probe.mjs")
    normalized = " ".join(source.split())

    for tool in sorted(READ_ONLY_MEMORY_TOOLS):
        assert tool in source
    for nondeterministic_source in (
        "Date.now(",
        "new Date(",
        "Math.random(",
        "randomUUID(",
        "fetch(",
        "http://",
        "https://",
    ):
        assert nondeterministic_source not in source

    assert "tools/list" in source
    assert re.search(r"memory_search.*memory_status|memory_status.*memory_search", normalized)
    assert re.search(r"unexpected|exact|mismatch|equal", source, re.IGNORECASE)
    assert "spawn(" in source
    assert "memory-mcp-probe.mjs" in _read(
        repository_root, "tools/development/setup"
    )


def test_local_development_documentation_states_the_boundary(
    repository_root: Path,
) -> None:
    documentation = " ".join(
        _read(repository_root, "docs/local-development.md").split()
    ).lower()
    for fragment in (
        "tools/development/setup",
        "root `agents.md`",
        "rootfs/usr/local/share/antigravity-ha/agents.md",
        "new codex session",
        "memory_search",
        "memory_status",
        "read-only",
        "ha-feedback",
        "test mode",
        "github",
        "haos",
    ):
        assert fragment in documentation
