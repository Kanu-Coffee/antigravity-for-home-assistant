from __future__ import annotations

import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SMOKE = ROOT / "tests/playwright_mcp_smoke.mjs"


def run_early_exit(script: str, *, supervisor_token: str | None = None) -> tuple[int, str]:
    environment = os.environ.copy()
    if supervisor_token is None:
        environment.pop("SUPERVISOR_TOKEN", None)
    else:
        environment["SUPERVISOR_TOKEN"] = supervisor_token
    completed = subprocess.run(
        ["node", str(SMOKE), "/bin/sh", "-c", script],
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )
    return completed.returncode, completed.stdout + completed.stderr


def test_early_child_exit_reports_status_and_stderr_without_epipe_masking() -> None:
    returncode, output = run_early_exit(
        'printf "%s\\n" MCP-EARLY-EXIT >&2; exit 23'
    )

    assert returncode == 1
    assert "MCP server exited early (code=23, signal=null" in output
    assert "MCP-EARLY-EXIT" in output
    assert "Unhandled 'error' event" not in output
    assert "Error: write EPIPE" not in output


def test_early_child_stderr_redacts_the_supervisor_token() -> None:
    token = "mcp-supervisor-token-must-not-appear"
    returncode, output = run_early_exit(
        'printf "%s\\n" "$SUPERVISOR_TOKEN" >&2; exit 24',
        supervisor_token=token,
    )

    assert returncode == 1
    assert "MCP stderr disclosed SUPERVISOR_TOKEN" in output
    assert "[REDACTED_HOME_ASSISTANT_TOKEN]" in output
    assert token not in output


def test_split_stderr_chunks_still_detect_and_redact_the_supervisor_token() -> None:
    token = "mcp-supervisor-token-split-across-chunks"
    returncode, output = run_early_exit(
        'printf "%s" "mcp-supervisor-token-" >&2; '
        'sleep 0.1; printf "%s\\n" "split-across-chunks" >&2; exit 25',
        supervisor_token=token,
    )

    assert returncode == 1
    assert "MCP stderr disclosed SUPERVISOR_TOKEN" in output
    assert "[REDACTED_HOME_ASSISTANT_TOKEN]" in output
    assert token not in output
