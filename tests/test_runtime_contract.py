import os
import re
import stat
from pathlib import Path


S6_ROOT = Path("etc/s6-overlay/s6-rc.d")
S6_SERVICES = (
    "antigravity-ha-init",
    "ha-memoryd",
    "ha-change-broker",
    "ha-read-broker",
    "ttyd",
    "ingress",
    "sshd",
    "telegram-bot",
)
EXECUTABLE_ROOTFS_PATHS = (
    "etc/s6-overlay/s6-rc.d/antigravity-ha-init/run",
    "etc/s6-overlay/s6-rc.d/ha-change-broker/run",
    "etc/s6-overlay/s6-rc.d/ha-memoryd/run",
    "etc/s6-overlay/s6-rc.d/ha-read-broker/run",
    "etc/s6-overlay/s6-rc.d/ingress/finish",
    "etc/s6-overlay/s6-rc.d/ingress/run",
    "etc/s6-overlay/s6-rc.d/sshd/finish",
    "etc/s6-overlay/s6-rc.d/sshd/run",
    "etc/s6-overlay/s6-rc.d/telegram-bot/run",
    "etc/s6-overlay/s6-rc.d/ttyd/finish",
    "etc/s6-overlay/s6-rc.d/ttyd/run",
)


def test_s6_user_bundle_and_dependency_graph(rootfs: Path) -> None:
    s6_root = rootfs / S6_ROOT
    contents = s6_root / "user/contents.d"
    assert {path.name for path in contents.iterdir()} == set(S6_SERVICES)

    assert (s6_root / "antigravity-ha-init/type").read_text().strip() == "oneshot"
    assert (s6_root / "antigravity-ha-init/up").is_file()
    assert (s6_root / "antigravity-ha-init/dependencies.d/base").is_file()

    for service in ("ha-memoryd", "ha-read-broker", "ttyd", "ingress", "sshd"):
        assert (s6_root / service / "type").read_text().strip() == "longrun"

    assert (s6_root / "ha-memoryd/dependencies.d/antigravity-ha-init").is_file()
    assert (s6_root / "ha-read-broker/dependencies.d/antigravity-ha-init").is_file()
    assert (s6_root / "ttyd/dependencies.d/antigravity-ha-init").is_file()
    assert (s6_root / "sshd/dependencies.d/antigravity-ha-init").is_file()
    assert (s6_root / "ingress/dependencies.d/ttyd").is_file()


def test_s6_entrypoints_have_container_executable_policy(
    addon_root: Path, rootfs: Path
) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    for relative_path in EXECUTABLE_ROOTFS_PATHS:
        script = rootfs / relative_path
        assert script.read_text(encoding="utf-8").startswith(
            "#!/command/with-contenv bashio\n"
        )
        assert f"/{relative_path}" in dockerfile
        if os.name != "nt":
            assert script.stat().st_mode & stat.S_IXUSR


def test_entrypoints_are_executable_and_sourced_shell_libraries_are_not(
    rootfs: Path,
) -> None:
    for directory in (rootfs / "usr/local/bin", rootfs / "usr/local/libexec"):
        for entrypoint in directory.iterdir():
            if entrypoint.is_file() and os.name != "nt":
                assert entrypoint.stat().st_mode & stat.S_IXUSR, entrypoint

    source_only = (
        "etc/profile.d/antigravity-ha.sh",
        "usr/local/lib/antigravity-ha/api-client.sh",
        "usr/local/lib/antigravity-ha/browser-approval.sh",
        "usr/local/lib/antigravity-ha/config.sh",
        "usr/local/lib/antigravity-ha/environment.sh",
        "usr/local/lib/antigravity-ha/supervisor-credential.sh",
    )
    if os.name != "nt":
        for relative_path in source_only:
            library = rootfs / relative_path
            assert library.is_file()
            assert not (library.stat().st_mode & stat.S_IXUSR), library


def test_universal_telegram_action_runtime_is_packaged_and_syntax_checked(
    addon_root: Path,
    rootfs: Path,
) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    for wrapper_name in (
        "telegram-action-executor",
        "telegram-action-proposal-mcp",
    ):
        wrapper = rootfs / "usr/local/bin" / wrapper_name
        assert wrapper.is_file()
        if os.name != "nt":
            assert wrapper.stat().st_mode & stat.S_IXUSR

    for module_name in (
        "telegram-action-coordinator.mjs",
        "telegram-action-executor.mjs",
        "telegram-action-proposal-mcp.mjs",
    ):
        module = rootfs / "usr/local/share/antigravity-ha" / module_name
        assert module.is_file()
        assert f"/usr/local/share/antigravity-ha/{module_name}" in dockerfile
        assert (
            f"node --check /usr/local/share/antigravity-ha/{module_name}"
            in dockerfile
        )


def test_universal_telegram_action_installed_path_is_in_candidate_smoke(
    repository_root: Path,
) -> None:
    docker_smoke = (repository_root / "tests/docker-smoke.sh").read_text(
        encoding="utf-8"
    )
    action_smoke = (
        repository_root / "tests/telegram-universal-action-smoke.sh"
    ).read_text(encoding="utf-8")
    fixture = (
        repository_root
        / "tests/fixtures/telegram-universal-action-image-smoke.mjs"
    ).read_text(encoding="utf-8")
    candidate_workflow = (
        repository_root / ".github/workflows/build-app.yaml"
    ).read_text(encoding="utf-8")

    assert "tests/telegram-universal-action-smoke.sh" in docker_smoke
    assert "--network none" in action_smoke
    assert "--read-only" in action_smoke
    assert "--cap-drop ALL" in action_smoke
    assert "--security-opt no-new-privileges" in action_smoke
    for installed_path in (
        "/usr/local/bin/telegram-action-proposal-mcp",
        "/usr/local/bin/telegram-action-executor",
        "/usr/local/share/antigravity-ha/telegram-action-coordinator.mjs",
    ):
        assert installed_path in fixture
    assert 'operation: "multi_choice_terminal"' in fixture
    assert "execution_digest: selected.execution_digest" in fixture
    assert "suite: container" in candidate_workflow
    assert 'container) exec bash tests/docker-smoke.sh "$image"' in (
        candidate_workflow
    )


