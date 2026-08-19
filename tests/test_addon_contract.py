import json
import re
import shutil
import struct
import subprocess
from pathlib import Path

import yaml


EXPECTED_APPARMOR_PROFILES = {
    "antigravity_home_assistant",
    "antigravity_home_assistant-broker-bootstrap",
    "antigravity_home_assistant-browser",
    "antigravity_home_assistant-change-broker",
    "antigravity_home_assistant-change-proposal-client",
    "antigravity_home_assistant-command",
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
    "antigravity_home_assistant-settings-update",
    "antigravity_home_assistant-shell",
    "antigravity_home_assistant-sshd",
    "antigravity_home_assistant-telegram",
    "antigravity_home_assistant-telegram-action-executor",
    "antigravity_home_assistant-telegram-action-proposal-client",
    "antigravity_home_assistant-telegram-admin",
}


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
    ]


def test_registry_release_workflow_is_tag_gated(repository_root: Path) -> None:
    workflow_root = repository_root / ".github" / "workflows"
    builder_path = workflow_root / "builder.yaml"
    build_app_path = workflow_root / "build-app.yaml"
    candidate_path = workflow_root / "candidate.yaml"

    with builder_path.open(encoding="utf-8") as stream:
        builder = yaml.safe_load(stream)
    with build_app_path.open(encoding="utf-8") as stream:
        build_app = yaml.safe_load(stream)
    with candidate_path.open(encoding="utf-8") as stream:
        candidate = yaml.safe_load(stream)
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


def test_supervisor_detects_one_primary_apparmor_profile(
    addon_root: Path,
) -> None:
    source = (addon_root / "apparmor.txt").read_text(encoding="utf-8")

    # Supervisor 2026.07.5 uses this exact start-of-line shape while choosing
    # the one profile name it rewrites to the installed App slug. AppArmor's
    # parser still treats the deliberately indented declarations below as
    # independent top-level profiles, not local child profiles.
    supervisor_profiles = [
        match.group(1)
        for line in source.splitlines()
        if (match := re.match(r"^profile ([^ ]+).*$", line))
    ]
    declarations = re.findall(
        r"(?m)^([ \t]*)profile\s+(antigravity_home_assistant[^\s{]*)",
        source,
    )

    assert supervisor_profiles == ["antigravity_home_assistant"]
    assert {name for _, name in declarations} == EXPECTED_APPARMOR_PROFILES
    assert {
        name for indentation, name in declarations if indentation
    } == EXPECTED_APPARMOR_PROFILES - {"antigravity_home_assistant"}


def test_apparmor_directed_transitions_resolve_to_loaded_top_level_profiles(
    addon_root: Path,
) -> None:
    profile_path = addon_root / "apparmor.txt"
    source = profile_path.read_text(encoding="utf-8")
    loaded_profiles = set(
        re.findall(
            r"(?m)^[ \t]*profile\s+"
            r"(antigravity_home_assistant[^\s{]*)",
            source,
        )
    )
    directed_transitions = re.findall(
        r"(?m)^\s+\S.*?\s+(r?Px)\s+->\s+"
        r"(antigravity_home_assistant[^\s,]+),\s*$",
        source,
    )
    transition_modes = re.findall(
        r"(?m)^\s+\S.*?\s+(r?(?:P|C)x)"
        r"(?:\s+->\s+[^\s,]+)?,\s*$",
        source,
    )

    assert loaded_profiles == EXPECTED_APPARMOR_PROFILES
    assert len(directed_transitions) == 81
    assert transition_modes.count("Px") == 79
    assert transition_modes.count("rPx") == 3
    assert len(transition_modes) == 82
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

    parser_help = subprocess.run(
        [parser, "--help"],
        check=True,
        capture_output=True,
        text=True,
    )
    compile_command = [parser, "--skip-kernel-load", "--skip-cache"]
    if "--zstd-compress-level" in parser_help.stdout + parser_help.stderr:
        compile_command.append("--zstd-compress-level=none")
    compile_command.extend(["--stdout", str(profile_path)])
    compiled = subprocess.run(
        compile_command,
        check=True,
        capture_output=True,
    ).stdout
    compiled_strings = {
        match.group().decode("ascii")
        for match in re.finditer(rb"[\x20-\x7e]{4,}", compiled)
    }
    assert loaded_profiles <= compiled_strings
    assert not {
        value
        for value in compiled_strings
        if "//antigravity_home_assistant" in value
    }


