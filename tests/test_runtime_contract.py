import json
import os
import re
import stat
import subprocess
from pathlib import Path


S6_ROOT = Path("etc/s6-overlay/s6-rc.d")
S6_SERVICES = {
    "antigravity-ha-init",
    "antigravity-remote",
    "ha-memoryd",
    "ha-read-broker",
    "ttyd",
    "ingress",
}


def test_s6_user_bundle_and_dependency_graph(rootfs: Path) -> None:
    s6_root = rootfs / S6_ROOT
    contents = s6_root / "user/contents.d"
    assert {path.name for path in contents.iterdir()} == S6_SERVICES

    assert (s6_root / "antigravity-ha-init/type").read_text().strip() == "oneshot"
    assert (s6_root / "antigravity-ha-init/up").is_file()
    assert (s6_root / "antigravity-ha-init/dependencies.d/base").is_file()

    for service in S6_SERVICES - {"antigravity-ha-init"}:
        assert (s6_root / service / "type").read_text().strip() == "longrun"

    for service in ("antigravity-remote", "ha-memoryd", "ha-read-broker", "ttyd"):
        assert (s6_root / service / "dependencies.d/antigravity-ha-init").is_file()
    assert (s6_root / "ingress/dependencies.d/ttyd").is_file()


def test_entrypoints_are_executable_and_libraries_are_source_only(rootfs: Path) -> None:
    if os.name == "nt":
        return
    for directory in (rootfs / "usr/local/bin", rootfs / "usr/local/libexec"):
        for entrypoint in directory.iterdir():
            if entrypoint.is_file():
                assert entrypoint.stat().st_mode & stat.S_IXUSR, entrypoint

    for relative_path in (
        "etc/profile.d/antigravity-ha.sh",
        "usr/local/lib/antigravity-ha/api-client.sh",
        "usr/local/lib/antigravity-ha/config.sh",
        "usr/local/lib/antigravity-ha/environment.sh",
        "usr/local/lib/antigravity-ha/supervisor-credential.sh",
    ):
        library = rootfs / relative_path
        assert library.is_file()
        assert not (library.stat().st_mode & stat.S_IXUSR), library


def test_antigravity_1122_is_pinned_for_both_architectures(
    addon_root: Path,
) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    version = re.search(
        r"^ARG ANTIGRAVITY_VERSION=([^\s]+)$", dockerfile, re.MULTILINE
    )
    assert version and version.group(1) == "1.1.22"
    assert "ARG ANTIGRAVITY_BUILD=5711547746615296" in dockerfile
    assert "ARG ANTIGRAVITY_AMD64_SHA512=" in dockerfile
    assert "ARG ANTIGRAVITY_ARM64_SHA512=" in dockerfile
    assert "antigravity_platform=linux-x64" in dockerfile
    assert "antigravity_platform=linux-arm" in dockerfile
    assert dockerfile.count("sha512sum --check --strict -") >= 1
    assert '[[ "${antigravity_version_output}" == "${ANTIGRAVITY_VERSION}" ]]' in (
        dockerfile
    )


def test_native_self_update_is_disabled_at_every_active_boundary(
    addon_root: Path, rootfs: Path
) -> None:
    contract = "AGY_CLI_DISABLE_AUTO_UPDATE=true"
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    assert f"ENV {contract}" in dockerfile

    paths = (
        "usr/local/lib/antigravity-ha/environment.sh",
        "usr/local/bin/antigravity-ha-init",
        "usr/local/libexec/antigravity-interactive-restricted",
        "usr/local/libexec/antigravity-interactive-sensitive-read",
        "usr/local/libexec/antigravity-native-session-guard",
        "usr/local/libexec/ha-antigravity-remote-runtime",
    )
    for relative_path in paths:
        assert contract in (rootfs / relative_path).read_text(encoding="utf-8")

    image_settings = (rootfs / "etc/antigravity/settings.json").read_text(
        encoding="utf-8"
    )
    assert "AUTO_UPDATE" not in image_settings
    assert "autoUpdate" not in image_settings