def test_antigravity_release_is_pinned_and_verified(addon_root: Path) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    version_match = re.search(
        r"^ARG ANTIGRAVITY_VERSION=([^\s]+)$",
        dockerfile,
        re.MULTILINE,
    )

    assert version_match
    assert version_match.group(1) == "1.1.13"
    assert "ARG ANTIGRAVITY_BUILD=6057583128215552" in dockerfile
    assert "ARG ANTIGRAVITY_AMD64_SHA512=" in dockerfile
    assert "ARG ANTIGRAVITY_ARM64_SHA512=" in dockerfile
    assert "antigravity-public/antigravity-cli" in dockerfile
    assert "antigravity_platform=linux-x64" in dockerfile
    assert "antigravity_platform=linux-arm" in dockerfile
    assert "cli_linux_x64.tar.gz" in dockerfile
    assert "cli_linux_arm64.tar.gz" in dockerfile
    assert "sha512sum --check --strict -" in dockerfile
    assert "antigravity-real" in dockerfile
    assert dockerfile.count(
        'antigravity_version_output="$(/usr/local/libexec/antigravity-real --version)"'
    ) == 2
    assert (addon_root / "rootfs/usr/local/bin/antigravity").is_file()
    assert (addon_root / "rootfs/usr/local/bin/agy").is_file()


def test_native_self_updater_is_disabled_at_every_antigravity_boundary(
    addon_root: Path,
    repository_root: Path,
    rootfs: Path,
) -> None:
    disable_contract = "AGY_CLI_DISABLE_AUTO_UPDATE=true"
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    environment = (
        rootfs / "usr/local/lib/antigravity-ha/environment.sh"
    ).read_text(encoding="utf-8")
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    telegram_runtime = (
        rootfs / "usr/local/libexec/ha-telegram-runtime"
    ).read_text(encoding="utf-8")
    telegram_bridge = (
        rootfs / "usr/local/share/antigravity-ha/telegram-bridge.mjs"
    ).read_text(encoding="utf-8")
    feedback = (
        rootfs / "usr/local/share/antigravity-ha/ha-feedback.mjs"
    ).read_text(encoding="utf-8")
    managed_plugin_update = (
        rootfs / "usr/local/share/antigravity-ha/managed-plugin-update.mjs"
    ).read_text(encoding="utf-8")
    native_session_guard = (
        rootfs / "usr/local/libexec/antigravity-native-session-guard"
    ).read_text(encoding="utf-8")
    docker_smoke = (repository_root / "tests/docker-smoke.sh").read_text(
        encoding="utf-8"
    )

    assert f"ENV {disable_contract}" in dockerfile
    assert f"export {disable_contract}" in environment
    assert disable_contract in init_script
    assert 'AGY_CLI_DISABLE_AUTO_UPDATE: "true"' in managed_plugin_update
    for launcher_name in (
        "antigravity-interactive-restricted",
        "antigravity-interactive-sensitive-read",
    ):
        launcher = (rootfs / "usr/local/libexec" / launcher_name).read_text(
            encoding="utf-8"
        )
        assert disable_contract in launcher
        assert "/usr/local/libexec/antigravity-native-session-guard" in launcher
    assert "exec /usr/local/libexec/antigravity-native-env -i" in native_session_guard
    assert disable_contract in native_session_guard
    assert disable_contract in telegram_runtime
    assert 'AGY_CLI_DISABLE_AUTO_UPDATE: "true"' in telegram_bridge
    assert 'AGY_CLI_DISABLE_AUTO_UPDATE: "true"' in feedback

    # This is an environment contract, not an invented settings.json key.
    image_settings = (rootfs / "etc/antigravity/settings.json").read_text(
        encoding="utf-8"
    )
    assert "AUTO_UPDATE" not in image_settings
    assert "autoUpdate" not in image_settings

    assert "PINNED_ANTIGRAVITY_VERSION" in docker_smoke
    assert "Auto-update disabled via environment variable" in docker_smoke
    assert "Spawned background update process" in docker_smoke
    assert "--network none" in docker_smoke


def test_multi_arch_dependencies_are_pinned_and_verified(
    addon_root: Path,
) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")

    assert (
        "ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:bookworm@sha256:"
        in dockerfile
    )
    for dependency in ("NODE", "GH", "TTYD"):
        assert f"ARG {dependency}_AMD64_SHA256=" in dockerfile
        assert f"ARG {dependency}_ARM64_SHA256=" in dockerfile
    assert "arm64 | aarch64)" in dockerfile
    assert "node_arch=arm64" in dockerfile
    assert "gh_arch=arm64" in dockerfile
    assert "ttyd_arch=aarch64" in dockerfile
    assert dockerfile.count("sha256sum --check --strict -") >= 3


def test_ci_builds_and_smokes_both_supported_architectures(
    repository_root: Path,
) -> None:
    workflow = (repository_root / ".github/workflows/ci.yaml").read_text(
        encoding="utf-8"
    )
    arm64_smoke = (
        repository_root / "tests/arm64-emulated-smoke.sh"
    ).read_text(encoding="utf-8")

    assert "Build linux/amd64 image once" in workflow
    assert "linux/amd64 smoke (${{ matrix.suite }})" in workflow
    assert "fail-fast: false" in workflow
    assert "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" in (
        workflow
    )
    assert "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c" in (
        workflow
    )
    assert "linux/arm64 emulated build and smoke" in workflow
    assert "docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130" in (
        workflow
    )
    assert workflow.count("tools/development/build-app build") == 2
    assert "docker build" not in workflow
    assert "docker buildx" not in workflow
    assert "linux/amd64" in workflow
    assert "linux/arm64" in workflow
    assert "tests/arm64-emulated-smoke.sh" in workflow
    assert "--platform linux/arm64" in arm64_smoke
    assert "AGY_CLI_DISABLE_AUTO_UPDATE" in arm64_smoke
    assert "/usr/local/libexec/antigravity-real --version" in arm64_smoke
    assert "chromium --version" in arm64_smoke


