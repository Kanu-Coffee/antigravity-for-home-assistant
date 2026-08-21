import os
import pty
import re
import select
import signal
import subprocess
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read_until(fd: int, pattern: bytes, timeout: float = 3.0) -> bytes:
    output = b""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and pattern not in output:
        readable, _, _ = select.select([fd], [], [], 0.1)
        if readable:
            try:
                output += os.read(fd, 4096)
            except OSError:
                break
    return output


def test_native_launchers_use_non_inherited_signal_safe_lock_holder() -> None:
    rootfs = ROOT / "antigravity_home_assistant/rootfs"
    guard = (
        rootfs / "usr/local/libexec/antigravity-native-session-guard"
    ).read_text(encoding="utf-8")
    command_wrapper = (
        rootfs / "usr/local/libexec/antigravity-command-bin/bash"
    ).read_text(encoding="utf-8")

    for name, mode in (
        ("antigravity-interactive-restricted", "restricted"),
        ("antigravity-interactive-sensitive-read", "sensitive-read"),
    ):
        launcher = (rootfs / "usr/local/libexec" / name).read_text(
            encoding="utf-8"
        )
        assert "--shared --nonblock --close --conflict-exit-code 75" in launcher
        assert "--ignore-signal=INT --ignore-signal=QUIT" in launcher
        assert "--default-signal=INT --default-signal=QUIT -i" in launcher
        assert "/usr/bin/setpriv --pdeathsig KILL" in launcher
        assert f"antigravity-native-session-guard {mode}" in launcher
        assert "exec 200" not in launcher

    assert "onboarding-active" in guard
    assert "exec /usr/local/libexec/antigravity-native-env -i" in guard
    assert "flock --unlock" not in command_wrapper


def test_signal_safe_flock_holder_preserves_ctrl_c_and_reaps_on_holder_death(
    tmp_path: Path,
) -> None:
    lock_path = tmp_path / "native-session.lock"
    lock_path.touch(mode=0o600)
    holder_pid, master_fd = pty.fork()
    if holder_pid == 0:
        os.execv(
            "/usr/bin/env",
            [
                "env",
                "--ignore-signal=INT",
                "--ignore-signal=QUIT",
                "/usr/bin/flock",
                "--shared",
                "--nonblock",
                "--close",
                "--conflict-exit-code",
                "75",
                str(lock_path),
                "/usr/bin/env",
                "--default-signal=INT",
                "--default-signal=QUIT",
                "-i",
                "PATH=/usr/bin:/bin",
                "/usr/bin/setpriv",
                "--pdeathsig",
                "KILL",
                "/bin/bash",
                "-c",
                (
                    "trap 'printf CHILD_INT\\n' INT; "
                    "printf 'CHILD_READY=%s\\n' \"$$\"; "
                    "while :; do read -r -t 1 _ || :; done"
                ),
            ],
        )

    child_pid = None
    process_group = None
    try:
        output = _read_until(master_fd, b"CHILD_READY=")
        match = re.search(rb"CHILD_READY=([0-9]+)", output)
        assert match is not None, output
        child_pid = int(match.group(1))
        process_group = os.getpgid(holder_pid)

        contender = subprocess.run(
            [
                "/usr/bin/flock",
                "--exclusive",
                "--nonblock",
                "--conflict-exit-code",
                "75",
                str(lock_path),
                "/bin/true",
            ],
            check=False,
        )
        assert contender.returncode == 75

        os.killpg(os.tcgetpgrp(master_fd), signal.SIGINT)
        output += _read_until(master_fd, b"CHILD_INT")
        assert b"CHILD_INT" in output
        assert os.waitpid(holder_pid, os.WNOHANG) == (0, 0)
        os.kill(child_pid, 0)

        os.kill(holder_pid, signal.SIGTERM)
        os.waitpid(holder_pid, 0)
        holder_pid = 0
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and Path(f"/proc/{child_pid}").exists():
            time.sleep(0.05)
        assert not Path(f"/proc/{child_pid}").exists()

        released = subprocess.run(
            [
                "/usr/bin/flock",
                "--exclusive",
                "--nonblock",
                "--conflict-exit-code",
                "75",
                str(lock_path),
                "/bin/true",
            ],
            check=False,
        )
        assert released.returncode == 0
    finally:
        if process_group is not None:
            try:
                os.killpg(process_group, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if holder_pid:
            try:
                os.waitpid(holder_pid, 0)
            except ChildProcessError:
                pass
        os.close(master_fd)