def test_multi_arch_dependencies_are_pinned_and_verified(addon_root: Path) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    assert "ghcr.io/home-assistant/base-debian:bookworm@sha256:" in dockerfile
    for dependency in ("NODE", "GH", "TTYD"):
        assert f"ARG {dependency}_AMD64_SHA256=" in dockerfile
        assert f"ARG {dependency}_ARM64_SHA256=" in dockerfile
    assert "arm64 | aarch64)" in dockerfile
    assert "node_arch=arm64" in dockerfile
    assert "gh_arch=arm64" in dockerfile
    assert "ttyd_arch=aarch64" in dockerfile
    assert dockerfile.count("sha256sum --check --strict -") >= 3


def test_ingress_is_loopback_ttyd_behind_nginx(rootfs: Path) -> None:
    ttyd_run = (rootfs / S6_ROOT / "ttyd/run").read_text(encoding="utf-8")
    ingress_run = (rootfs / S6_ROOT / "ingress/run").read_text(encoding="utf-8")
    nginx = (rootfs / "etc/nginx/nginx.conf").read_text(encoding="utf-8")
    assert "--interface 127.0.0.1" in ttyd_run
    assert "--port 7682" in ttyd_run
    assert "--writable" in ttyd_run
    assert "exec nginx" in ingress_run
    assert "listen 7681" in nginx
    assert "proxy_pass http://127.0.0.1:7682" in nginx
    assert "proxy_set_header Upgrade $http_upgrade" in nginx


def test_init_uses_v3_reset_defaults_and_retained_services(rootfs: Path) -> None:
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    for required in (
        "v3-factory-reset.mjs",
        "supervisor-options-migrate.mjs",
        "managed-plugin-update.mjs",
        'remote_control_name: "home-assistant"',
        "antigravity_sensitive_data_access: false",
        "home_assistant_browser_auto_auth: true",
        'log_level: "info"',
        "/usr/local/bin/ha-memory init",
        "/usr/local/bin/ha-browser-auth-ensure --quiet",
        "/usr/local/bin/web-terminal-entrypoint --background",
    ):
        assert required in init_script