def test_ci_image_handoff_uses_only_bounded_conditional_package_installs(
    repository_root: Path,
) -> None:
    workflow = (repository_root / ".github/workflows/ci.yaml").read_text(
        encoding="utf-8"
    )

    def step_body(name: str) -> str:
        marker = f"      - name: {name}\n"
        body = workflow.split(marker, 1)[1]
        return body.split("\n      - name: ", 1)[0]

    export_step = step_body("Export the image once for independent smoke jobs")
    load_step = step_body("Load the workflow image")
    conditional = "if ((${#packages[@]} > 0)); then"

    for step in (export_step, load_step):
        assert "packages=()" in step
        assert "command -v zstd >/dev/null 2>&1 || packages+=(zstd)" in step
        assert conditional in step
        assert step.index("command -v zstd") < step.index(conditional)
        assert "sudo apt-get update" not in step
        assert "Acquire::Retries=2" in step
        assert "Acquire::http::Timeout=15" in step
        assert "Acquire::https::Timeout=15" in step
        assert step.count("timeout --signal=TERM --kill-after=10s 120s") == 2
        install_block = step.split(conditional, 1)[1].split("\n          fi", 1)[0]
        assert 'apt-get "${apt_options[@]}" update' in install_block
        assert 'apt-get "${apt_options[@]}" install' in install_block
        assert "--yes --no-install-recommends" in install_block

    assert "apparmor" not in export_step
    assert "! command -v apparmor_parser >/dev/null 2>&1" in load_step
    assert "packages+=(apparmor)" in load_step
    assert load_step.count("command -v apparmor_parser >/dev/null 2>&1") == 2


def test_ci_shellcheck_install_is_conditional_and_bounded(
    repository_root: Path,
) -> None:
    workflow = (repository_root / ".github/workflows/ci.yaml").read_text(
        encoding="utf-8"
    )
    step = workflow.split("      - name: Run ShellCheck\n", 1)[1].split(
        "\n      - name: ", 1
    )[0]

    assert "if ! command -v shellcheck >/dev/null 2>&1; then" in step
    assert "sudo apt-get update" not in step
    assert "Acquire::Retries=2" in step
    assert "Acquire::http::Timeout=15" in step
    assert "Acquire::https::Timeout=15" in step
    assert step.count("timeout --signal=TERM --kill-after=10s 120s") == 2
    assert 'apt-get "${apt_options[@]}" update' in step
    assert 'apt-get "${apt_options[@]}" install' in step
    assert "--yes --no-install-recommends shellcheck" in step
    assert step.count("command -v shellcheck >/dev/null 2>&1") == 2
    assert step.rindex("command -v shellcheck") < step.index("git grep")


def test_ci_checks_committed_whitespace_and_generated_artifacts(
    repository_root: Path,
) -> None:
    workflow = (repository_root / ".github/workflows/ci.yaml").read_text(
        encoding="utf-8"
    )
    secret_scan = (repository_root / "tests/test_secret_scan.py").read_text(
        encoding="utf-8"
    )

    assert "fetch-depth: 0" in workflow
    assert 'git diff --check "$PR_BASE_SHA...$HEAD_SHA"' in workflow
    assert 'git diff --check "$EVENT_BEFORE...$HEAD_SHA"' in workflow
    assert 'git show --check --format= "$HEAD_SHA"' in workflow
    assert "git diff --check HEAD" not in workflow
    for fragment in (
        "FORBIDDEN_GENERATED_DIRECTORIES",
        "FORBIDDEN_BUILD_DIRECTORIES",
        "FORBIDDEN_ARTIFACT_SUFFIXES",
        "FORBIDDEN_RUNTIME_MATERIAL_NAMES",
        '"node_modules"',
        '"supervisor.token"',
    ):
        assert fragment in secret_scan


def test_sshd_is_public_key_only(rootfs: Path) -> None:
    sshd_config = (rootfs / "etc/ssh/sshd_config").read_text(encoding="utf-8")
    required_lines = (
        "PubkeyAuthentication yes",
        "AuthenticationMethods publickey",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM no",
        "PermitEmptyPasswords no",
        "PermitRootLogin prohibit-password",
        "AuthorizedKeysFile /data/ssh/authorized_keys",
    )
    for line in required_lines:
        assert line in sshd_config
    permit_environment = next(
        line
        for line in sshd_config.splitlines()
        if line.startswith("PermitUserEnvironment ")
    )
    assert "SUPERVISOR_TOKEN" not in permit_environment
    assert "ANTIGRAVITY_TOKEN" not in permit_environment
    assert "LANG" in permit_environment
    assert "LC_ALL" in permit_environment
    assert "Subsystem sftp /usr/lib/openssh/sftp-server" in sshd_config
    assert "internal-sftp" not in sshd_config


def test_sshd_daemon_and_authenticated_sessions_use_separate_profiles(
    rootfs: Path,
) -> None:
    sshd_run = (rootfs / S6_ROOT / "sshd/run").read_text(encoding="utf-8")
    daemon_launcher = (
        rootfs / "usr/local/libexec/ha-sshd-runtime"
    ).read_text(encoding="utf-8")
    session_launcher = (
        rootfs / "usr/local/libexec/ha-ssh-session"
    ).read_text(encoding="utf-8")
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )

    assert (
        "exec /usr/local/libexec/ha-sshd-runtime "
        "-D -e -f /etc/ssh/sshd_config < /dev/null"
    ) in sshd_run
    assert "/usr/sbin/sshd -D" not in sshd_run
    assert daemon_launcher.splitlines()[:3] == [
        "#!/bin/bash -p",
        "set -Eeuo pipefail",
        "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN",
    ]
    assert 'exec /usr/sbin/sshd "$@"' in daemon_launcher
    assert session_launcher.splitlines()[:3] == [
        "#!/bin/bash -p",
        "set -Eeuo pipefail",
        "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN",
    ]
    assert "export BASH_ENV=/etc/profile.d/antigravity-ha.sh" in session_launcher
    assert "exec /bin/bash -l" in session_launcher
    assert 'exec /bin/bash "$@"' in session_launcher
    assert "eval " not in session_launcher
    assert "SSH_ORIGINAL_COMMAND" not in session_launcher
    assert "usermod -s /usr/local/libexec/ha-ssh-session root" in init_script
    assert "usermod -s /bin/bash root" not in init_script


