import json
import re
import shutil
import struct
import subprocess
from pathlib import Path

import yaml


EXPECTED_APPARMOR_PROFILES = {
    "antigravity_home_assistant",
    "antigravity_home_assistant-read-broker-bootstrap",
    "antigravity_home_assistant-browser",
    "antigravity_home_assistant-command",
    "antigravity_home_assistant-file-client",
    "antigravity_home_assistant-ha-helper",
    "antigravity_home_assistant-init",
    "antigravity_home_assistant-interactive-restricted",
    "antigravity_home_assistant-interactive-runtime-restricted",
    "antigravity_home_assistant-interactive-runtime-sensitive-read",
    "antigravity_home_assistant-interactive-sensitive-read",
    "antigravity_home_assistant-memory",
    "antigravity_home_assistant-playwright-bootstrap",
    "antigravity_home_assistant-read-broker",
    "antigravity_home_assistant-read-client",
    "antigravity_home_assistant-remote",
    "antigravity_home_assistant-shell",
}

REMOTE_TOKEN = "/data/home/.gemini/jetski-standalone-oauth-token"


def _apparmor_profile(source: str, name: str) -> str:
    marker = f"profile {name} "
    assert marker in source
    return marker + source.split(marker, maxsplit=1)[1].split("\n}\n", maxsplit=1)[0]


def _png_header(path: Path) -> tuple[int, int, int]:
    header = path.read_bytes()[:26]
    assert header[:8] == b"\x89PNG\r\n\x1a\n"
    assert header[12:16] == b"IHDR"
    width, height = struct.unpack(">II", header[16:24])
    return width, height, header[25]


def test_all_yaml_files_parse(repository_root: Path) -> None:
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
            "*.yaml",
        ],
        cwd=repository_root,
        check=True,
        capture_output=True,
        text=True,
    )
    yaml_files = [
        repository_root / relative
        for relative in result.stdout.split("\0")
        if relative and (repository_root / relative).is_file()
    ]
    assert yaml_files

    for yaml_file in yaml_files:
        with yaml_file.open(encoding="utf-8") as stream:
            yaml.safe_load(stream)


def test_release_is_multi_arch_with_generic_registry_image(
    addon_config: dict,
) -> None:
    assert addon_config["arch"] == ["aarch64", "amd64"]
    assert (
        addon_config["image"]
        == "ghcr.io/kanu-coffee/antigravity-for-home-assistant"
    )
    assert "{arch}" not in addon_config["image"]
    assert addon_config["stage"] == "experimental"
    assert addon_config["breaking_versions"] == [
        "2.0.0",
        "2.0.7",
        "2.0.9",
        "2.0.11",
        "2.0.12",
        "2.0.13",
        "2.1.0",
        "3.0.0",
    ]


def test_registry_release_workflow_has_one_main_publication_path(
    repository_root: Path,
) -> None:
    workflow_root = repository_root / ".github" / "workflows"
    builder_path = workflow_root / "builder.yaml"
    build_app_path = workflow_root / "build-app.yaml"
    candidate_path = workflow_root / "candidate.yaml"
    main_release_path = workflow_root / "main-release.yaml"

    with builder_path.open(encoding="utf-8") as stream:
        builder = yaml.safe_load(stream)
    with build_app_path.open(encoding="utf-8") as stream:
        build_app = yaml.safe_load(stream)
    with candidate_path.open(encoding="utf-8") as stream:
        candidate = yaml.safe_load(stream)
    with main_release_path.open(encoding="utf-8") as stream:
        main_release = yaml.safe_load(stream)
    assert set(builder["on"]) == {"pull_request"}
    assert set(builder["jobs"]) == {"validate", "pull-request-build"}

    builder_text = builder_path.read_text(encoding="utf-8")
    build_app_text = build_app_path.read_text(encoding="utf-8")
    candidate_text = candidate_path.read_text(encoding="utf-8")
    main_release_text = main_release_path.read_text(encoding="utf-8")
    assert "[[ $APP_VERSION =~ ^3\\.[0-9]+\\.[0-9]+$ ]]" in builder_text
    for retired_publication_step in (
        "parse-release-tag.sh",
        "release-oci.sh",
        "ensure-github-release.sh",
        "cosign sign",
        "packages: write",
    ):
        assert retired_publication_step not in builder_text
    assert builder["jobs"]["pull-request-build"]["permissions"] == {
        "contents": "read",
        "packages": "read",
    }
    assert builder["jobs"]["pull-request-build"]["with"]["candidate"] is False
    assert candidate["jobs"]["build"]["permissions"] == {
        "contents": "read",
        "packages": "write",
    }
    assert candidate["jobs"]["build"]["with"]["candidate"] is True
    assert "permissions" not in build_app
    assert build_app["jobs"]["prepare"]["permissions"] == {"contents": "read"}
    assert "permissions" not in build_app["jobs"]["build"]
    assert "permissions" not in build_app["jobs"]["assemble-candidate"]
    assert build_app["jobs"]["build"]["steps"][2]["with"]["push"] == (
        "${{ inputs.candidate }}"
    )
    assert "aarch64-antigravity-for-home-assistant" in build_app_text
    assert "github.repository == 'Kanu-Coffee/antigravity-for-home-assistant'" in (
        build_app_text
    )
    assert (
        "home-assistant/builder/actions/"
        "build-image@4de35182ce1e329181bffcbcc84d33db5e2c7e10"
    ) in (
        build_app_text
    )
    assert "Create generic candidate from exact architecture digests" in (
        build_app_text
    )
    assert '"${AMD64_IMAGE}@${AMD64_STAGE_DIGEST}"' in build_app_text
    assert '"${AARCH64_IMAGE}@${AARCH64_STAGE_DIGEST}"' in build_app_text
    assert "image-tags: latest" not in build_app_text
    assert "anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610" in (
        build_app_text
    )
    assert "candidate-${{ github.sha }}-${{ github.run_id }}" in candidate_text
    assert "verify-manual-evidence.sh" in candidate_text
    assert set(main_release["on"]) == {"workflow_dispatch"}
    assert set(main_release["jobs"]) == {"publish"}
    assert "[[ $RELEASE_VERSION =~ ^3\\.[0-9]+\\.[0-9]+$ ]]" in (
        main_release_text
    )
    assert "release-oci.sh ensure-tag" in main_release_text
    assert "Candidate-Run-ID" in main_release_text


