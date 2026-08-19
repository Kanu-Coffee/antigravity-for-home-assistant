import json
import os
import stat
import subprocess
from pathlib import Path


def test_file_mcp_runtime_is_image_managed_and_syntax_checked(
    repository_root: Path, rootfs: Path, addon_root: Path
) -> None:
    wrapper = rootfs / "usr/local/bin/ha-files-mcp"
    source = rootfs / "usr/local/share/antigravity-ha/ha-files-mcp.py"
    assert wrapper.is_file() and source.is_file()
    assert wrapper.read_text(encoding="utf-8").splitlines()[:4] == [
        "#!/bin/bash -p",
        "set -Eeuo pipefail",
        "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN",
        "unset PYTHONHOME PYTHONPATH",
    ]
    assert "exec /usr/bin/env -i" in wrapper.read_text(encoding="utf-8")
    assert "/usr/bin/python3 -I -B -u" in wrapper.read_text(encoding="utf-8")
    if os.name != "nt":
        assert wrapper.stat().st_mode & stat.S_IXUSR
    subprocess.run(
        ["python3", "-m", "py_compile", str(source)],
        cwd=repository_root,
        check=True,
        env={
            "HOME": "/tmp",
            "LANG": "C.UTF-8",
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "PYTHONPYCACHEPREFIX": "/tmp/antigravity-ha-files-pycache",
        },
    )
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    assert "/usr/local/share/antigravity-ha/ha-files-mcp.py" in dockerfile


def test_managed_plugin_registers_only_the_image_file_mcp(rootfs: Path) -> None:
    plugin_path = (
        rootfs
        / "usr/local/share/antigravity-ha/plugins/home-assistant/mcp_config.json"
    )
    plugin = json.loads(plugin_path.read_text(encoding="utf-8"))
    server = plugin["mcpServers"]["ha_files"]
    assert server == {
        "command": "/usr/local/bin/ha-files-mcp",
        "args": [],
        "cwd": "/config",
    }


def test_file_mcp_source_has_descriptor_relative_fail_closed_operations(
    rootfs: Path,
) -> None:
    source = (
        rootfs / "usr/local/share/antigravity-ha/ha-files-mcp.py"
    ).read_text(encoding="utf-8")
    for required in (
        '"/config": "config"',
        '"/share": "ordinary"',
        '"/media": "ordinary"',
        '"/data/home": "home"',
        '"/tmp": "ordinary"',
        '"/var/tmp": "ordinary"',
        "os.O_NOFOLLOW",
        "dir_fd=descriptor",
        "metadata.st_nlink == 1",
        "_same_snapshot(before, after)",
        "_RENAME_EXCHANGE",
        "os.O_CREAT | os.O_EXCL",
        "os.fsync(temporary_descriptor)",
        '".gemini" in lowered',
        "_restore_exchange(",
        '".storage"',
        '"secrets.yaml"',
        "_is_recorder_path",
        '"ha_files_read_text"',
        '"ha_files_list"',
        '"ha_files_write_text"',
        "MAX_TEXT_BYTES = 1024 * 1024",
        "MAX_LIST_ENTRIES = 200",
        "stream.readline(MAX_REQUEST_BYTES + 1)",
        "_bounded_request_lines(sys.stdin.buffer)",
    ):
        assert required in source
    assert "realpath(" not in source
    assert "follow_symlinks=True" not in source


def test_file_mcp_has_a_dedicated_resolved_target_apparmor_boundary(
    addon_root: Path,
) -> None:
    profile = (addon_root / "apparmor.txt").read_text(encoding="utf-8")
    file_client = profile.split(
        "profile antigravity_home_assistant-file-client", maxsplit=1
    )[1].split("profile antigravity_home_assistant-memory", maxsplit=1)[0]
    for transition_owner in (
        "profile antigravity_home_assistant-interactive-runtime-restricted",
        "profile antigravity_home_assistant-interactive-runtime-sensitive-read",
        "profile antigravity_home_assistant-command",
        "profile antigravity_home_assistant-shell",
    ):
        section = profile.split(transition_owner, maxsplit=1)[1].split(
            "\n  profile ", maxsplit=1
        )[0]
        assert (
            "/usr/local/bin/ha-files-mcp Px -> "
            "antigravity_home_assistant-file-client,"
        ) in section
    for broad in (
        "capability dac_override,",
        "/data/home/** rwkl,",
        "/config/** rwkl,",
        "/share/** rwkl,",
        "/media/** rwkl,",
        "/tmp/** rwkl,",
        "/var/tmp/** rwkl,",
    ):
        assert broad in file_client
    for denied in (
        "deny /data/home/.gemini/** rwklm,",
        "deny /data/home/.ssh/** rwklm,",
        "deny /data/home/.aws/** rwklm,",
        "deny /data/home/.config/gcloud/** rwklm,",
        "deny /data/home/.pypirc rwklm,",
        "deny /config/secrets.yaml{,.*} rwklm,",
        "deny /config/secrets.yml{,.*} rwklm,",
        "deny /config/.storage/** rwklm,",
        "deny /config/.agents/plugins/home-assistant/** rwklm,",
        "deny /config/{,**/}*.{db,sqlite,sqlite3}{,.*,-*,~} wklm,",
        "deny /run/antigravity-ha/supervisor.token rwklm,",
        "deny /backup/** rwklm,",
        "deny /ssl/** rwklm,",
        "deny /addon_configs/** rwklm,",
        "deny /etc/ssh/ssh_host_* rwklm,",
        "deny /etc/ssl/private/** rwklm,",
        "deny /etc/antigravity/** rwklm,",
    ):
        assert denied in file_client
    assert "/run/antigravity-ha/sensitive-data-access.enabled r," in file_client
    assert "\n  /run/antigravity-ha/sensitive-data-access.enabled w" not in file_client


def test_arbitrary_mcp_children_drop_into_the_credential_blind_command_profile(
    addon_root: Path,
) -> None:
    profile = (addon_root / "apparmor.txt").read_text(encoding="utf-8")
    for runtime_name in (
        "profile antigravity_home_assistant-interactive-runtime-restricted",
        "profile antigravity_home_assistant-interactive-runtime-sensitive-read",
    ):
        runtime = profile.split(runtime_name, maxsplit=1)[1].split(
            "\n  profile ", maxsplit=1
        )[0]
        assert "/usr/bin/** Px -> antigravity_home_assistant-command," in runtime
        assert "/config/** Px -> antigravity_home_assistant-command," in runtime
        assert "/data/home/** Px -> antigravity_home_assistant-command," in runtime
    command = profile.split(
        "profile antigravity_home_assistant-command", maxsplit=1
    )[1].split("\n  profile ", maxsplit=1)[0]
    for denied in (
        "deny /data/home/.gemini/config/mcp_config.json rwklm,",
        "deny /data/home/.gemini/antigravity-cli/settings.json rwklm,",
        "deny /data/home/.gemini/antigravity-cli/oauth* rwklm,",
        "deny /data/home/.gemini/antigravity-cli/*credential* rwklm,",
        "deny /data/home/.gnupg/** rwklm,",
        "deny /data/home/.config/gh/** rwklm,",
        "deny /data/home/.pypirc rwklm,",
        "deny /data/home/.git-credentials rwklm,",
        "deny /root/.aws/** rwklm,",
        "deny /root/.config/gcloud/** rwklm,",
    ):
        assert denied in command