def test_ttyd_and_nginx_are_split_for_ingress(rootfs: Path) -> None:
    ttyd_run = (rootfs / S6_ROOT / "ttyd/run").read_text(encoding="utf-8")
    ingress_run = (rootfs / S6_ROOT / "ingress/run").read_text(encoding="utf-8")
    nginx_config = (rootfs / "etc/nginx/nginx.conf").read_text(encoding="utf-8")

    assert "--interface 127.0.0.1" in ttyd_run
    assert "--port 7682" in ttyd_run
    assert "--writable" in ttyd_run
    assert "exec nginx" in ingress_run
    assert "listen 7681" in nginx_config
    assert "proxy_pass http://127.0.0.1:7682" in nginx_config
    assert "proxy_set_header Upgrade $http_upgrade" in nginx_config


def test_init_has_idempotent_and_degraded_mode_guards(rootfs: Path) -> None:
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    sshd_run = (rootfs / S6_ROOT / "sshd/run").read_text(encoding="utf-8")

    assert "/usr/local/bin/antigravity-user-files-update" in init_script
    assert "user_files_update_status == 30" in init_script
    assert "existing files were preserved" in init_script
    assert "/etc/antigravity/config.toml" not in init_script
    assert "/config/AGENTS.md" not in init_script
    assert "managed-plugin-update.mjs" in init_script
    assert "/usr/bin/env -i" in init_script
    assert "The new managed plugin was rejected" in (
        rootfs / "usr/local/share/antigravity-ha/managed-plugin-update.mjs"
    ).read_text(encoding="utf-8")
    assert 'if [[ ! -s "${host_key}" ]]' in init_script
    assert 'rm -f "${host_key}" "${host_key}.pub"' in init_script
    assert 'ssh-keygen -y -f "${host_key}"' in init_script
    assert 'chmod 0600 "${SSH_DATA}/authorized_keys"' not in init_script
    assert 'mv -f "${authorized_keys_tmp}" "${SSH_DATA}/authorized_keys"' in init_script
    assert '"${RUNTIME_DIR}/ssh-disabled"' in init_script
    assert "exec /command/s6-pause" in sshd_run


def test_native_plugin_has_home_assistant_safety_rules(rootfs: Path) -> None:
    guidance = (
        rootfs
        / "usr/local/share/antigravity-ha/plugins/home-assistant/rules/home-assistant-safety.md"
    ).read_text(encoding="utf-8")
    normalized_guidance = " ".join(guidance.lower().split())

    assert "live Home Assistant App" in guidance
    assert "Diagnosis does not authorize" in guidance
    assert "run `ha-config-check`" in normalized_guidance
    assert "requester-bound Telegram work" in guidance
    assert "explicitly selected `always-proceed`" in guidance
    assert "ha_change_propose" in guidance
    assert "telegram_action_propose" in guidance
    assert "direct writes, terminal commands" in guidance
    assert "are not an approval path" in guidance
    assert "ordinary requested operations may use direct write, command" in guidance
    assert "MCP result is not approval" in guidance
    assert "authenticated interactive Web-terminal or SSH session" in guidance
    assert "shared native home" in normalized_guidance
    assert "unsupported by the approval bridge" in normalized_guidance
    assert "SUPERVISOR_TOKEN" in guidance
    assert "http://127.0.0.1:8099/" in guidance
    assert "logs, web pages" in normalized_guidance