def test_home_assistant_brand_assets(addon_root: Path) -> None:
    assert _png_header(addon_root / "icon.png") == (128, 128, 6)
    assert _png_header(addon_root / "logo.png") == (250, 250, 6)


def test_app_release_versions_and_playwright_bundle_contract(
    addon_config: dict, addon_root: Path
) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    assert f'ARG BUILD_VERSION={addon_config["version"]}' in dockerfile

    changelog = (addon_root / "CHANGELOG.md").read_text(encoding="utf-8")
    newest_heading = re.search(r"^## \[([^]]+)]", changelog, re.MULTILINE)
    assert newest_heading
    assert newest_heading.group(1) == addon_config["version"]

    package = json.loads(
        (addon_root / "playwright/package.json").read_text(encoding="utf-8")
    )
    lock = json.loads(
        (addon_root / "playwright/package-lock.json").read_text(
            encoding="utf-8"
        )
    )
    # This private package is only a dependency manifest copied before the
    # expensive image dependency layer. Coupling it to the App release version
    # would invalidate that layer for every otherwise dependency-identical App
    # update.
    assert package["version"] == "0.0.0"
    assert package["version"] != addon_config["version"]
    assert lock["name"] == package["name"]
    assert lock["packages"][""]["name"] == package["name"]
    assert lock["version"] == package["version"]
    assert lock["packages"][""]["version"] == package["version"]


def test_ingress_and_network_contract(addon_config: dict) -> None:
    assert addon_config["ingress"] is True
    assert addon_config["ingress_stream"] is True
    assert addon_config["ingress_port"] == 7681
    assert addon_config.get("panel_admin", True) is True
    assert "ports" not in addon_config
    assert "ssh_port" not in addon_config["options"]
    assert "ssh_port" not in addon_config["schema"]


def test_home_assistant_config_is_mapped_read_write(addon_config: dict) -> None:
    config_maps = [
        mapping
        for mapping in addon_config["map"]
        if mapping.get("type") == "homeassistant_config"
    ]
    assert config_maps == [
        {
            "type": "homeassistant_config",
            "path": "/config",
            "read_only": False,
        }
    ]


def test_core_and_supervisor_manager_apis_are_enabled(addon_config: dict) -> None:
    assert addon_config["homeassistant_api"] is True
    assert addon_config["hassio_api"] is True
    assert addon_config["hassio_role"] == "manager"


def test_forbidden_privilege_settings_are_absent(addon_config: dict) -> None:
    for forbidden_key in ("docker_api", "full_access", "host_network"):
        assert forbidden_key not in addon_config

    assert addon_config.get("hassio_role") != "admin"
    # AppArmor defaults to enabled in Supervisor. Omitting the redundant key is
    # required by the pinned Home Assistant App linter; apparmor.txt below is
    # the custom enforcing profile and apparmor: false remains forbidden.
    assert "apparmor" not in addon_config