def test_init_embedded_v3_option_filter_accepts_persisted_options(
    rootfs: Path,
) -> None:
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    match = re.search(
        r"elif ! jq --exit-status '(?P<filter>.*?)'\s+"
        r'/data/options\.json > "\$\{options_tmp\}"',
        init_script,
        re.DOTALL,
    )
    assert match, "the init-owned persisted-option filter was not found"

    for log_level in (
        "trace",
        "debug",
        "info",
        "notice",
        "warning",
        "error",
        "fatal",
    ):
        options = {
            "remote_control_name": "living-room-ha",
            "antigravity_sensitive_data_access": True,
            "home_assistant_browser_auto_auth": False,
            "log_level": log_level,
        }
        result = subprocess.run(
            ["jq", "--exit-status", match.group("filter")],
            input=json.dumps(options),
            check=False,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == options

    invalid = subprocess.run(
        ["jq", "--exit-status", match.group("filter")],
        input=json.dumps({"log_level": "verbose"}),
        check=False,
        capture_output=True,
        text=True,
    )
    assert invalid.returncode != 0


def test_native_plugin_guidance_matches_remote_only_runtime(rootfs: Path) -> None:
    plugin_root = rootfs / "usr/local/share/antigravity-ha/plugins/home-assistant"
    guidance = (plugin_root / "rules/home-assistant-safety.md").read_text(
        encoding="utf-8"
    )
    normalized = " ".join(guidance.lower().split())
    for required in (
        "live home assistant app",
        "diagnosis does not authorize",
        "ha-config-check",
        "native permission",
        "denied",
        "approval-required",
    ):
        assert required in normalized


def test_boolean_option_reader_accepts_explicit_false(rootfs: Path) -> None:
    helpers = (rootfs / "usr/local/lib/antigravity-ha/config.sh").read_text(
        encoding="utf-8"
    )
    reader = helpers.split("antigravity_ha_config_bool()", 1)[1].split(
        "antigravity_ha_config_json()", 1
    )[0]
    assert "jq --raw-output" in reader
    assert "--exit-status" not in reader
    assert "ha-feedback-options.json" in helpers


def test_ingress_terminal_is_fixed_recovery_tmux(rootfs: Path) -> None:
    entrypoint = (rootfs / "usr/local/bin/web-terminal-entrypoint").read_text(
        encoding="utf-8"
    )
    session_shell = (rootfs / "usr/local/bin/tmux-session-shell").read_text(
        encoding="utf-8"
    )
    profile = (rootfs / "etc/profile.d/antigravity-ha.sh").read_text(
        encoding="utf-8"
    )
    assert "export TERM=xterm-256color" in entrypoint
    assert 'readonly session_name=antigravity-ha' in entrypoint
    assert 'new-session -d -s "${session_name}" -c /config' in entrypoint
    assert 'new-session -A -s "${session_name}" -c /config' in entrypoint
    assert "exec /usr/local/libexec/ha-interactive-shell --login" in session_shell
    assert profile.rstrip().endswith("fi")
    assert "\nagy\n" not in profile

    motd = (rootfs / "etc/motd").read_text(encoding="utf-8")
    assert "ha-antigravity-remote-login" in motd
    assert "starts automatically after sign-in" in motd
    assert "ha-antigravity-login" not in motd
    assert "2.1.2" not in motd


def test_ingress_websocket_smoke_uses_only_retained_cli_surfaces(
    repository_root: Path,
) -> None:
    smoke = (repository_root / "tests/ttyd_websocket_smoke.py").read_text(
        encoding="utf-8"
    )
    assert "/usr/local/bin/antigravity" in smoke
    assert "/usr/local/bin/ha-config-check" in smoke
    assert "/usr/local/bin/ha-core-logs" in smoke
    assert "agy-settings" not in smoke


def test_supervisor_credential_is_not_inherited_by_agent_surfaces(
    rootfs: Path,
) -> None:
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    environment = (
        rootfs / "usr/local/lib/antigravity-ha/environment.sh"
    ).read_text(encoding="utf-8")
    assert '"${RUNTIME_DIR}/supervisor.token"' in init_script
    assert 'chmod 0400 "${credential_tmp}"' in init_script
    assert "unset SUPERVISOR_TOKEN" in environment

    for service in ("antigravity-remote", "ttyd", "ingress", "ha-memoryd"):
        run = (rootfs / S6_ROOT / service / "run").read_text(encoding="utf-8")
        assert "unset SUPERVISOR_TOKEN" in run
    read_wrapper = (rootfs / "usr/local/bin/ha-read-broker").read_text(
        encoding="utf-8"
    )
    assert "SUPERVISOR_TOKEN" in read_wrapper.split("unset ", 1)[1].split("\n", 1)[0]

    for helper in ("ha-memory", "ha-memory-mcp"):
        content = (rootfs / "usr/local/bin" / helper).read_text(encoding="utf-8")
        assert "antigravity_ha_load_supervisor_credential" not in content
    playwright = (rootfs / "usr/local/bin/ha-playwright-mcp").read_text(
        encoding="utf-8"
    )
    assert "antigravity_ha_load_supervisor_credential" in playwright
    assert playwright.rindex("unset \\\n  SUPERVISOR_TOKEN") < playwright.index(
        "exec /usr/local/libexec/ha-playwright-runtime"
    )


def test_antigravity_wrapper_uses_native_permission_contract(rootfs: Path) -> None:
    wrapper = (rootfs / "usr/local/bin/antigravity").read_text(encoding="utf-8")
    assert "--dangerously-skip-permissions is disabled" in wrapper
    assert "native sandbox overrides are disabled" in wrapper
    for override in ("--sandbox", "--no-sandbox"):
        assert override in wrapper
    assert 'exec "${ANTIGRAVITY_HA_LAUNCHER}" "$@"' in wrapper
def test_sensitive_data_option_selects_only_gated_launcher(rootfs: Path) -> None:
    wrapper = (rootfs / "usr/local/bin/antigravity").read_text(encoding="utf-8")
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    assert "antigravity_sensitive_data_access false" in wrapper
    assert "antigravity-interactive-restricted" in wrapper
    assert "antigravity-interactive-sensitive-read" in wrapper
    assert 'exec "${ANTIGRAVITY_HA_LAUNCHER}" "$@"' in wrapper
    assert 'rm -f "${SENSITIVE_DATA_ACCESS_MARKER}"' in init_script
    assert 'chmod 0400 "${sensitive_tmp}"' in init_script
    assert 'mv -f "${sensitive_tmp}" "${SENSITIVE_DATA_ACCESS_MARKER}"' in init_script