def test_login_helper_delegates_to_native_first_run_oauth(rootfs: Path) -> None:
    login_helper = (rootfs / "usr/local/bin/ha-antigravity-login").read_text(
        encoding="utf-8"
    )
    controller = (
        rootfs / "usr/local/libexec/antigravity-onboarding-controller"
    ).read_text(encoding="utf-8")
    session_helper = (rootfs / "usr/local/bin/ha-antigravity").read_text(
        encoding="utf-8"
    )
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    native_guard = (
        rootfs / "usr/local/libexec/antigravity-native-session-guard"
    ).read_text(encoding="utf-8")

    assert login_helper.startswith("#!/bin/bash -p\n")
    assert "(( $# != 0 ))" in login_helper
    assert "cd /\n" in login_helper
    assert "trap '' INT QUIT" in login_helper
    assert "/usr/bin/env --default-signal=INT --default-signal=QUIT -i" in login_helper
    assert 'readonly TMUX_SOCKET=/data/tmux/tmux-0/default' in login_helper
    assert "#{pane_id} #{pane_tty}" in login_helper
    assert login_helper.count("%u:%g:%a:%h:%d:%i") == 3
    assert 'clear-history -t "${tmux_target}"' in login_helper
    assert "tmux_cleanup_succeeded=false" in login_helper
    assert login_helper.index("printf '\\033[3J\\033[2J\\033[H'") < (
        login_helper.index('clear-history -t "${tmux_target}"')
    )
    assert "controller_status=80" in login_helper
    assert "controller_status=81" in login_helper
    assert "privacy_cleanup_ready=false" in login_helper
    assert "--privacy-finalize" in login_helper
    assert "shared Web pane history could not be verified as cleared" in login_helper
    assert "remote Terms acceptance was not inferred" in login_helper
    assert "\\033[3J\\033[2J\\033[H" in login_helper
    assert "/usr/local/libexec/antigravity-onboarding-controller" in login_helper
    assert "cd /config" not in login_helper
    assert 'exec antigravity "$@"' not in login_helper

    assert controller.startswith("#!/bin/bash -p\n")
    assert "(( $# != 0 ))" in controller
    assert "--privacy-finalize" in controller
    assert 'privacy_marker_value=$(< "${ACTIVE_MARKER}")' in controller
    for typed_marker in ("partial)", "restart)", "privacy) ;;"):
        assert typed_marker in controller
    assert "finish terminal privacy cleanup" in controller
    assert "privacy_finalize} == false && ( ! -t 0 || ! -t 1 )" in controller
    assert "native-session.lock" in controller
    assert "user-files-update.lock" in controller
    assert "onboarding-active" in controller
    assert controller.count("/usr/bin/flock --exclusive --nonblock") == 2
    assert "onboarding-workspace" in controller
    assert "cd /tmp" not in controller
    assert "trap '' INT QUIT" in controller
    assert (
        "/usr/bin/env --default-signal=INT --default-signal=QUIT -i "
        "PATH=/usr/bin:/bin"
    ) in controller
    assert controller.count("/usr/bin/setpriv --pdeathsig KILL") == 2
    assert "/usr/bin/timeout --foreground --signal=INT --kill-after=5 15m" in controller
    assert "settings_invariant_fingerprint" in controller
    assert "onboarding-settings-fingerprint.mjs" in controller
    assert "onboarding-transaction.mjs" in controller
    assert '"${TRANSACTION_HELPER}" status' in controller
    assert '"${TRANSACTION_HELPER}" commit' in controller
    assert '"${TRANSACTION_HELPER}" finalize' in controller
    assert "complete-restart)" in controller
    assert "restart-required" in controller
    assert "restartRequired" in (
        rootfs
        / "usr/local/share/antigravity-ha/onboarding-transaction.mjs"
    ).read_text(encoding="utf-8")
    assert "SETTINGS_DRAIN_SECONDS" not in controller
    assert "${RUNTIME_DIR}/onboarding-home" in controller
    assert '"${STAGING_HOME}/tmp"' in controller
    assert 'TMPDIR="${STAGING_HOME}/tmp"' in controller
    assert "cache/onboarding.json" in controller
    assert "consumerOnboardingComplete" in controller
    assert "enterpriseOnboardingComplete" in controller
    assert 'and (keys == [' in controller
    assert "current_consumer} == true" in controller
    assert 'current_enterprise} != "${baseline_enterprise}"' in controller
    assert 'baseline_enterprise} != false' in controller
    assert 'current_consumer} == true && ${current_oauth} == absent' in controller
    assert 'native_status} == 0 || ${native_status} == 130' in controller
    assert "onboarding_committed=false" in controller
    assert "incomplete consumer flow discards every staged byte" in controller
    assert "OAuth state is an opaque native credential" in controller
    assert "type == \"object\"" not in controller.split("oauth_state()", 1)[1].split(
        "onboarding_state()", 1
    )[0]
    assert controller.index('"${TRANSACTION_HELPER}" commit') < controller.index(
        'case "${native_status}"'
    )
    assert "personal/consumer Google OAuth flow only" in controller
    assert "Do not select Google Cloud project or enterprise" in controller
    assert "Automatic browser helpers are intentionally disabled" in controller
    assert "Click or copy the displayed HTTPS login link" in controller
    assert "/usr/local/libexec/antigravity-real &" not in controller
    assert "/usr/local/libexec/antigravity-real 8>&- 9>&-" in controller
    assert "No local Terms-acceptance result was inferred" in controller
    assert "Staged authentication and onboarding state were discarded" in controller
    assert "Consumer onboarding was not completed; staged files were discarded" in (
        controller
    )
    assert "exit 76" in controller
    assert '"$@"' not in controller
    for unsafe_environment in (
        "BASH_ENV",
        "LD_PRELOAD",
        "NODE_OPTIONS",
        "PYTHONPATH",
        "SUPERVISOR_TOKEN",
    ):
        assert f"unset " in controller and unsafe_environment in controller

    assert '"${RUNTIME_DIR}/onboarding-workspace"' in init_script
    assert '"${ONBOARDING_HOME}"' in init_script
    assert "native-session.lock" in init_script
    assert "user-files-update.lock" in init_script
    assert "onboarding-active" in init_script
    assert "user_files_reconciled=false" in init_script
    assert "Skipped Antigravity user-file reconciliation while a partial" in init_script
    assert '"${ONBOARDING_TRANSACTION_HELPER}" restart-status' in init_script
    assert '"${ONBOARDING_TRANSACTION_HELPER}" clear-restart' in init_script
    assert "onboarding_restart_state} == absent" in init_script
    assert '"${ONBOARDING_TRANSACTION_HELPER}" marker init' in init_script
    assert '"${ONBOARDING_TRANSACTION_HELPER}" marker clear' in init_script
    assert "NATIVE_OAUTH_TOKEN" in init_script
    assert "! -f ${NATIVE_OAUTH_TOKEN}" in init_script
    assert "native_oauth_links} != 1" in init_script
    assert "native_oauth_size} -gt 1048576" in init_script
    assert 'chmod 0600 "${NATIVE_OAUTH_TOKEN}"' in init_script
    assert "NATIVE_ONBOARDING_MARKER" in init_script
    assert "native_onboarding_size} -gt 4096" in init_script
    assert "all(.[]; type == \"boolean\")" in init_script
    assert "jq --stream --slurp --exit-status" in init_script
    assert "ambiguous duplicate fields" in init_script
    assert "jq --stream --slurp --exit-status" in controller
    assert 'chmod 0600 "${NATIVE_ONBOARDING_MARKER}"' in init_script
    assert init_script.index('chmod 0600 "${NATIVE_OAUTH_TOKEN}"') < (
        init_script.index('"${ONBOARDING_TRANSACTION_HELPER}" marker clear')
    )
    assert native_guard.startswith("#!/bin/bash -p\n")
    assert "onboarding-active" in native_guard
    assert "onboarding-active.tmp" in native_guard
    assert "retry-required.json" in native_guard
    assert "restart-required" in native_guard
    assert "sensitive-data-access.enabled" in native_guard
    assert "exec /usr/local/libexec/antigravity-native-env -i" in native_guard
    assert 'exec antigravity "$@"' in session_helper
    assert "antigravity_BIN" not in session_helper


