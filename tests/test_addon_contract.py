import json
import re
import shutil
import struct
import subprocess
from pathlib import Path

import yaml


def _apparmor_profile(source: str, name: str) -> str:
    marker = f"profile {name}"
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
    assert addon_config["breaking_versions"] == ["2.0.0"]


def test_registry_release_workflow_is_tag_gated(repository_root: Path) -> None:
    workflow_root = repository_root / ".github" / "workflows"
    builder_path = workflow_root / "builder.yaml"
    build_app_path = workflow_root / "build-app.yaml"
    candidate_path = workflow_root / "candidate.yaml"

    with builder_path.open(encoding="utf-8") as stream:
        builder = yaml.safe_load(stream)
    assert builder["on"]["push"] == {
        "tags": ["[0-9]*.[0-9]*.[0-9]*"]
    }
    assert "branches" not in builder["on"]["push"]

    builder_text = builder_path.read_text(encoding="utf-8")
    build_app_text = build_app_path.read_text(encoding="utf-8")
    candidate_text = candidate_path.read_text(encoding="utf-8")
    tag_parser_text = (
        repository_root / ".github/scripts/parse-release-tag.sh"
    ).read_text(encoding="utf-8")
    assert "RELEASE_TAG: ${{ github.ref_name }}" in builder_text
    assert "APP_IMAGE: ${{ fromJSON(steps.info.outputs.image) }}" in builder_text
    assert "Release tag and App version differ" in builder_text
    assert "parse-release-tag.sh" in builder_text
    assert "Release tag must be annotated" in tag_parser_text
    assert "Candidate-Run-ID" in tag_parser_text
    assert "Release-Evidence-SHA256" in tag_parser_text
    assert "secrets: inherit" not in builder_text
    assert "packages: write" in builder_text
    assert "anonymous-candidate-preflight.sh" in builder_text
    assert "release-oci.sh ensure-tag" in builder_text
    assert "Carbon-copy numeric tags without rebuilding" in builder_text
    assert "aarch64-antigravity-for-home-assistant" in build_app_text
    assert "quality-gate" not in builder_text
    assert "publish: true" not in builder_text
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
    assert "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8" in (
        builder_text
    )
    assert "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6" in (
        builder_text
    )
    assert "sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6" in (
        builder_text
    )
    assert "cosign sign --yes" in builder_text
    assert "cosign verify" in builder_text
    assert "--certificate-github-workflow-sha" in builder_text
    assert "--predicate-type https://spdx.dev/Document/v2.3" in builder_text
    assert "ensure-github-release.sh" in builder_text
    assert "candidate-${{ github.sha }}-${{ github.run_id }}" in candidate_text
    assert "verify-manual-evidence.sh" in candidate_text


def test_home_assistant_brand_assets(addon_root: Path) -> None:
    assert _png_header(addon_root / "icon.png") == (128, 128, 6)
    assert _png_header(addon_root / "logo.png") == (250, 250, 6)