def test_apparmor_covers_pinned_s6_overlay_3_2_2_runtime_lifecycle(
    addon_root: Path,
) -> None:
    profile_path = addon_root / "apparmor.txt"
    source = profile_path.read_text(encoding="utf-8")
    main_profile = _apparmor_profile(source, "antigravity_home_assistant")
    secondary_profiles = source.split(
        "profile antigravity_home_assistant-interactive-restricted", maxsplit=1
    )[1]
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")

    # This immutable Home Assistant base was inspected to contain
    # s6-overlay 3.2.2.0.  A base refresh must revalidate its /run lifecycle
    # before updating this binding or the policy below.
    assert (
        "ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:bookworm@sha256:"
        "8c7a9e207425e79b6b2ed1628a2b6727fa6e518d9fdddcbe3b1ac20440e70492"
    ) in dockerfile

    expected_runtime_rules = {
        "/run/{s6,s6-rc*,service}/ rw,",
        "/run/{s6,s6-rc*,service}/** rwkix,",
        "/run/s6-rc* rw,",
        "/run/s6-linux-init-container-results/ rw,",
        "/run/s6-linux-init-container-results/** rwk,",
    }
    for rule in expected_runtime_rules:
        assert rule in main_profile
        assert source.count(rule) == 1
        assert rule not in secondary_profiles

    # AppArmor's /** glob requires at least one descendant.  The exact
    # directory rules are therefore security-significant: without them,
    # s6-mkdir fails before PID 1 can establish the service tree.
    assert "/run/{s6,s6-rc*,service}/** rwix," not in main_profile
    assert "/run/**" not in main_profile
    assert "/run/{,**}" not in main_profile

    parser = shutil.which("apparmor_parser")
    if parser is None:
        return

    parsed = subprocess.run(
        [
            parser,
            "--skip-kernel-load",
            "--skip-cache",
            "--dump=rule-exprs",
            str(profile_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    parser_rules = parsed.stdout + parsed.stderr
    # Pin the parser expansion that caused the 2.0.13 regression: /** starts
    # with a non-slash descendant, while the separate trailing-slash rule
    # covers mkdir of the directory itself.
    assert (
        "aare: /run/{s6,s6-rc*,service}/   ->   "
        "/run/(s6|s6-rc[^/\\x00]*|service)/"
    ) in parser_rules
    assert (
        "aare: /run/{s6,s6-rc*,service}/**   ->   "
        "/run/(s6|s6-rc[^/\\x00]*|service)/[^/\\x00][^\\x00]*"
    ) in parser_rules


def test_apparmor_allows_only_resolved_cold_start_executable_targets(
    addon_root: Path,
) -> None:
    profile_path = addon_root / "apparmor.txt"
    source = profile_path.read_text(encoding="utf-8")
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    rootfs = addon_root / "rootfs"

    # These are the resolved executable targets observed in the immutable Home
    # Assistant base below. A base refresh must re-resolve every link before
    # changing the digest because AppArmor mediates the final target path.
    assert (
        "ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:bookworm@sha256:"
        "8c7a9e207425e79b6b2ed1628a2b6727fa6e518d9fdddcbe3b1ac20440e70492"
    ) in dockerfile
    resolved_image_links = {
        "/bin/bash": "/usr/bin/bash",
        "/command/execlineb": (
            "/package/admin/execline-2.9.8.1/command/execline"
        ),
        "/command/s6-envdir": (
            "/package/admin/s6-2.14.0.1/command/s6-envdir"
        ),
        "/command/s6-pause": (
            "/package/admin/s6-portable-utils-2.3.1.1/command/"
            "s6-portable-utils"
        ),
        "/command/with-contenv": (
            "/package/admin/s6-overlay-3.2.2.0/command/with-contenv"
        ),
        "/usr/bin/bashio": "/usr/lib/bashio/bashio",
    }
    service_entry = rootfs / "etc/s6-overlay/s6-rc.d/antigravity-ha-init/run"
    init_entry = rootfs / "usr/local/bin/antigravity-ha-init"
    assert service_entry.read_text(encoding="utf-8").splitlines()[0] == (
        "#!/command/with-contenv bashio"
    )
    assert init_entry.read_text(encoding="utf-8").splitlines()[0] == (
        "#!/command/with-contenv bashio"
    )
    assert (
        "exec /command/s6-pause"
        in (
            rootfs / "usr/local/libexec/ha-telegram-runtime"
        ).read_text(encoding="utf-8")
    )
    assert re.search(r"^\s+tmux \\$", dockerfile, flags=re.MULTILINE)

    profiles = {
        name: _apparmor_profile(source, name)
        for name in EXPECTED_APPARMOR_PROFILES
    }
    rules_by_profile = {
        name: {line.strip() for line in profile.splitlines()}
        for name, profile in profiles.items()
    }
    narrow_bash_profiles = {
        "antigravity_home_assistant-broker-bootstrap",
        "antigravity_home_assistant-change-proposal-client",
        "antigravity_home_assistant-interactive-restricted",
        "antigravity_home_assistant-interactive-sensitive-read",
        "antigravity_home_assistant-memory",
        "antigravity_home_assistant-read-broker",
        "antigravity_home_assistant-read-client",
        "antigravity_home_assistant-settings-update",
        "antigravity_home_assistant-sshd",
        "antigravity_home_assistant-telegram-action-executor",
        "antigravity_home_assistant-telegram-action-proposal-client",
        "antigravity_home_assistant-telegram-admin",
    }
    expected_profiles_by_rule = {
        f"{resolved_image_links['/bin/bash']} rix,": narrow_bash_profiles,
        f"{resolved_image_links['/usr/bin/bashio']} rix,": {
            "antigravity_home_assistant",
            "antigravity_home_assistant-init",
        },
        f"{resolved_image_links['/command/execlineb']} rix,": {
            "antigravity_home_assistant-init",
        },
        f"{resolved_image_links['/command/s6-envdir']} rix,": {
            "antigravity_home_assistant-init",
        },
        f"{resolved_image_links['/command/s6-pause']} rix,": {
            "antigravity_home_assistant-telegram",
        },
        f"{resolved_image_links['/command/with-contenv']} rix,": {
            "antigravity_home_assistant-init",
        },
        "/usr/lib/{x86_64,aarch64}-linux-gnu/utempter/utempter rix,": {
            "antigravity_home_assistant-shell",
        },
    }
    for rule, expected_profiles in expected_profiles_by_rule.items():
        actual_profiles = {
            name for name, rules in rules_by_profile.items() if rule in rules
        }
        assert actual_profiles == expected_profiles
        assert source.count(f"  {rule}\n") == len(expected_profiles)

    # The init runtime re-enters the with-contenv chain after its Px
    # transition. Keep the inherited s6 environment read-only and flat: the
    # directory must be listable and each environment file readable, but init
    # must not gain write access to the S6 runtime tree.
    for rule in (
        "/run/s6/container_environment/ r,",
        "/run/s6/container_environment/* r,",
    ):
        actual_profiles = {
            name for name, rules in rules_by_profile.items() if rule in rules
        }
        assert actual_profiles == {"antigravity_home_assistant-init"}
        assert source.count(f"  {rule}\n") == 1
    assert "/run/s6/container_environment/** r," not in source
    assert "/run/s6/container_environment/ rw," not in source
    assert "/run/s6/container_environment/* rw," not in source

    # GNU find snapshots the inherited S6 oneshot cwd even when every search
    # root is absolute. Permit only the randomly suffixed runner directory,
    # without granting reads across the generated S6 service tree.
    oneshot_cwd_rule = (
        "/run/s6-rc:s6-rc-init:*/servicedirs/s6rc-oneshot-runner/ r,"
    )
    actual_profiles = {
        name
        for name, rules in rules_by_profile.items()
        if oneshot_cwd_rule in rules
    }
    assert actual_profiles == {"antigravity_home_assistant-init"}
    assert source.count(f"  {oneshot_cwd_rule}\n") == 1
    for broad_oneshot_read in (
        "/run/s6-rc:s6-rc-init:*/ r,",
        "/run/s6-rc:s6-rc-init:*/** r,",
        "/run/s6-rc:s6-rc-init:*/servicedirs/ r,",
        "/run/s6-rc:s6-rc-init:*/servicedirs/** r,",
    ):
        assert broad_oneshot_read not in source

    # Keep each new secondary-profile exception tied to the resolved files.
    # The primary profile's pre-existing /package/** runtime grant is recorded
    # explicitly; this correction must not copy it into a secondary profile or
    # introduce another broad library/package rule.
    assert "/package/** rix," in rules_by_profile[
        "antigravity_home_assistant"
    ]
    for name, rules in rules_by_profile.items():
        if name != "antigravity_home_assistant":
            assert "/package/** rix," not in rules
    assert "/usr/lib/** rix," not in source
    assert "/usr/lib/bashio/** rix," not in source
    assert "/package/admin/** rix," not in source
    assert "/package/admin/s6-overlay-*/** rix," not in source
    assert "/package/admin/execline-*/** rix," not in source
    assert "/package/admin/s6-*/** rix," not in source

    parser = shutil.which("apparmor_parser")
    if parser is None:
        return

    parsed = subprocess.run(
        [
            parser,
            "--skip-kernel-load",
            "--skip-cache",
            "--dump=rule-exprs",
            str(profile_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    parser_rules = parsed.stdout + parsed.stderr
    assert parser_rules.count(
        "aare: /usr/lib/bashio/bashio   ->   /usr/lib/bashio/bashio"
    ) == 2
    assert parser_rules.count(
        "aare: /package/admin/s6-overlay-3.2.2.0/command/with-contenv"
        "   ->   /package/admin/s6-overlay-3\\.2\\.2\\.0/command/with-contenv"
    ) == 1
    assert parser_rules.count(
        "aare: /run/s6/container_environment/   ->   "
        "/run/s6/container_environment/"
    ) == 1
    assert parser_rules.count(
        "aare: /run/s6/container_environment/*   ->   "
        "/run/s6/container_environment/[^/\\x00][^/\\x00]*"
    ) == 1
    assert parser_rules.count(
        "aare: /run/s6-rc:s6-rc-init:*/servicedirs/"
        "s6rc-oneshot-runner/   ->   /run/s6-rc:s6-rc-init:"
        "[^/\\x00]*/servicedirs/s6rc-oneshot-runner/"
    ) == 1


def test_apparmor_limits_cold_start_mutations_to_traced_init_paths(
    addon_root: Path,
) -> None:
    source = (addon_root / "apparmor.txt").read_text(encoding="utf-8")
    rootfs = addon_root / "rootfs"
    init_source = (
        rootfs / "usr/local/bin/antigravity-ha-init"
    ).read_text(encoding="utf-8")
    profiles = {
        name: _apparmor_profile(source, name)
        for name in EXPECTED_APPARMOR_PROFILES
    }
    rules_by_profile = {
        name: {line.strip() for line in profile.splitlines()}
        for name, profile in profiles.items()
    }

    for command in (
        "passwd -d root",
        "usermod -s /usr/local/libexec/ha-ssh-session root",
        "nginx -t -c /etc/nginx/nginx.conf",
    ):
        assert command in init_source

    expected_profiles_by_rule = {
        "deny capability fsetid,": {"antigravity_home_assistant-init"},
        "/etc/.pwd.lock rwk,": {"antigravity_home_assistant-init"},
        "/etc/{passwd,shadow}{,+,-,.lock,.[0-9]*} rwkl,": {
            "antigravity_home_assistant-init"
        },
        "/run/nginx.pid rwk,": {
            "antigravity_home_assistant",
            "antigravity_home_assistant-init",
        },
        "/var/lib/nginx/ rw,": {
            "antigravity_home_assistant",
            "antigravity_home_assistant-init",
        },
        "/var/lib/nginx/{body,proxy,fastcgi,uwsgi,scgi}/ rwk,": {
            "antigravity_home_assistant-init"
        },
        "/dev/stderr rw,": {
            "antigravity_home_assistant",
            "antigravity_home_assistant-init",
        },
        "/dev/stdout rw,": {
            "antigravity_home_assistant",
            "antigravity_home_assistant-init",
        },
    }
    for rule, expected_profiles in expected_profiles_by_rule.items():
        actual_profiles = {
            name for name, rules in rules_by_profile.items() if rule in rules
        }
        assert actual_profiles == expected_profiles
        assert source.count(f"  {rule}\n") == len(expected_profiles)

    for rules in rules_by_profile.values():
        assert "capability fsetid," not in rules

    # Bash probes /dev/tty even in noninteractive mode. Keep those probes
    # denied without audit noise instead of granting daemon profiles a TTY.
    expected_tty_deny_profiles = {
        "antigravity_home_assistant-broker-bootstrap",
        "antigravity_home_assistant-browser",
        "antigravity_home_assistant-change-broker",
        "antigravity_home_assistant-ha-helper",
        "antigravity_home_assistant-memory",
        "antigravity_home_assistant-playwright-bootstrap",
        "antigravity_home_assistant-read-broker",
        "antigravity_home_assistant-read-client",
        "antigravity_home_assistant-settings-update",
        "antigravity_home_assistant-telegram-action-executor",
        "antigravity_home_assistant-telegram-action-proposal-client",
        "antigravity_home_assistant-telegram-admin",
    }
    actual_tty_deny_profiles = {
        name
        for name, rules in rules_by_profile.items()
        if "deny /dev/tty rw," in rules
    }
    assert actual_tty_deny_profiles == expected_tty_deny_profiles
    for name in expected_tty_deny_profiles:
        assert "/dev/tty rw," not in rules_by_profile[name]

    init_profile = profiles["antigravity_home_assistant-init"]
    for broad_write in (
        "/etc/** rw,",
        "/etc/** rwk,",
        "/etc/** rwkl,",
        "/var/** rw,",
        "/var/** rwk,",
    ):
        assert broad_write not in init_profile


def test_apparmor_limits_feature_runtime_paths_to_exact_profiles(
    addon_root: Path,
) -> None:
    source = (addon_root / "apparmor.txt").read_text(encoding="utf-8")
    profiles = {
        name: _apparmor_profile(source, name)
        for name in EXPECTED_APPARMOR_PROFILES
    }
    rules_by_profile = {
        name: {line.strip() for line in profile.splitlines()}
        for name, profile in profiles.items()
    }
    expected_profiles_by_rule = {
        "owner @{PROC}@{pid}/oom_score_adj rw,": {
            "antigravity_home_assistant-sshd"
        },
        "/usr/lib/chromium/chrome_crashpad_handler rix,": {
            "antigravity_home_assistant-browser"
        },
        "/usr/lib/chromium/chromium rix,": {
            "antigravity_home_assistant-browser"
        },
        "/usr/local/bin/ha-playwright-mcp r,": {
            "antigravity_home_assistant-playwright-bootstrap"
        },
        "/usr/local/libexec/ha-playwright-runtime r,": {
            "antigravity_home_assistant-browser"
        },
        "/usr/local/share/fonts/ r,": {
            "antigravity_home_assistant-browser"
        },
        "/usr/local/share/fonts/** r,": {
            "antigravity_home_assistant-browser"
        },
        "/usr/share/fontconfig/ r,": {
            "antigravity_home_assistant-browser"
        },
        "/usr/share/fontconfig/** r,": {
            "antigravity_home_assistant-browser"
        },
        "/usr/share/fonts/ r,": {
            "antigravity_home_assistant-browser"
        },
        "/usr/share/fonts/** r,": {
            "antigravity_home_assistant-browser"
        },
        "/usr/share/glib-2.0/schemas/gschemas.compiled r,": {
            "antigravity_home_assistant-browser"
        },
        "/usr/share/ca-certificates/ r,": {
            "antigravity_home_assistant-interactive-runtime-restricted",
            "antigravity_home_assistant-interactive-runtime-sensitive-read",
        },
        "/usr/share/ca-certificates/** r,": {
            "antigravity_home_assistant-interactive-runtime-restricted",
            "antigravity_home_assistant-interactive-runtime-sensitive-read",
        },
        "/usr/share/mime/mime.cache r,": {
            "antigravity_home_assistant-browser"
        },
        "/var/cache/fontconfig/ rw,": {
            "antigravity_home_assistant-browser"
        },
        "/var/cache/fontconfig/* rwkl,": {
            "antigravity_home_assistant-browser"
        },
        "/var/tmp/ r,": {
            "antigravity_home_assistant-browser"
        },
        "/dev/ r,": {
            "antigravity_home_assistant",
            "antigravity_home_assistant-browser",
            "antigravity_home_assistant-command",
            "antigravity_home_assistant-init",
            "antigravity_home_assistant-interactive-runtime-restricted",
            "antigravity_home_assistant-interactive-runtime-sensitive-read",
            "antigravity_home_assistant-settings-update",
            "antigravity_home_assistant-shell",
            "antigravity_home_assistant-sshd",
        },
        "/dev/pts/ r,": {
            "antigravity_home_assistant",
            "antigravity_home_assistant-browser",
            "antigravity_home_assistant-command",
            "antigravity_home_assistant-interactive-runtime-restricted",
            "antigravity_home_assistant-interactive-runtime-sensitive-read",
            "antigravity_home_assistant-shell",
            "antigravity_home_assistant-sshd",
        },
        "/dev/ptmx rw,": {
            "antigravity_home_assistant",
            "antigravity_home_assistant-shell",
            "antigravity_home_assistant-sshd",
        },
        "/root/.bashrc r,": {
            "antigravity_home_assistant-shell"
        },
        "/run/utmp rwk,": {
            "antigravity_home_assistant-shell",
            "antigravity_home_assistant-sshd",
        },
        "/var/log/wtmp rwk,": {
            "antigravity_home_assistant-shell",
            "antigravity_home_assistant-sshd",
        },
        "/config/antigravity-workspace/ rw,": {
            "antigravity_home_assistant-ha-helper"
        },
        "/config/antigravity-workspace/feedback/ rw,": {
            "antigravity_home_assistant-ha-helper"
        },
        "/config/antigravity-workspace/feedback/** rwkl,": {
            "antigravity_home_assistant-ha-helper"
        },
        "deny /usr/local/libexec/antigravity-real x,": {
            "antigravity_home_assistant-ha-helper"
        },
    }
    for rule, expected_profiles in expected_profiles_by_rule.items():
        actual_profiles = {
            name for name, rules in rules_by_profile.items() if rule in rules
        }
        assert actual_profiles == expected_profiles
        assert source.count(f"  {rule}\n") == len(expected_profiles)

    sshd_profile = profiles["antigravity_home_assistant-sshd"]
    helper_profile = profiles["antigravity_home_assistant-ha-helper"]
    browser_profile = profiles["antigravity_home_assistant-browser"]
    for native_runtime in (
        "antigravity_home_assistant-interactive-runtime-restricted",
        "antigravity_home_assistant-interactive-runtime-sensitive-read",
    ):
        assert "/usr/share/** r," not in profiles[native_runtime]
    assert "/proc/self/oom_score_adj rw," not in source
    assert "/proc/** rw," not in sshd_profile
    assert "/config/** r," in helper_profile
    assert "/config/** rwkl," not in helper_profile
    assert "/usr/local/libexec/antigravity-real rix," not in helper_profile
    assert "/usr/local/libexec/antigravity-real Px" not in helper_profile
    for shadowing_deny in (
        "deny /config/ rwklm,",
        "deny /config/** rwklm,",
        "deny /config/ rwklmx,",
        "deny /config/** rwklmx,",
    ):
        assert shadowing_deny not in helper_profile
    assert "/usr/lib/chromium/** rix," not in source
    assert "/usr/local/bin/** r," not in profiles[
        "antigravity_home_assistant-playwright-bootstrap"
    ]
    assert "/usr/local/libexec/** r," not in browser_profile
    assert "/usr/share/** r," not in browser_profile
    assert "/var/cache/** rwkl," not in source
    assert "/var/cache/fontconfig/** rwkl," not in source
    assert "/var/tmp/** rwk," not in source
    assert "/var/tmp/** rwkl," not in source
    assert "/var/log/** rwk," not in source
    assert "/dev/** r," not in source
    assert "/dev/pts/** r," not in source
    assert "/dev/pts/** rw," not in browser_profile
    assert "/root/** r," not in source


def test_apparmor_uses_resolved_owner_proc_paths_for_runtime_self_access(
    addon_root: Path,
) -> None:
    source = (addon_root / "apparmor.txt").read_text(encoding="utf-8")
    profiles = {
        name: _apparmor_profile(source, name)
        for name in EXPECTED_APPARMOR_PROFILES
    }
    rules_by_profile = {
        name: {line.strip() for line in profile.splitlines()}
        for name, profile in profiles.items()
    }
    broker_bootstrap = profiles[
        "antigravity_home_assistant-broker-bootstrap"
    ]
    owner_fd_directory = "owner @{PROC}@{pid}/fd/ r,"
    owner_fd_descriptors = (
        "owner @{PROC}@{pid}/fd/"
        "{[1-9],[1-9][0-9],[1-9][0-9][0-9],"
        "[1-9][0-9][0-9][0-9]} r,"
    )

    # AppArmor mediates the numeric path after /proc/self is resolved. Limit
    # the bootstrap exception to owner-owned descriptor entries accepted by
    # supervisor-credential.sh (1..9999), without opening another proc tree.
    assert {
        name for name, rules in rules_by_profile.items()
        if owner_fd_directory in rules
    } == {"antigravity_home_assistant-broker-bootstrap"}
    assert {
        name for name, rules in rules_by_profile.items()
        if owner_fd_descriptors in rules
    } == {"antigravity_home_assistant-broker-bootstrap"}
    assert "/proc/self/" not in broker_bootstrap
    assert "/proc/** r," not in broker_bootstrap
    assert "/proc/** rw," not in broker_bootstrap
    assert "owner @{PROC}@{pid}/fd/** r," not in source
    assert "owner @{PROC}@{pid}/fd/* r," not in source

    # Explicit denies take precedence over allows, so the generic fd denies
    # remain everywhere except the profile that must consume the inherited
    # Supervisor credential descriptor.
    for shadowing_deny in (
        "deny @{PROC}@{pid}/fd/ r,",
        "deny @{PROC}@{pid}/fd/** rwklm,",
    ):
        assert shadowing_deny not in broker_bootstrap
        assert shadowing_deny in profiles["antigravity_home_assistant"]
        assert shadowing_deny in profiles[
            "antigravity_home_assistant-change-broker"
        ]
        assert shadowing_deny in profiles[
            "antigravity_home_assistant-read-broker"
        ]
    for long_running_broker in (
        "antigravity_home_assistant-change-broker",
        "antigravity_home_assistant-read-broker",
    ):
        assert owner_fd_directory not in profiles[long_running_broker]
        assert owner_fd_descriptors not in profiles[long_running_broker]
    for runtime, target in (
        ("ha-change-broker-runtime", "antigravity_home_assistant-change-broker"),
        ("ha-read-broker-runtime", "antigravity_home_assistant-read-broker"),
    ):
        transition = f"/usr/local/libexec/{runtime} Px -> {target},"
        assert transition in broker_bootstrap
        assert source.count(f"  {transition}\n") == 1


def test_custom_apparmor_profile_protects_home_assistant_secrets(
    addon_root: Path,
) -> None:
    profile_path = addon_root / "apparmor.txt"
    profile = profile_path.read_text(encoding="utf-8")
    main_profile, _interactive_profiles = profile.split(
        "profile antigravity_home_assistant-interactive-restricted", maxsplit=1
    )
    restricted_profile = _apparmor_profile(
        profile,
        "antigravity_home_assistant-interactive-runtime-restricted",
    )
    sensitive_profile = _apparmor_profile(
        profile,
        "antigravity_home_assistant-interactive-runtime-sensitive-read",
    )
    command_profile = _apparmor_profile(
        profile, "antigravity_home_assistant-command"
    )
    settings_profile = _apparmor_profile(
        profile, "antigravity_home_assistant-settings-update"
    )
    restricted_bootstrap = _apparmor_profile(
        profile, "antigravity_home_assistant-interactive-restricted"
    )
    sensitive_bootstrap = _apparmor_profile(
        profile, "antigravity_home_assistant-interactive-sensitive-read"
    )
    remaining_profiles = profile.split(
        "profile antigravity_home_assistant-init", maxsplit=1
    )[1]
    sshd_profile = remaining_profiles.split(
        "profile antigravity_home_assistant-sshd", maxsplit=1
    )[1].split("profile antigravity_home_assistant-ha-helper", maxsplit=1)[0]
    helper_profile = remaining_profiles.split(
        "profile antigravity_home_assistant-ha-helper", maxsplit=1
    )[1].split("profile antigravity_home_assistant-telegram-admin", maxsplit=1)[0]
    telegram_admin_profile = remaining_profiles.split(
        "profile antigravity_home_assistant-telegram-admin", maxsplit=1
    )[1].split(
        "profile antigravity_home_assistant-telegram flags", maxsplit=1
    )[0]
    telegram_profile = _apparmor_profile(
        profile, "antigravity_home_assistant-telegram"
    )
    proposal_client_profile = _apparmor_profile(
        profile, "antigravity_home_assistant-change-proposal-client"
    )
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
    assert "/run/{s6,s6-rc*,service}/ rw," in main_profile
    assert "/run/{s6,s6-rc*,service}/** rwkix," in main_profile
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
        "/usr/local/bin/web-terminal-entrypoint Px -> "
        "antigravity_home_assistant-shell,"
    ) in init_profile
    assert (
        "/usr/local/bin/web-terminal-entrypoint Px -> "
        "antigravity_home_assistant-shell,"
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
    assert (
        "/usr/local/libexec/antigravity-real Px -> "
        "antigravity_home_assistant-interactive-runtime-restricted,"
    ) in restricted_bootstrap
    assert (
        "/usr/local/libexec/antigravity-real Px -> "
        "antigravity_home_assistant-interactive-runtime-sensitive-read,"
    ) in sensitive_bootstrap
    assert "/usr/bin/stat rix," not in restricted_bootstrap
    assert "/usr/bin/stat rix," in sensitive_bootstrap
    for bootstrap_profile in (restricted_bootstrap, sensitive_bootstrap):
        assert "/etc/ld.so.cache r," in bootstrap_profile
        assert "/etc/nsswitch.conf r," in bootstrap_profile
        assert "/etc/passwd r," in bootstrap_profile
        assert "/etc/** r," not in bootstrap_profile
    assert profile.count("  /etc/nsswitch.conf r,\n") == 2
    assert profile.count("  /etc/passwd r,\n") == 2
    for runtime_profile in (restricted_profile, sensitive_profile):
        assert "/bin/** Px -> antigravity_home_assistant-command," in runtime_profile
        assert "/usr/bin/** Px -> antigravity_home_assistant-command," in runtime_profile
        assert "/usr/local/libexec/antigravity-native-env r," in runtime_profile
        assert "/usr/local/libexec/antigravity-real rm," in runtime_profile
        assert "/usr/local/libexec/antigravity-real r," not in runtime_profile
        assert "/usr/local/libexec/antigravity-real rix," not in runtime_profile
        assert (
            "deny /data/home/.gemini/antigravity-cli/settings.json wklm,"
            in runtime_profile
        )
    assert profile.count("  /usr/local/libexec/antigravity-real rm,\n") == 2
    for credential_profile in (
        main_profile,
        restricted_profile,
        sensitive_profile,
        command_profile,
        shell_profile,
    ):
        for credential_directory in (
            ".aws",
            ".azure",
            ".config/gcloud",
            ".kube",
        ):
            assert (
                f"deny /data/home/{credential_directory}/ rwklm,"
                in credential_profile
            )
            assert (
                f"deny /data/home/{credential_directory}/** rwklm,"
                in credential_profile
            )
        for credential_file in (
            ".docker/config.json{,.*}",
            ".netrc",
            ".npmrc",
        ):
            assert (
                f"deny /data/home/{credential_file} rwklm,"
                in credential_profile
            )
    assert "deny /run/antigravity-ha/supervisor.token rwklm," in (
        main_profile
    )
    assert "/run/antigravity-ha/supervisor.token r," in helper_profile
    assert "/run/antigravity-ha/supervisor.token rw," not in helper_profile
    assert "deny /run/antigravity-ha/supervisor.token wklm," in (
        helper_profile
    )
    for broad_runtime_write in (
        "/run/antigravity-ha/** w,",
        "/run/antigravity-ha/** rw,",
        "/run/antigravity-ha/** rwk,",
        "/run/antigravity-ha/** rwkl,",
    ):
        assert broad_runtime_write not in helper_profile
    assert "deny /data/options.json rwklm," in helper_profile
    assert "/run/antigravity-ha/ha-feedback-options.json r," in helper_profile
    assert "deny /data/options.json rwklm," in playwright_bootstrap_profile
    assert "/run/antigravity-ha/ha-feedback-options.json r," in (
        playwright_bootstrap_profile
    )
    assert "/usr/local/bin/antigravity rix," in telegram_profile
    assert (
        "/usr/local/libexec/antigravity-interactive-restricted Px -> "
        "antigravity_home_assistant-interactive-restricted,"
    ) in telegram_profile
    assert (
        "/usr/local/libexec/antigravity-interactive-sensitive-read Px -> "
        "antigravity_home_assistant-interactive-sensitive-read,"
    ) in telegram_profile
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
    assert (
        "/usr/local/bin/ha-telegram-pair Px -> "
        "antigravity_home_assistant-telegram-admin,"
    ) in shell_profile
    assert (
        "tmux-session-shell,web-terminal-entrypoint} rix,"
    ) in shell_profile
    assert "ha-telegram-login" not in profile
    assert "ha-telegram-worker" not in profile
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
        proposal_client_profile
    )
    assert "Px -> antigravity_home_assistant-ha-helper" not in (
        proposal_client_profile
    )
    assert "deny /config/ rwklm," in proposal_client_profile
    assert "deny /config/** rwklm," in proposal_client_profile
    assert "deny /run/antigravity-ha/change-broker.sock rwklm," in (
        proposal_client_profile
    )
    assert "deny /data/options.json rwklm," in proposal_client_profile
    assert (
        "/usr/local/bin/ha-change-proposal-mcp Px -> "
        "antigravity_home_assistant-change-proposal-client,"
    ) in restricted_profile
    assert (
        "/usr/local/bin/ha-change-proposal-mcp Px -> "
        "antigravity_home_assistant-change-proposal-client,"
    ) in sensitive_profile
    for removed_profile in (
        "profile antigravity_home_assistant-telegram-login",
        "profile antigravity_home_assistant-telegram-worker",
        "profile antigravity_home_assistant-memory-telegram",
        "profile antigravity_home_assistant-playwright-bootstrap-telegram",
        "profile antigravity_home_assistant-browser-telegram",
    ):
        assert removed_profile not in profile
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

    always_blocked_paths = (
        "/config/secrets.yaml",
        "/config/secrets.yaml.*",
        "/config/.storage/",
        "/config/.storage/**",
    )
    for sensitive_path in always_blocked_paths:
        assert f"deny {sensitive_path} rwklmx," in restricted_profile
        assert f"deny {sensitive_path} rwklmx," in sensitive_profile
        assert f"{sensitive_path} r," not in sensitive_profile
    assert f"deny {recorder_glob} rwklmx," in restricted_profile
    assert f"{recorder_glob} r," in sensitive_profile
    assert f"deny {recorder_glob} wklmx," in sensitive_profile

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
    assert "/data/home/**" not in command_profile
    assert "/data/home/.gemini/GEMINI.md rwkl," in command_profile
    assert (
        "deny /data/home/.gemini/antigravity-cli/settings.json rwklm,"
        in command_profile
    )
    assert "deny /run/antigravity-ha/supervisor.token rwklm," in command_profile
    assert "deny /config/secrets.yaml rwklmx," in command_profile
    assert (
        "/usr/local/bin/agy-settings Px -> "
        "antigravity_home_assistant-settings-update,"
    ) in command_profile
    assert (
        "/data/home/.gemini/antigravity-cli/settings.json rwk,"
        in settings_profile
    )
    assert "/data/home/**" not in settings_profile
    assert "deny /data/home/.gemini/antigravity-cli/oauth* rwklm," in settings_profile
    assert "deny /data/options.json rwklm," in settings_profile
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
        command_profile,
        settings_profile,
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
                "antigravity_home_assistant-telegram",
                "antigravity_home_assistant-change-proposal-client",
                "antigravity_home_assistant-read-client",
                "antigravity_home_assistant-memory",
                "antigravity_home_assistant-playwright-bootstrap",
                "antigravity_home_assistant-browser",
            )
    )
    for isolated_profile in isolated_profiles:
        for deny_rule in proc_denies:
            assert deny_rule in isolated_profile


def test_universal_telegram_approval_has_one_way_apparmor_boundaries(
    addon_root: Path,
) -> None:
    source = (addon_root / "apparmor.txt").read_text(encoding="utf-8")
    restricted = _apparmor_profile(
        source, "antigravity_home_assistant-interactive-runtime-restricted"
    )
    sensitive = _apparmor_profile(
        source, "antigravity_home_assistant-interactive-runtime-sensitive-read"
    )
    command = _apparmor_profile(source, "antigravity_home_assistant-command")
    telegram = _apparmor_profile(
        source, "antigravity_home_assistant-telegram"
    )
    proposal = _apparmor_profile(
        source, "antigravity_home_assistant-telegram-action-proposal-client"
    )
    executor = _apparmor_profile(
        source, "antigravity_home_assistant-telegram-action-executor"
    )
    init = _apparmor_profile(source, "antigravity_home_assistant-init")

    proposal_transition = (
        "/usr/local/bin/telegram-action-proposal-mcp Px -> "
        "antigravity_home_assistant-telegram-action-proposal-client,"
    )
    for native_runtime in (restricted, sensitive):
        assert proposal_transition in native_runtime
        assert "deny /run/antigravity-ha/telegram-action-proposal.sock rwklm," in (
            native_runtime
        )
    assert source.count(proposal_transition) == 2

    # A model-controlled shell descendant cannot re-enter the universal-action
    # proposal client. Only the native MCP server process may cross that
    # boundary.
    assert proposal_transition not in command
    assert "telegram-action-proposal-mcp Px" not in command
    assert "deny /run/antigravity-ha/telegram-action-proposal.sock rwklm," in (
        command
    )

    executor_transition = (
        "/usr/local/bin/telegram-action-executor Px -> "
        "antigravity_home_assistant-telegram-action-executor,"
    )
    assert executor_transition in telegram
    assert source.count(executor_transition) == 1
    assert "/run/antigravity-ha/telegram-action-proposal.sock rwk," in telegram
    for settings_path in (
        "/data/home/ r,",
        "/data/home/.gemini/ r,",
        "/data/home/.gemini/antigravity-cli/ r,",
        "/data/home/.gemini/antigravity-cli/settings.json r,",
    ):
        assert settings_path in telegram
    assert "deny /data/home/** wklm," in telegram
    assert "/data/home/** r" not in telegram
    assert "/run/antigravity-ha/telegram-action-proposal.sock rw," in proposal
    assert "network unix stream," in proposal
    assert "network," not in proposal
    assert "deny /data/** rwklm," in proposal
    assert "deny /config/** rwklm," in proposal

    for credential_path in (
        "/run/antigravity-ha/supervisor.token",
        "/run/antigravity-ha/home-assistant-browser.token",
        "/etc/shadow",
        "/etc/gshadow",
        "/etc/ssh/ssh_host_*",
        "/etc/ssl/private/**",
        "/root/.ssh/**",
    ):
        assert f"deny {credential_path} rwklm," in proposal

    assert "  network" not in executor
    assert (
        "/usr/local/libexec/antigravity-command-bin/bash Px -> "
        "antigravity_home_assistant-command,"
    ) in executor
    assert "deny /run/antigravity-ha/** rwklm," in executor
    assert "deny /data/home/.gemini/antigravity-cli/settings.json rwklm," in (
        executor
    )
    assert "deny /data/home/.gemini/config/mcp_config.json rwklm," in executor
    assert "deny /config/.storage/ rwklm," in executor
    assert "deny /config/.storage/** rwklm," in executor
    assert "deny /config/{.ssh,ssl,backups,.cloud}/ rwklm," in executor
    assert "deny /config/{.ssh,ssl,backups,.cloud}/** rwklm," in executor
    for credential_path in (
        "/data/home/.docker/config.json{,.*}",
        "/data/home/.netrc",
        "/data/home/.npmrc",
        "/etc/shadow",
        "/etc/gshadow",
        "/etc/ssh/ssh_host_*",
        "/etc/ssl/private/**",
        "/root/.ssh/**",
    ):
        assert f"deny {credential_path} rwklm," in executor

    # Init has a deliberately broad transient /run grant, so the private
    # approval socket needs an explicit exception there as well.
    assert "/run/antigravity-ha/** rwk," in init
    assert "deny /run/antigravity-ha/telegram-action-proposal.sock rwklm," in init


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
        # Generic model-spawned binaries intentionally cross into the command
        # child profile. They are image/runtime globs, not local startup
        # wrappers whose shell prologue can be inspected here.
        if any(character in absolute_path for character in ("*", "?", "[")):
            continue
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
    assert "telegram_access_mode" not in addon_config["options"]
    assert "telegram_access_mode" not in addon_config["schema"]
    assert addon_config["options"]["antigravity_tool_permission"] == (
        "request-review"
    )
    assert addon_config["schema"]["antigravity_tool_permission"] == (
        "list(request-review|proceed-in-sandbox|always-proceed|strict)"
    )
    assert addon_config["options"]["antigravity_terminal_sandbox"] is False
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