def test_onboarding_settings_write_is_manual_bounded_and_profile_scoped(
    addon_root: Path,
) -> None:
    source = (addon_root / "apparmor.txt").read_text(encoding="utf-8")

    onboarding = source.split(
        "profile antigravity_home_assistant-onboarding ", maxsplit=1
    )[1].split("\n}\n", maxsplit=1)[0]
    onboarding_runtime = source.split(
        "profile antigravity_home_assistant-onboarding-runtime ", maxsplit=1
    )[1].split("\n}\n", maxsplit=1)[0]
    restricted_bootstrap = source.split(
        "profile antigravity_home_assistant-interactive-restricted ", maxsplit=1
    )[1].split("\n}\n", maxsplit=1)[0]
    sensitive_bootstrap = source.split(
        "profile antigravity_home_assistant-interactive-sensitive-read ",
        maxsplit=1,
    )[1].split("\n}\n", maxsplit=1)[0]
    restricted = source.split(
        "profile antigravity_home_assistant-interactive-runtime-restricted ",
        maxsplit=1,
    )[1].split("\n}\n", maxsplit=1)[0]
    sensitive = source.split(
        "profile antigravity_home_assistant-interactive-runtime-sensitive-read ",
        maxsplit=1,
    )[1].split("\n}\n", maxsplit=1)[0]
    command = source.split(
        "profile antigravity_home_assistant-command ", maxsplit=1
    )[1].split("\n}\n", maxsplit=1)[0]
    shell = source.split(
        "profile antigravity_home_assistant-shell ", maxsplit=1
    )[1].split("\n}\n", maxsplit=1)[0]

    controller_transition = (
        "/usr/local/libexec/antigravity-onboarding-controller "
        "Px -> antigravity_home_assistant-onboarding,"
    )
    native_transition = (
        "/usr/local/libexec/antigravity-real "
        "Px -> antigravity_home_assistant-onboarding-runtime,"
    )
    assert source.count(controller_transition) == 1
    assert controller_transition in shell
    assert native_transition in onboarding
    assert "/bin/bash rix," in onboarding
    assert "/usr/bin/bash rix," in onboarding
    assert "/usr/bin/** rix," not in onboarding
    assert "/data/home/.gemini/antigravity-cli/settings.json rwkl," in onboarding
    assert "/usr/local/share/antigravity-ha/onboarding-transaction.mjs r," in (
        onboarding
    )
    assert "/data/antigravity-ha/onboarding/retry-required.json{,.tmp} rwkl," in (
        onboarding
    )
    assert "/data/antigravity-ha/onboarding/restart-required{,.tmp} rwkl," in (
        onboarding
    )
    assert (
        "/data/home/.gemini/antigravity-cli/cache/onboarding.json rwkl,"
        in onboarding
    )
    assert (
        "/data/home/.gemini/antigravity-cli/cache/"
        "onboarding.json.onboarding.tmp rwkl,"
        in onboarding
    )
    assert "/run/antigravity-ha/onboarding-home/** rwk," in onboarding
    assert "/run/antigravity-ha/native-session.lock rwk," in onboarding
    assert "/run/antigravity-ha/user-files-update.lock rwk," in onboarding
    assert "/run/antigravity-ha/onboarding-active{,.tmp} rwkl," in onboarding
    assert "deny /config/** rwklmx," in onboarding
    assert "deny /tmp/** rwklmx," in onboarding

    assert "/run/antigravity-ha/onboarding-home/** rwk," in onboarding_runtime
    assert "deny /data/home/.gemini/** rwklm," in onboarding_runtime
    assert "deny /data/antigravity-ha/** rwklm," in onboarding_runtime
    assert "deny /config/** rwklmx," in onboarding_runtime
    assert "deny /share/** rwklmx," in onboarding_runtime
    assert "deny /media/** rwklmx," in onboarding_runtime
    assert "deny /tmp/** rwklmx," in onboarding_runtime
    assert "deny /usr/bin/** x," in onboarding_runtime
    assert "deny /usr/local/bin/** x," in onboarding_runtime
    assert "deny /usr/local/libexec/** x," in onboarding_runtime
    assert "/data/home/.gemini/antigravity-cli/*/** rwk," not in onboarding_runtime
    assert "/data/home/.gemini/config/*/** rwk," not in onboarding_runtime
    assert "deny /run/antigravity-ha/native-session.lock rwklm," in (
        onboarding_runtime
    )
    assert "deny /run/antigravity-ha/onboarding-active{,.tmp} rwklm," in (
        onboarding_runtime
    )
    assert " Px -> " not in onboarding_runtime
    assert " rix," not in onboarding_runtime

    for bootstrap in (restricted_bootstrap, sensitive_bootstrap):
        assert "/usr/bin/{env,flock,setpriv,stat} rix," in bootstrap
        assert "/usr/local/libexec/antigravity-native-session-guard rix," in (
            bootstrap
        )
        assert "/run/antigravity-ha/native-session.lock rwk," in bootstrap
        assert "/run/antigravity-ha/onboarding-active{,.tmp} r," in bootstrap
        assert (
            "/data/antigravity-ha/onboarding/"
            "{retry-required.json,restart-required} r," in bootstrap
        )

    settings_deny = (
        "deny /data/home/.gemini/antigravity-cli/settings.json wkl,"
    )
    assert settings_deny in restricted
    assert settings_deny in sensitive
    assert (
        "deny /data/home/.gemini/antigravity-cli/settings.json rwklm,"
        in command
    )
    assert (
        "deny /usr/local/libexec/antigravity-onboarding-controller x,"
        in command
    )
    assert "deny /usr/local/libexec/antigravity-native-session-guard x," in command
    assert "deny /run/antigravity-ha/native-session.lock rwklm," in command
    assert "deny /run/antigravity-ha/onboarding-active{,.tmp} rwklm," in command
    assert "deny /run/antigravity-ha/onboarding-home/** rwklmx," in command
    token_deny = (
        "deny /data/home/.gemini/antigravity-cli/"
        "antigravity-oauth-token{,.*} rwklm,"
    )
    assert token_deny in command
    assert "deny /usr/local/libexec/antigravity-native-session-guard x," in shell
    assert "deny /run/antigravity-ha/native-session.lock rwklm," in shell
    assert "deny /run/antigravity-ha/onboarding-active{,.tmp} rwklm," in shell
    assert "deny /run/antigravity-ha/onboarding-home/** rwklmx," in shell
    assert token_deny in shell
    assert source.count(token_deny) >= 6


def test_boolean_option_reader_accepts_an_explicit_false(rootfs: Path) -> None:
    config_helpers = (
        rootfs / "usr/local/lib/antigravity-ha/config.sh"
    ).read_text(encoding="utf-8")
    bool_reader = config_helpers.split("antigravity_ha_config_bool()", maxsplit=1)[1]
    bool_reader = bool_reader.split("antigravity_ha_config_json()", maxsplit=1)[0]

    assert "jq --raw-output" in bool_reader
    assert "--exit-status" not in bool_reader
    assert (
        "ANTIGRAVITY_HA_OPTIONS_FILE:-/run/antigravity-ha/"
        "ha-feedback-options.json"
    ) in config_helpers