def test_app_and_dockerfile_versions_match(
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
    assert package["version"] == addon_config["version"]
    assert lock["name"] == package["name"]
    assert lock["packages"][""]["name"] == package["name"]
    assert lock["version"] == addon_config["version"]
    assert lock["packages"][""]["version"] == addon_config["version"]


def test_ingress_and_network_contract(addon_config: dict) -> None:
    assert addon_config["ingress"] is True
    assert addon_config["ingress_stream"] is True
    assert addon_config["ingress_port"] == 7681
    assert addon_config.get("panel_admin", True) is True
    assert addon_config["ports"] == {"22/tcp": 2224}
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


def test_apparmor_directed_transitions_resolve_to_loaded_top_level_profiles(
    addon_root: Path,
) -> None:
    profile_path = addon_root / "apparmor.txt"
    source = profile_path.read_text(encoding="utf-8")
    loaded_profiles = set(
        re.findall(r"(?m)^profile\s+(antigravity_home_assistant[^\s{]*)", source)
    )
    directed_transitions = re.findall(
        r"(?m)^\s+\S.*?\s+(r?Px)\s+->\s+"
        r"(antigravity_home_assistant[^\s,]+),\s*$",
        source,
    )

    assert loaded_profiles
    assert directed_transitions
    assert re.search(r"\b(?:c|C)x\b", source) is None
    assert {target for _, target in directed_transitions} <= loaded_profiles

    parser = shutil.which("apparmor_parser")
    if parser is None:
        return

    names = subprocess.run(
        [parser, "--skip-kernel-load", "--skip-cache", "--names", str(profile_path)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    assert set(names) == loaded_profiles

    compiled = subprocess.run(
        [
            parser,
            "--skip-kernel-load",
            "--skip-cache",
            "--zstd-compress-level=none",
            "--stdout",
            str(profile_path),
        ],
        check=True,
        capture_output=True,
    ).stdout
    compiled_strings = {
        match.group().decode("ascii")
        for match in re.finditer(rb"[\x20-\x7e]{4,}", compiled)
    }
    assert not {
        value
        for value in compiled_strings
        if "//antigravity_home_assistant" in value
    }


def test_custom_apparmor_profile_protects_home_assistant_secrets(
    addon_root: Path,
) -> None:
    profile_path = addon_root / "apparmor.txt"
    profile = profile_path.read_text(encoding="utf-8")
    main_profile, interactive_profiles = profile.split(
        "profile antigravity_home_assistant-interactive-restricted", maxsplit=1
    )
    restricted_profile, sensitive_tail = interactive_profiles.split(
        "profile antigravity_home_assistant-interactive-sensitive-read",
        maxsplit=1,
    )
    sensitive_profile, remaining_profiles = sensitive_tail.split(
        "profile antigravity_home_assistant-init", maxsplit=1
    )
    sshd_profile = remaining_profiles.split(
        "profile antigravity_home_assistant-sshd", maxsplit=1
    )[1].split("profile antigravity_home_assistant-ha-helper", maxsplit=1)[0]
    helper_profile = remaining_profiles.split(
        "profile antigravity_home_assistant-ha-helper", maxsplit=1
    )[1].split("profile antigravity_home_assistant-telegram-admin", maxsplit=1)[0]
    telegram_admin_profile = remaining_profiles.split(
        "profile antigravity_home_assistant-telegram-admin", maxsplit=1
    )[1].split(
        "profile antigravity_home_assistant-telegram-login", maxsplit=1
    )[0]
    telegram_login_profile = remaining_profiles.split(
        "profile antigravity_home_assistant-telegram-login", maxsplit=1
    )[1].split(
        "profile antigravity_home_assistant-telegram flags", maxsplit=1
    )[0]
    telegram_profile = remaining_profiles.split(
        "profile antigravity_home_assistant-telegram flags", maxsplit=1
    )[1].split(
        "profile antigravity_home_assistant-telegram-worker", maxsplit=1
    )[0]
    telegram_worker_profile = remaining_profiles.split(
        "profile antigravity_home_assistant-telegram-worker", maxsplit=1
    )[1].split(
        "profile antigravity_home_assistant-change-broker", maxsplit=1
    )[0]
    change_broker_profile = remaining_profiles.split(
        "profile antigravity_home_assistant-change-broker", maxsplit=1
    )[1].split(
        "profile antigravity_home_assistant-playwright-bootstrap", maxsplit=1
    )[0]
    browser_profile = remaining_profiles.split(
        "profile antigravity_home_assistant-browser", maxsplit=1
    )[1]
    playwright_bootstrap_profile = remaining_profiles.split(
        "profile antigravity_home_assistant-playwright-bootstrap", maxsplit=1
    )[1].split(
        "profile antigravity_home_assistant-browser", maxsplit=1
    )[0]
    broker_bootstrap_profile = _apparmor_profile(
        profile, "antigravity_home_assistant-broker-bootstrap"
    )
    shell_profile = _apparmor_profile(
        profile, "antigravity_home_assistant-shell"
    )
    init_profile = _apparmor_profile(
        profile, "antigravity_home_assistant-init"
    )

    assert "profile antigravity_home_assistant" in profile
    assert "complain" not in profile
    assert "  file," not in profile
    assert "  capability," not in profile
    assert "ptrace," not in profile
    assert "/config/** rwklix," in main_profile
    assert "/run/{s6,s6-rc*,service}/** rwix," in main_profile
    assert "/run/antigravity-ha/** rwk," not in main_profile
    helper_transition = next(
        line
        for line in main_profile.splitlines()
        if "Px -> antigravity_home_assistant-ha-helper" in line
    )
    assert "ha-api" in helper_transition
    assert "supervisor-api" in helper_transition
    assert (
        "/usr/local/bin/ha-playwright-mcp Px -> "
        "antigravity_home_assistant-playwright-bootstrap,"
    ) in main_profile
    assert (
        "/usr/local/bin/{ha-change-broker,ha-read-broker} Px -> "
        "antigravity_home_assistant-broker-bootstrap,"
    ) in main_profile
    assert (
        "/usr/local/libexec/ha-interactive-shell Px -> "
        "antigravity_home_assistant-shell,"
    ) in main_profile
    assert (
        "/usr/local/libexec/ha-init-runtime Px -> "
        "antigravity_home_assistant-init,"
    ) in main_profile
    assert (
        "/usr/local/libexec/ha-sshd-runtime rPx,"
    ) in main_profile
    assert (
        "profile antigravity_home_assistant-sshd "
        "/usr/local/libexec/ha-sshd-runtime"
    ) in profile
    assert (
        "/usr/local/libexec/ha-telegram-runtime Px -> "
        "antigravity_home_assistant-telegram,"
    ) in main_profile
    assert (
        "/usr/local/bin/ha-telegram-pair Px -> "
        "antigravity_home_assistant-telegram-admin,"
    ) in main_profile
    assert (
        "/usr/local/libexec/antigravity-interactive-restricted Px -> "
        "antigravity_home_assistant-interactive-restricted,"
    ) in main_profile
    assert (
        "/usr/local/libexec/antigravity-interactive-sensitive-read Px -> "
        "antigravity_home_assistant-interactive-sensitive-read,"
    ) in main_profile
    assert "deny /run/antigravity-ha/supervisor.token rwklm," in (
        main_profile
    )
    assert "/run/antigravity-ha/supervisor.token r," in helper_profile
    assert "deny /run/antigravity-ha/supervisor.token wklm," in (
        helper_profile
    )
    assert "deny /data/options.json rwklm," in helper_profile
    assert "/run/antigravity-ha/ha-feedback-options.json r," in helper_profile
    assert "deny /data/options.json rwklm," in playwright_bootstrap_profile
    assert "/run/antigravity-ha/ha-feedback-options.json r," in (
        playwright_bootstrap_profile
    )
    assert "/usr/local/libexec/ha-telegram-worker Px -> " \
        "antigravity_home_assistant-telegram-worker," in telegram_profile
    assert "/run/antigravity-ha/change-broker.sock rw," in telegram_profile
    assert "deny /run/antigravity-ha/change-proposal.sock rwklm," in (
        telegram_profile
    )
    assert "/config/** r," not in telegram_profile
    assert "/config/** rw" not in telegram_profile
    assert "deny /run/antigravity-ha/supervisor.token rwklm," in (
        telegram_profile
    )
    assert "/data/antigravity-ha/telegram/** rwkl," in telegram_admin_profile
    assert "/run/antigravity-ha/telegram-pairing.lock rwk," in (
        telegram_admin_profile
    )
    assert "deny /data/options.json rwklm," in telegram_admin_profile
    assert "deny /run/antigravity-ha/supervisor.token rwklm," in (
        telegram_admin_profile
    )
    assert "deny /config/** rwklm," in telegram_admin_profile
    assert "network" not in telegram_admin_profile
    assert "/data/antigravity-ha/telegram-home/** rwkl," in (
        telegram_login_profile
    )
    assert "deny /data/home/** rwklm," in telegram_login_profile
    assert "deny /config/** rwklm," in telegram_login_profile
    assert "deny /data/antigravity-ha/telegram/** rwklm," in main_profile
    assert "deny /data/antigravity-ha/change-broker/** rwklm," in main_profile
    for readable_ssh_material in (
        "/data/ssh/authorized_keys",
        "/data/ssh/ssh_host_ed25519_key",
        "/data/ssh/ssh_host_rsa_key",
    ):
        assert f"{readable_ssh_material} r," in sshd_profile
    assert "deny /data/ssh/ wklmx," in sshd_profile
    assert "deny /data/ssh/** wklmx," in sshd_profile
    assert (
        "/usr/local/libexec/ha-ssh-session rPx -> "
        "antigravity_home_assistant-shell,"
    ) in sshd_profile
    assert (
        "/usr/lib/openssh/sftp-server rPx -> "
        "antigravity_home_assistant-shell,"
        in sshd_profile
    )
    assert "deny /config/ rwklmx," in sshd_profile
    assert "deny /config/** rwklmx," in sshd_profile
    assert "/run/antigravity-ha/change-proposal.sock rw," in (
        telegram_worker_profile
    )
    assert "Px -> antigravity_home_assistant-ha-helper" not in (
        telegram_worker_profile
    )
    for direct_helper in (
        "ha-addon-logs",
        "ha-api",
        "ha-config-check",
        "ha-core-logs",
        "ha-feedback",
        "supervisor-api",
    ):
        assert direct_helper not in telegram_worker_profile
    assert (
        "/usr/local/bin/ha-read-mcp Px -> "
        "antigravity_home_assistant-read-client,"
    ) in telegram_worker_profile
    assert "deny /config/ rwklmx," in telegram_worker_profile
    assert "deny /config/** rwklmx," in telegram_worker_profile
    assert "/config/** r," not in telegram_worker_profile
    assert "deny /run/antigravity-ha/change-broker.sock rwklm," in (
        telegram_worker_profile
    )
    assert "deny /data/options.json rwklm," in telegram_worker_profile
    assert (
        "/usr/local/bin/ha-memory-mcp Px -> "
        "antigravity_home_assistant-memory-telegram,"
    ) in telegram_worker_profile
    assert (
        "/usr/local/bin/ha-playwright-mcp Px -> "
        "antigravity_home_assistant-playwright-bootstrap-telegram,"
    ) in telegram_worker_profile
    assert "/usr/local/bin/{ha-memory,ha-memory-mcp}" not in (
        telegram_worker_profile
    )
    assert "profile antigravity_home_assistant-memory-telegram" in profile
    assert (
        "profile antigravity_home_assistant-playwright-bootstrap-telegram"
        in profile
    )
    assert "profile antigravity_home_assistant-browser-telegram" in profile
    assert "/run/antigravity-ha/supervisor.token r," in broker_bootstrap_profile
    assert (
        "/usr/local/libexec/ha-change-broker-runtime Px -> "
        "antigravity_home_assistant-change-broker,"
    ) in broker_bootstrap_profile
    assert "deny /run/antigravity-ha/supervisor.token rwklm," in (
        change_broker_profile
    )
    assert "/config/{,**/}*.yaml rwkl," in change_broker_profile
    assert "/config/{,**/}*.yml rwkl," in change_broker_profile
    assert "/run/antigravity-ha/home-assistant-browser.token r," in (
        browser_profile
    )
    assert "deny /run/antigravity-ha/supervisor.token rwklm," in (
        browser_profile
    )
    recorder_glob = "/config/{,**/}*.{db,sqlite,sqlite3}{,.*,-*,~}"
    for sensitive_path in (
        "/config/secrets.yaml",
        "/config/.storage/**",
        recorder_glob,
        "/config/.ssh/**",
        "/config/ssl/**",
        "/config/backups/**",
    ):
        assert f"deny {sensitive_path} rwklm," in main_profile

    diagnostic_paths = (
        "/config/secrets.yaml",
        "/config/secrets.yaml.*",
        "/config/.storage/",
        "/config/.storage/**",
        recorder_glob,
    )
    for sensitive_path in diagnostic_paths:
        assert f"deny {sensitive_path} rwklmx," in restricted_profile
        assert f"{sensitive_path} r," in sensitive_profile
        assert f"deny {sensitive_path} wklmx," in sensitive_profile

    # One recursive AppArmor rule covers the default Recorder name, configured
    # nested SQLite locations, runtime journals, and adjacent recovery copies.
    recorder_path_contract = re.compile(
        r"^/config/(?:.*/)?[^/]+\.(?:db|sqlite|sqlite3)"
        r"(?:[.-][^/]+|~)?$"
    )
    for recorder_candidate in (
        "/config/home-assistant_v2.db",
        "/config/home-assistant_v2.db-wal",
        "/config/home-assistant_v2.db-shm",
        "/config/home-assistant_v2.db-journal",
        "/config/storage/recorder.sqlite3",
        "/config/storage/recorder.sqlite3.backup",
        "/config/nested/custom.sqlite-old",
        "/config/nested/custom.db~",
    ):
        assert recorder_path_contract.fullmatch(recorder_candidate)
    for ordinary_project_file in (
        "/config/configuration.yaml",
        "/config/dashboard.json",
        "/config/nested/database.txt",
    ):
        assert recorder_path_contract.fullmatch(ordinary_project_file) is None
    assert "home-assistant_v2.db" not in profile

    always_denied_paths = (
        "/data/antigravity/**",
        "/data/browser-auth/**",
        "/data/github-cli/**",
        "/data/ssh/**",
        "/data/home/.ssh/**",
        "/run/antigravity-ha/supervisor.token",
        "/run/antigravity-ha/home-assistant-browser.token",
        "/config/.cloud/**",
        "/config/.ssh/**",
        "/config/ssl/**",
        "/config/backups/**",
    )
    for sensitive_path in always_denied_paths:
        assert f"deny {sensitive_path} rwklm" in restricted_profile
        assert f"deny {sensitive_path} rwklm" in sensitive_profile

    assert "deny /data/home/.gemini/** rwklm," in main_profile
    assert "deny /data/home/.gemini/** rwklm," in shell_profile
    assert "/data/home/** rwkl," in restricted_profile
    assert "/data/home/** rwkl," in sensitive_profile
    proc_denies = (
        "deny @{PROC}@{pid}/{cmdline,environ,mem} rwklm,",
        "deny @{PROC}@{pid}/fd/ r,",
        "deny @{PROC}@{pid}/fd/** rwklm,",
        "deny @{PROC}@{pid}/root r,",
        "deny @{PROC}@{pid}/root/** rwklm,",
        "deny @{PROC}@{pid}/map_files/ r,",
        "deny @{PROC}@{pid}/map_files/** rwklm,",
    )
    helper_profile_exact = _apparmor_profile(
        profile, "antigravity_home_assistant-ha-helper"
    )
    isolated_profiles = [
        main_profile,
        restricted_profile,
        sensitive_profile,
        init_profile,
        helper_profile_exact,
        change_broker_profile,
        _apparmor_profile(profile, "antigravity_home_assistant-read-broker"),
        shell_profile,
    ]
    isolated_profiles.extend(
        _apparmor_profile(profile, name)
        for name in (
            "antigravity_home_assistant-telegram-admin",
            "antigravity_home_assistant-telegram-login",
            "antigravity_home_assistant-telegram flags=",
            "antigravity_home_assistant-telegram-worker",
            "antigravity_home_assistant-read-client",
            "antigravity_home_assistant-memory flags=",
            "antigravity_home_assistant-memory-telegram",
            "antigravity_home_assistant-playwright-bootstrap flags=",
            "antigravity_home_assistant-playwright-bootstrap-telegram",
            "antigravity_home_assistant-browser flags=",
            "antigravity_home_assistant-browser-telegram",
        )
    )
    for isolated_profile in isolated_profiles:
        for deny_rule in proc_denies:
            assert deny_rule in isolated_profile


def test_apparmor_bash_transition_targets_reject_startup_injection(
    addon_root: Path,
    rootfs: Path,
) -> None:
    profile = (addon_root / "apparmor.txt").read_text(encoding="utf-8")
    patterns = re.findall(
        r"^\s+(/\S+)\s+\S*[pPcC]x\s+->", profile, re.MULTILINE
    )
    patterns.extend(
        re.findall(r"^\s+(/\S+)\s+\S*[pP]x,\s*$", profile, re.MULTILINE)
    )
    expanded_paths: set[str] = set()

    for pattern in patterns:
        match = re.search(r"\{([^{}]+)\}", pattern)
        if match is None:
            expanded_paths.add(pattern)
            continue
        for item in match.group(1).split(","):
            expanded_paths.add(
                f"{pattern[:match.start()]}{item}{pattern[match.end():]}"
            )

    checked: set[str] = set()
    for absolute_path in expanded_paths:
        source_path = rootfs / absolute_path.removeprefix("/")
        if not source_path.is_file():
            # These binaries are installed or downloaded and verified at image
            # build time rather than stored in rootfs.
            assert absolute_path in {
                "/usr/lib/openssh/sftp-server",
                "/usr/local/libexec/antigravity-real",
            }
            continue
        source = source_path.read_text(encoding="utf-8")
        if not source.startswith("#!"):
            continue
        lines = source.splitlines()
        expected_unset = "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH"
        if absolute_path != "/usr/local/libexec/ha-init-runtime":
            expected_unset += " SUPERVISOR_TOKEN"
        assert lines[:3] == [
            "#!/bin/bash -p",
            "set -Eeuo pipefail",
            expected_unset,
        ], absolute_path
        checked.add(absolute_path)

    assert {
        "/usr/local/libexec/ha-init-runtime",
        "/usr/local/libexec/ha-sshd-runtime",
        "/usr/local/libexec/ha-ssh-session",
        "/usr/local/libexec/ha-interactive-shell",
        "/usr/local/libexec/ha-telegram-runtime",
        "/usr/local/libexec/ha-change-broker-runtime",
        "/usr/local/libexec/ha-read-broker-runtime",
        "/usr/local/libexec/antigravity-interactive-restricted",
        "/usr/local/libexec/antigravity-interactive-sensitive-read",
        "/usr/local/bin/ha-change-broker",
        "/usr/local/bin/ha-api",
        "/usr/local/bin/supervisor-api",
        "/usr/local/bin/ha-playwright-mcp",
        "/usr/local/libexec/ha-playwright-runtime",
    } <= checked


def test_security_sensitive_defaults(addon_config: dict) -> None:
    assert addon_config["options"]["authorized_keys"] == []
    assert addon_config["options"]["web_terminal_auto_start_antigravity"] is False
    assert addon_config["options"]["telegram_enabled"] is False
    assert addon_config["options"]["telegram_allowed_user_ids"] == []
    assert addon_config["options"]["telegram_allowed_chat_ids"] == []
    assert addon_config["options"]["telegram_access_mode"] == "confirm_changes"
    assert addon_config["schema"]["telegram_access_mode"] == (
        "list(read_only|confirm_changes|autonomous)"
    )
    assert addon_config["options"]["antigravity_tool_permission"] == (
        "request-review"
    )
    assert addon_config["schema"]["antigravity_tool_permission"] == (
        "list(request-review|proceed-in-sandbox|always-proceed|strict)"
    )
    assert addon_config["options"]["antigravity_terminal_sandbox"] is True
    assert addon_config["schema"]["antigravity_terminal_sandbox"] == "bool"
    assert addon_config["options"]["antigravity_sensitive_data_access"] is False
    assert addon_config["schema"]["antigravity_sensitive_data_access"] == "bool"
    assert addon_config["options"]["antigravity_user_files_update_mode"] == (
        "preserve"
    )
    assert addon_config["schema"]["antigravity_user_files_update_mode"] == (
        "list(preserve|refresh_managed|reset_v2|refresh_agents|refresh_all)"
    )
    assert addon_config["options"]["home_assistant_browser_auto_auth"] is True
    assert addon_config["schema"]["home_assistant_browser_auto_auth"] == "bool"
    assert "home_assistant_browser_token" not in addon_config["options"]
    for removed_codex_option in (
        "antigravity_token",
        "antigravity_approval_policy",
        "antigravity_sandbox_mode",
        "browser_approval_policy",
        "home_assistant_browser_token",
    ):
        assert removed_codex_option not in addon_config["options"]
        assert removed_codex_option not in addon_config["schema"]
def test_new_v2_options_are_translated(addon_root: Path) -> None:
    expected_options = {
        "telegram_allowed_user_ids",
        "telegram_access_mode",
        "antigravity_tool_permission",
        "antigravity_terminal_sandbox",
        "antigravity_sensitive_data_access",
        "antigravity_user_files_update_mode",
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