def test_supervisor_detects_one_primary_apparmor_profile(
    addon_root: Path,
) -> None:
    source = (addon_root / "apparmor.txt").read_text(encoding="utf-8")
    declarations = re.findall(
        r"(?m)^([ \t]*)profile\s+(antigravity_home_assistant[^\s{]*)",
        source,
    )
    primary = [name for indentation, name in declarations if not indentation]

    assert primary == ["antigravity_home_assistant"]
    assert {name for _, name in declarations} == EXPECTED_APPARMOR_PROFILES
    assert {
        name for indentation, name in declarations if indentation
    } == EXPECTED_APPARMOR_PROFILES - {"antigravity_home_assistant"}


def test_apparmor_transitions_resolve_and_policy_compiles(
    addon_root: Path,
) -> None:
    profile_path = addon_root / "apparmor.txt"
    source = profile_path.read_text(encoding="utf-8")
    targets = set(
        re.findall(
            r"(?m)^\s+\S.*?\s+r?Px\s+->\s+"
            r"(antigravity_home_assistant[^\s,]+),\s*$",
            source,
        )
    )

    assert targets <= EXPECTED_APPARMOR_PROFILES
    assert re.search(r"\b(?:c|C)x\b", source) is None
    assert "  file," not in source
    assert "  capability," not in source
    assert "ptrace," not in source
    assert "complain" not in source

    parser = shutil.which("apparmor_parser")
    if parser is None:
        return
    names = subprocess.run(
        [parser, "--skip-kernel-load", "--skip-cache", "--names", str(profile_path)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    assert set(names) == EXPECTED_APPARMOR_PROFILES
    subprocess.run(
        [parser, "--skip-kernel-load", "--skip-cache", str(profile_path)],
        check=True,
        capture_output=True,
        text=True,
    )


def test_apparmor_v3_remote_and_service_graph(addon_root: Path) -> None:
    source = (addon_root / "apparmor.txt").read_text(encoding="utf-8")
    main = _apparmor_profile(source, "antigravity_home_assistant")
    remote = _apparmor_profile(
        source, "antigravity_home_assistant-remote"
    )
    shell = _apparmor_profile(source, "antigravity_home_assistant-shell")
    broker = _apparmor_profile(
        source, "antigravity_home_assistant-read-broker-bootstrap"
    )

    assert (
        "/etc/s6-overlay/s6-rc.d/"
        "{antigravity-ha-init,antigravity-remote,ha-memoryd,"
        "ha-read-broker,ingress,ttyd}/run rix,"
    ) in main
    assert (
        "/etc/s6-overlay/s6-rc.d/"
        "{antigravity-remote,ingress,ttyd}/finish rix,"
    ) in main
    assert (
        "/usr/local/libexec/ha-antigravity-remote-runtime Px -> "
        "antigravity_home_assistant-remote,"
    ) in main
    remote_login_transition = (
        "/usr/local/bin/ha-antigravity-remote-login Px -> "
        "antigravity_home_assistant-remote,"
    )
    assert remote_login_transition in main
    assert remote_login_transition in shell
    assert (
        "/usr/local/libexec/antigravity-interactive-restricted Px -> "
        "antigravity_home_assistant-interactive-restricted,"
    ) in remote
    assert (
        "/usr/local/libexec/antigravity-interactive-sensitive-read Px -> "
        "antigravity_home_assistant-interactive-sensitive-read,"
    ) in remote
    assert "/usr/local/libexec/ha-antigravity-remote-runtime rix," in remote
    assert "/usr/bin/{env,flock,install,jq,kill,sleep,stat} rix," in remote
    assert "/usr/local/bin/ha-read-broker rix," in broker
    assert (
        "/usr/local/libexec/ha-read-broker-runtime Px -> "
        "antigravity_home_assistant-read-broker,"
    ) in broker

    for retired in (
        "profile antigravity_home_assistant-telegram",
        "profile antigravity_home_assistant-sshd",
        "profile antigravity_home_assistant-change",
        "profile antigravity_home_assistant-onboarding",
        "profile antigravity_home_assistant-settings-update",
        "ha-change-broker",
        "ha-change-proposal",
        "ha-telegram",
        "ha-sshd",
        "telegram-action",
        "antigravity-user-files-update",
        "ha-browser-user-create",
        "ha-browser-user-remove-password",
        "native-session.lock",
        "user-files-update.lock",
        "profile antigravity_home_assistant-broker-bootstrap",
    ):
        assert retired not in source

    init = _apparmor_profile(source, "antigravity_home_assistant-init")
    for retired_init_rule in (
        "capability fsetid,",
        "capability setgid,",
        "capability setuid,",
        "/etc/.pwd.lock",
        "/etc/{passwd,shadow}",
        "root unlock",
    ):
        assert retired_init_rule not in init


def test_apparmor_remote_token_is_native_runtime_only(
    addon_root: Path,
) -> None:
    source = (addon_root / "apparmor.txt").read_text(encoding="utf-8")
    allow_rule = f"{REMOTE_TOKEN} rwkl,"
    deny_rule = f"deny {REMOTE_TOKEN} rwklm,"
    native_profiles = {
        "antigravity_home_assistant-interactive-runtime-restricted",
        "antigravity_home_assistant-interactive-runtime-sensitive-read",
    }
    # Init is the sole lifecycle exception because the one-time v3 factory
    # reset must be able to unlink a pre-existing token with /data/home.
    denied_profiles = EXPECTED_APPARMOR_PROFILES - native_profiles - {
        "antigravity_home_assistant-init"
    }

    for name in native_profiles:
        profile = _apparmor_profile(source, name)
        assert allow_rule in profile
        assert f"deny {REMOTE_TOKEN} x," in profile
        assert deny_rule not in profile
    for name in denied_profiles:
        profile = _apparmor_profile(source, name)
        assert deny_rule in profile
        assert f"\n  {allow_rule}" not in profile

    init = _apparmor_profile(source, "antigravity_home_assistant-init")
    assert REMOTE_TOKEN not in init
    assert source.count(f"\n  {allow_rule}") == len(native_profiles)
    assert source.count(deny_rule) == len(denied_profiles)


def test_apparmor_preserves_runtime_secret_boundaries(
    addon_root: Path,
) -> None:
    source = (addon_root / "apparmor.txt").read_text(encoding="utf-8")
    operational_profiles = {
        "antigravity_home_assistant-command",
        "antigravity_home_assistant-interactive-runtime-restricted",
        "antigravity_home_assistant-interactive-runtime-sensitive-read",
        "antigravity_home_assistant-shell",
    }
    for name in operational_profiles:
        profile = _apparmor_profile(source, name)
        assert "deny /config/secrets.yaml rwklmx," in profile
        assert "deny /config/.storage/** rwklmx," in profile
        assert "deny /run/antigravity-ha/supervisor.token rwklm," in profile
        assert (
            "deny /run/antigravity-ha/home-assistant-browser.token rwklm,"
            in profile
        )

    main = _apparmor_profile(source, "antigravity_home_assistant")
    assert "/run/{s6,s6-rc*,service}/ rw," in main
    assert "/run/{s6,s6-rc*,service}/** rwkix," in main
    assert "/run/**" not in main
    assert "deny /config/secrets.yaml rwklm," in main
    assert "deny /config/.storage/** rwklm," in main

    read_broker = _apparmor_profile(
        source, "antigravity_home_assistant-read-broker"
    )
    assert "/run/antigravity-ha/ha-read.sock rwk," in read_broker
    assert "deny /data/** rwklm," in read_broker
    assert "deny /config/** rwklm," in read_broker


def test_security_sensitive_defaults(addon_config: dict) -> None:
    assert set(addon_config["options"]) == {
        "remote_control_name",
        "antigravity_sensitive_data_access",
        "home_assistant_browser_auto_auth",
        "log_level",
    }
    assert addon_config["options"]["remote_control_name"] == "home-assistant"
    assert addon_config["options"]["antigravity_sensitive_data_access"] is False
    assert addon_config["schema"]["antigravity_sensitive_data_access"] == "bool"
    assert addon_config["options"]["home_assistant_browser_auto_auth"] is True
    assert addon_config["schema"]["home_assistant_browser_auto_auth"] == "bool"
    assert addon_config["options"]["log_level"] == "info"
    for removed_option in (
        "authorized_keys",
        "web_terminal_auto_start_antigravity",
        "telegram_enabled",
        "telegram_allowed_user_ids",
        "telegram_allowed_chat_ids",
        "telegram_access_mode",
        "antigravity_tool_permission",
        "antigravity_terminal_sandbox",
        "antigravity_user_files_update_mode",
        "antigravity_token",
        "antigravity_approval_policy",
        "antigravity_sandbox_mode",
        "browser_approval_policy",
        "home_assistant_browser_token",
    ):
        assert removed_option not in addon_config["options"]
        assert removed_option not in addon_config["schema"]


def test_v3_options_are_translated(addon_root: Path) -> None:
    expected_options = {
        "remote_control_name",
        "antigravity_sensitive_data_access",
        "home_assistant_browser_auto_auth",
        "log_level",
    }
    for locale in ("en", "ko"):
        with (addon_root / f"translations/{locale}.yaml").open(
            encoding="utf-8"
        ) as stream:
            translation = yaml.safe_load(stream)
        translated = translation["configuration"]
        assert expected_options <= set(translated)
        for option_name in expected_options:
            assert translated[option_name]["name"]
            assert translated[option_name]["description"]