def test_runtime_snapshot_preserves_explicit_autonomous_policy(rootfs: Path) -> None:
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )

    assert '.antigravity_tool_permission == "strict"' in init_script
    assert '.antigravity_tool_permission == "proceed-in-sandbox"' in init_script
    assert '. == "request-review" or . == "always-proceed"' in init_script
    assert 'then "request-review"' in init_script
    assert "normalized to request-review" in init_script


def test_web_terminal_uses_tmux_and_returns_to_shell(rootfs: Path) -> None:
    entrypoint = (rootfs / "usr/local/bin/web-terminal-entrypoint").read_text(
        encoding="utf-8"
    )
    session_shell = (rootfs / "usr/local/bin/tmux-session-shell").read_text(
        encoding="utf-8"
    )
    interactive_shell = (
        rootfs / "usr/local/libexec/ha-interactive-shell"
    ).read_text(encoding="utf-8")

    assert "export TERM=xterm-256color" in entrypoint
    assert '[[ "$1" != --background ]]' in entrypoint
    assert 'new-session -A -s "${session_name}" -c /config' in entrypoint
    assert 'new-session -d -s "${session_name}" -c /config' in entrypoint
    assert session_shell.startswith("#!/usr/bin/env bash\n")
    assert "antigravity_ha_config_true" in session_shell
    assert "web_terminal_auto_start_antigravity" in session_shell
    assert "if ha-antigravity; then" in session_shell
    assert "press Ctrl+C and run ha-antigravity-login" in session_shell
    assert "protected settings save failed, run ha-antigravity-login" in session_shell
    assert "exec /usr/local/libexec/ha-interactive-shell --login" in session_shell
    assert '[[ ! ${TMUX_PANE} =~ ^%[0-9]+$ ]]' in interactive_shell
    assert 'tmux_pane_environment=("TMUX_PANE=${TMUX_PANE}")' in interactive_shell
    assert '"${tmux_pane_environment[@]}"' in interactive_shell


def test_supervisor_credential_is_not_inherited_by_agent_surfaces(rootfs: Path) -> None:
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    environment = (
        rootfs / "usr/local/lib/antigravity-ha/environment.sh"
    ).read_text(encoding="utf-8")
    credential_helper = (
        rootfs / "usr/local/lib/antigravity-ha/supervisor-credential.sh"
    ).read_text(encoding="utf-8")

    assert '"${RUNTIME_DIR}/supervisor.token"' in init_script
    assert 'chmod 0400 "${supervisor_credential_tmp}"' in init_script
    assert "printf 'SUPERVISOR_TOKEN=" not in init_script
    assert "printf 'ANTIGRAVITY_TOKEN=" not in init_script
    assert ". /run/antigravity-ha/runtime.env" not in environment
    assert "unset SUPERVISOR_TOKEN" in environment
    assert "/run/antigravity-ha/supervisor.token" in credential_helper
    assert "stat -c '%u'" in credential_helper
    assert "stat -c '%a'" in credential_helper
    assert "stat -c '%h'" in credential_helper
    assert "antigravity_ha_validate_supervisor_credential_fd" in credential_helper
    assert "antigravity_ha_open_supervisor_credential_pipe" in credential_helper
    assert '/usr/bin/cat -- "/proc/self/fd/${source_fd}"' in credential_helper
    assert credential_helper.count('"${size}" -gt 4096') == 2

    fd_consumer = (
        rootfs / "usr/local/share/antigravity-ha/supervisor-credential-fd.mjs"
    ).read_text(encoding="utf-8")
    assert "delete environment.SUPERVISOR_TOKEN" in fd_consumer
    assert "closeSync(descriptor)" in fd_consumer
    assert "info.isFIFO()" in fd_consumer
    assert "readlinkSync" not in fd_consumer
    assert "/proc/self/fd" not in fd_consumer
    assert "The only Px entrypoint is the broker bootstrap" in fd_consumer
    assert "const MAX_CREDENTIAL_BYTES = 4_096" in fd_consumer

    for service in ("ttyd", "sshd", "ingress", "ha-memoryd"):
        run = (rootfs / S6_ROOT / service / "run").read_text(encoding="utf-8")
        assert "unset SUPERVISOR_TOKEN" in run

    telegram_run = (rootfs / S6_ROOT / "telegram-bot/run").read_text(
        encoding="utf-8"
    )
    telegram_runtime = (
        rootfs / "usr/local/libexec/ha-telegram-runtime"
    ).read_text(encoding="utf-8")
    assert "exec /usr/local/libexec/ha-telegram-runtime" in telegram_run
    assert telegram_runtime.splitlines()[:3] == [
        "#!/bin/bash -p",
        "set -Eeuo pipefail",
        "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN",
    ]

    for helper in ("ha-api", "supervisor-api"):
        content = (rootfs / "usr/local/bin" / helper).read_text(encoding="utf-8")
        assert "antigravity_ha_load_supervisor_credential" in content

    for helper in ("ha-memory", "ha-memory-mcp"):
        content = (rootfs / "usr/local/bin" / helper).read_text(encoding="utf-8")
        assert "antigravity_ha_load_supervisor_credential" not in content
        assert "exec /usr/bin/env -i" in content


def test_antigravity_cli_uses_only_native_cli_contract(rootfs: Path) -> None:
    wrapper = (rootfs / "usr/local/bin/antigravity").read_text(encoding="utf-8")
    assert "antigravity_ha_config_bool" in wrapper
    assert "terminal_sandbox" not in wrapper
    assert "antigravity_HA_NATIVE_ARGS" not in wrapper
    assert "terminal_sandbox=$(" not in wrapper
    assert "--dangerously-skip-permissions is disabled" in wrapper
    assert "native sandbox overrides are disabled" in wrapper
    for override in ("--sandbox", "--no-sandbox"):
        assert override in wrapper
    assert 'exec "${antigravity_HA_LAUNCHER}" "$@"' in wrapper
    assert "approval_policy" not in wrapper
    assert "sandbox_mode" not in wrapper
    assert "ANTIGRAVITY_TOKEN" not in wrapper
    assert "GEMINI_API_KEY" not in wrapper
    assert " -c " not in wrapper


def test_sensitive_data_option_selects_only_the_gated_interactive_launcher(
    rootfs: Path,
) -> None:
    wrapper = (rootfs / "usr/local/bin/antigravity").read_text(encoding="utf-8")
    restricted = (
        rootfs / "usr/local/libexec/antigravity-interactive-restricted"
    ).read_text(encoding="utf-8")
    sensitive = (
        rootfs / "usr/local/libexec/antigravity-interactive-sensitive-read"
    ).read_text(encoding="utf-8")
    native_guard = (
        rootfs / "usr/local/libexec/antigravity-native-session-guard"
    ).read_text(encoding="utf-8")
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )

    assert "antigravity_sensitive_data_access false" in wrapper
    assert (
        "antigravity_HA_LAUNCHER=/usr/local/libexec/"
        "antigravity-interactive-restricted"
    ) in wrapper
    assert (
        "antigravity_HA_LAUNCHER=/usr/local/libexec/"
        "antigravity-interactive-sensitive-read"
    ) in wrapper
    assert 'exec "${antigravity_HA_LAUNCHER}"' in wrapper

    hardened_prefix = [
        "#!/bin/bash -p",
        "set -Eeuo pipefail",
        "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN",
    ]
    assert restricted.splitlines()[:3] == hardened_prefix
    assert sensitive.splitlines()[:3] == hardened_prefix
    assert "sensitive-data-access.enabled" not in restricted
    assert "sensitive-data-access.enabled" not in sensitive
    assert "sensitive-data-access.enabled" in native_guard
    assert "[[ ! -f ${ACCESS_MARKER} || -L ${ACCESS_MARKER}" in native_guard
    assert "stat -Lc '%u:%g:%a:%h'" in native_guard
    assert "!= 0:0:400:1" in native_guard
    for launcher in (restricted, sensitive):
        assert "--shared --nonblock --close --conflict-exit-code 75" in launcher
        assert "--ignore-signal=INT --ignore-signal=QUIT" in launcher
        assert "--default-signal=INT --default-signal=QUIT -i" in launcher
        assert "/usr/bin/setpriv --pdeathsig KILL" in launcher
        assert "/usr/local/libexec/antigravity-native-session-guard" in launcher
        assert "PATH=/usr/local/libexec/antigravity-command-bin:" in launcher
        assert "/usr/local/libexec/antigravity-real" not in launcher
    assert "exec /usr/local/libexec/antigravity-native-env -i" in native_guard
    assert "/usr/local/libexec/antigravity-real" in native_guard

    assert (
        "antigravity_sensitive_data_access: "
        'option_bool("antigravity_sensitive_data_access"; false)'
    ) in init_script
    assert 'rm -f "${SENSITIVE_DATA_ACCESS_MARKER}"' in init_script
    assert 'chmod 0400 "${sensitive_access_tmp}"' in init_script
    assert 'mv -f "${sensitive_access_tmp}" "${SENSITIVE_DATA_ACCESS_MARKER}"' in (
        init_script
    )


def test_global_settings_updates_use_the_validated_atomic_helper(rootfs: Path) -> None:
    wrapper = (rootfs / "usr/local/bin/agy-settings").read_text(encoding="utf-8")
    helper = (
        rootfs
        / "usr/local/share/antigravity-ha/antigravity-settings-update.mjs"
    ).read_text(encoding="utf-8")

    assert wrapper.splitlines()[:3] == [
        "#!/bin/bash -p",
        "set -Eeuo pipefail",
        "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN",
    ]
    assert "user-files-update.lock" in wrapper
    assert "/usr/bin/flock --exclusive --nonblock 9" in wrapper
    assert "exec /usr/bin/node" in wrapper
    for protected in (
        '"permissions"',
        '"enableTerminalSandbox"',
        '"allowNonWorkspaceAccess"',
        '"toolPermission"',
        '"artifactReviewPolicy"',
    ):
        assert protected in helper
    assert "expected_sha256" in helper
    assert "O_NOFOLLOW" in helper
    assert "O_EXCL" in helper
    assert "fsyncSync" in helper
    assert "renameSync(temporary, SETTINGS_PATH)" in helper
    assert "request accepts only expected_sha256 and patch" in helper
    assert "JSON patch exceeds the structural limit" in helper
    assert "nativeParseJsonContent(bytes)" in helper
    assert "isNativeRawJsonNumber(value)" in helper
    assert "!isNativeRawJsonNumber(value)" in helper
    assert "nativeCanonicalSettingsContent(" in helper
    assert "nativeSettingsToolPermission(current)" in helper
    for supported in (
        '"altScreenMode"',
        '"clearScrollbackOnResize"',
        '"colorScheme"',
        '"disableSlashCommands"',
        '"enableTelemetry"',
        '"modelProvider"',
        '"showFeedbackSurvey"',
        '"showTips"',
    ):
        assert supported in helper
    assert "SUPPORTED_SCALAR_PATCHES" in helper
    assert "patch contains an unsupported top-level setting" in helper
    assert "patch contains an unsupported scalar setting value" in helper
    assert '["enableTelemetry", (value) => value === false]' in helper
    assert 'key === "enableTelemetry" && value === null' in helper
    for guidance_path in (
        "usr/local/share/antigravity-ha/AGENTS.md",
        "usr/local/share/antigravity-ha/plugins/home-assistant/rules/"
        "home-assistant-safety.md",
        "usr/local/share/antigravity-ha/plugins/home-assistant/skills/"
        "home-assistant-operations/SKILL.md",
    ):
        guidance = (rootfs / guidance_path).read_text(encoding="utf-8")
        assert "`enableTelemetry`" in guidance


def test_init_starts_background_tmux(rootfs: Path) -> None:
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    assert "/usr/local/bin/web-terminal-entrypoint --background" in init_script
    assert 'tmux -u new-session -d -s "${session_name}"' not in init_script
