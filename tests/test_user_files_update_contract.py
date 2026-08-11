import json
import re
import subprocess
from pathlib import Path

import yaml


VALID_UPDATE_MODES = (
    "list(preserve|refresh_managed|reset_v2|refresh_agents|refresh_all)"
)


def test_public_v1_upgrade_rehearsal_is_source_and_candidate_bound(
    repository_root: Path,
) -> None:
    smoke_path = repository_root / "tests/public-v1-upgrade-smoke.sh"
    smoke = smoke_path.read_text(encoding="utf-8")
    subprocess.run(["bash", "-n", str(smoke_path)], check=True)

    for required in (
        "v1.0.4^{commit}",
        "EXPECTED_V1_REVISION does not resolve to the public v1.0.4 tag",
        "resolve_image_id",
        'status --porcelain=v1',
        "source worktree is dirty",
        "assert_candidate_source_checkout",
        "EXPECTED_CANDIDATE_REVISION does not match the source HEAD",
        "org.opencontainers.image.revision",
        "io.antigravity-ha.source-rootfs-sha256",
        '--root "${SOURCE_ROOTFS_DIRECTORY}"',
        "verify-image",
        '--image "${image_id}"',
        '--expected-revision "${expected_revision}"',
        '--expected-source-rootfs-sha256 "${expected_source_rootfs}"',
        "antigravity-ha-source-image-verification/v1",
        "candidate_source_files_verified",
        "verify_public_v1_source_binding",
        "public v1.0.4 tag does not contain the expected 80 rootfs files",
        "antigravity_home_assistant/playwright/package.json",
        "antigravity_home_assistant/playwright/package-lock.json",
        "run_mapping_scenario",
        "run_preserve_scenario",
        "mapping refresh_all",
        "preserve preserve",
        "/data/antigravity/.user-files-update-state.json",
        '.applied == {agents:["1.0.4"],config:["1.0.4"]}',
        "/data/antigravity/backups/user-files/refresh-*",
        'stat -c "%u:%g:%h:%a:%F"',
        "/data/antigravity-ha/migration/native-files-state.json",
        "/data/antigravity-ha/migration/managed-plugin.json",
        ".antigravity-ha-managed.json",
        '.applied_versions == ["2.0.0"]',
        'antigravity-real plugin validate',
        "settings_hash_before",
        "mcp_hash_before",
        "native plugin validation changed user settings",
        "ha-telegram",
        "/data/antigravity-ha/quarantine/v1-telegram/",
        "test ! -L \"$path\"",
        "/data/home/.gemini/mcp_config.json",
        "legacy-mcp-executed",
        "ssh_host_ed25519_key",
        "ssh_host_rsa_key",
        "/data/ssh/authorized_keys",
        "isAuthorized",
        "isPaired",
        "LEGACY_CHAT_ID",
        "file_identity",
        "find -P \"$root\" -xdev -type f -links 1 -print0",
        "ha-memory search",
        "PRAGMA quick_check;",
        "timeout --foreground",
        'closure_eligible: false',
        'actual_haos_update: "NOT_RUN"',
        'supervisor_option_prevalidation: "NOT_RUN"',
        'contains_credentials: false',
        "preserve mode unexpectedly claimed ownership of user native files",
        '(has("toolPermission") | not)',
        '$state.managed.settings.permission_rules',
        'colorScheme:"tokyo night"',
    ):
        assert required in smoke

    assert "SOURCE_MANIFEST_TOOL verify-image interface is pending" not in smoke
    assert "grep -R" not in smoke
    assert smoke.count("assert_candidate_source_checkout") >= 4
    assert smoke.count('start_app "${MAPPING_') == 2
    assert smoke.count('start_app "${PRESERVE_') == 2
    assert 'start_app "${MAPPING_V1_CONTAINER}" "${V1_IMAGE_ID}"' in smoke
    assert 'start_app "${MAPPING_V2_CONTAINER}" "${CANDIDATE_IMAGE_ID}"' in smoke
    assert 'start_app "${PRESERVE_V1_CONTAINER}" "${V1_IMAGE_ID}"' in smoke
    assert 'start_app "${PRESERVE_V2_CONTAINER}" "${CANDIDATE_IMAGE_ID}"' in smoke
    assert smoke.count("${V1_IMAGE}") == 1
    assert smoke.count("${CANDIDATE_IMAGE}") == 1
    assert '"${V1_IMAGE}" >/dev/null' not in smoke
    assert '"${CANDIDATE_IMAGE}" >/dev/null' not in smoke


def test_public_v1_runtime_scan_only_allows_native_cli_log_links(
    repository_root: Path,
) -> None:
    smoke = (repository_root / "tests/public-v1-upgrade-smoke.sh").read_text(
        encoding="utf-8"
    )
    for required in (
        "validate_native_cli_log_link",
        "/data/home/.gemini/antigravity-cli/cli.log",
        "/data/antigravity-ha/telegram-home/.gemini/antigravity-cli/cli.log",
        "^log/cli-[0-9]{8}_[0-9]{6}\\.log$",
        '"0:0:1:777:symbolic link"',
        "cli_root=${link_path%/cli.log}",
        "log_directory=${cli_root}/log",
        '"0:0:700:directory"',
        "^0:0:1:(600|644):regular\\ file$",
        'find -P "$root" -xdev -type f -links 1 -print0',
        "unsafe runtime target metadata",
        "a retired legacy token remained in a v2 runtime target",
        "a v2 runtime target could not be scanned safely",
    ):
        assert required in smoke

    assert "find -L" not in smoke
    assert "readlink -f" not in smoke
    assert "^0:0:1:[0-7]{3}:regular\\ file$" not in smoke
    assert "^0:0:1:(600|644|666):regular\\ file$" not in smoke


def test_user_file_update_option_is_safe_by_default(
    addon_config: dict,
) -> None:
    assert addon_config["options"]["antigravity_user_files_update_mode"] == "preserve"
    assert (
        addon_config["schema"]["antigravity_user_files_update_mode"]
        == VALID_UPDATE_MODES
    )


def test_user_file_update_option_is_translated(addon_root: Path) -> None:
    for locale in ("en", "ko"):
        translation_path = addon_root / "translations" / f"{locale}.yaml"
        translation = yaml.safe_load(translation_path.read_text(encoding="utf-8"))
        option = translation["configuration"]["antigravity_user_files_update_mode"]
        assert isinstance(option["name"], str) and option["name"].strip()
        assert isinstance(option["description"], str) and option["description"].strip()


def test_user_file_update_runtime_is_image_managed(
    addon_root: Path, rootfs: Path
) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    wrapper = (rootfs / "usr/local/bin/antigravity-user-files-update").read_text(
        encoding="utf-8"
    )
    helper = (
        rootfs / "usr/local/share/antigravity-ha/user-files-update.mjs"
    ).read_text(encoding="utf-8")
    assert "${BUILD_VERSION}" in dockerfile
    assert "/usr/local/share/antigravity-ha/app-version" in dockerfile
    assert "/usr/local/share/antigravity-ha/user-files-update.mjs" in dockerfile
    assert "/usr/local/bin/antigravity-user-files-update" in init_script
    assert re.search(r"(?:==|-eq)\s*30", init_script)

    assert "flock -n" in wrapper
    assert "LOCK_DIRECTORY=/run/antigravity-ha" in wrapper
    assert "stat -Lc '%u:%h:%F' /proc/self/fd/9" in wrapper
    assert "stat -Lc '%d:%i'" in wrapper
    assert "user-files-update.mjs" in wrapper
    assert "process.argv.length !== 2" in helper
    assert "O_NOFOLLOW" in helper
    assert "O_NONBLOCK" in helper
    assert "stats.uid !== 0 || stats.nlink !== 1" in helper
    for mode in (
        '"preserve"',
        '"refresh_managed"',
        '"reset_v2"',
        '"refresh_agents"',
        '"refresh_all"',
    ):
        assert mode in helper
    assert 'requestedMode === "refresh_agents"' in helper
    assert 'requestedMode === "refresh_all"' in helper
    assert 'never: "request-review"' in helper
    assert "terminalSandbox = true" in helper
    assert "Legacy browser_approval_policy was retired" in helper


def test_user_file_update_has_fixed_scopes_and_private_recovery_state(
    rootfs: Path,
) -> None:
    helper = (
        rootfs / "usr/local/share/antigravity-ha/user-files-update.mjs"
    ).read_text(encoding="utf-8")

    for fixed_path in (
        'join(ANTIGRAVITY_CLI_DIRECTORY, "settings.json")',
        'join(GLOBAL_CONFIG_DIRECTORY, "mcp_config.json")',
        'join(APP_DATA_DIRECTORY, "migration")',
        'join(MIGRATION_DIRECTORY, "native-files-state.json")',
        'join(MIGRATION_DIRECTORY, "native-files.json")',
        'join(APP_DATA_DIRECTORY, "backups")',
        'join(BACKUPS_DIRECTORY, "native-files")',
        'join(APP_DATA_DIRECTORY, "quarantine")',
        'join(DATA_DIRECTORY, ".native-files-update-state.json")',
        'join(DATA_DIRECTORY, ".native-files-update-journal.json")',
        'join(DATA_DIRECTORY, "backups")',
        'join(LEGACY_BACKUPS_DIRECTORY, "native-files")',
        'join(DATA_DIRECTORY, ".user-files-update-state.json")',
        'join(DATA_DIRECTORY, ".user-files-update-journal.json")',
        'join(LEGACY_BACKUPS_DIRECTORY, "user-files")',
    ):
        assert fixed_path in helper

    assert 'new Set(["settings", "mcp"])' in helper
    assert 'options.mode === "reset_v2"' in helper
    assert 'versionApplied(state, "settings", appVersion)' in helper
    assert "await preflightRefreshTargets(scopes)" in helper
    assert "await writePrivateJson(activeJournalPath" in helper
    assert "await writePrivateJson(activeStatePath" in helper
    assert "await recoverPendingTransaction" in helper
    assert "await migrateLegacyControlState()" in helper
    assert "await recoverPublicV1Transaction()" in helper
    assert "useLegacyControlPaths()" in helper
    assert "usePrimaryControlPaths()" in helper
    assert "Legacy and v2 user-file migration control state conflict" in helper
    assert "Legacy and v2 user-file migration state files differ" in helper
    assert '"telegram_authorized_chats.json"' in helper
    assert '"telegram_pair_info.json"' in helper
    assert "await quarantineLegacyTelegramState()" in helper
    assert "Legacy antigravity_token was not imported" in helper
    assert "Legacy home_assistant_browser_token was not migrated" in helper
    assert "v2 user allowlist or new private pairing" in helper
    assert "await verifyInstalledTargets(" in helper
    assert '"prepared"' in helper
    assert '"targets_installed"' in helper
    assert '"state_committed"' in helper
    assert 'join(transaction.path, "state.before")' in helper
    assert 'join(transaction.path, "state.candidate")' in helper
    assert 'journal.phase === "state_committed"' in helper
    assert "0o700" in helper
    assert "0o600" in helper
    assert "mergeManagedSettings(" in helper
    assert "state.managed.settings = desiredOwnership" in helper
    assert "previouslyManaged.has(rule)" in helper
    assert "ensureFreshDefaults" not in helper
    assert "preflightDefaultTargets" in helper
    assert 'candidates.mcp = defaults.mcp' in helper
    assert 'scopes = [...new Set([...created, ...refreshed])]' in helper

    assert 'join(DATA_DIRECTORY, "config.toml")' in helper
    assert 'join(DATA_DIRECTORY, "AGENTS.md")' in helper
    assert "writeAtomic(LEGACY_CONFIG_PATH" not in helper
    assert "writeAtomic(LEGACY_AGENTS_PATH" not in helper
    assert "removeSafeRegular(LEGACY_CONFIG_PATH" not in helper
    assert "removeSafeRegular(LEGACY_AGENTS_PATH" not in helper

    for excluded_path in (
        'join(DATA_DIRECTORY, "auth.json")',
        '"/data/ssh"',
        '"/data/browser-auth"',
    ):
        assert excluded_path not in helper


def test_native_defaults_and_plugin_are_fixed_image_managed_inputs(
    rootfs: Path,
) -> None:
    settings = rootfs / "etc/antigravity/settings.json"
    mcp = rootfs / "etc/antigravity/mcp_config.json"
    plugin = rootfs / "usr/local/share/antigravity-ha/plugins/home-assistant"
    helper = (
        rootfs / "usr/local/share/antigravity-ha/user-files-update.mjs"
    ).read_text(encoding="utf-8")
    plugin_update = (
        rootfs / "usr/local/share/antigravity-ha/managed-plugin-update.mjs"
    ).read_text(encoding="utf-8")
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )

    assert settings.is_file()
    assert mcp.is_file()
    assert (plugin / "plugin.json").is_file()
    assert (plugin / "mcp_config.json").is_file()
    assert (plugin / "rules/home-assistant-safety.md").is_file()
    assert (plugin / "agents/ha-telegram/agent.md").is_file()
    assert {
        path.relative_to(plugin).as_posix()
        for path in plugin.rglob("*")
        if path.is_file()
    } == {
        "agents/ha-telegram/agent.md",
        "mcp_config.json",
        "plugin.json",
        "rules/home-assistant-safety.md",
        "skills/ha-change-proposal/SKILL.md",
        "skills/ha-dashboard/SKILL.md",
        "skills/ha-feedback/SKILL.md",
        "skills/ha-memory/SKILL.md",
        "skills/home-assistant-operations/SKILL.md",
    }
    plugin_manifest = json.loads((plugin / "plugin.json").read_text(encoding="utf-8"))
    assert plugin_manifest == {
        "$schema": "https://antigravity.google/schemas/v1/plugin.json",
        "name": "home-assistant",
        "description": "Safe Home Assistant API, memory, browser, and change workflows",
    }

    plugin_mcp_path = plugin / "mcp_config.json"
    plugin_mcp = plugin_mcp_path.read_text(encoding="utf-8")
    plugin_mcp_config = json.loads(plugin_mcp)
    assert set(plugin_mcp_config) == {"mcpServers"}
    assert set(plugin_mcp_config["mcpServers"]) == {
        "ha_change",
        "ha_memory",
        "ha_read",
        "ha_validate",
        "playwright",
    }
    for name, command in {
        "ha_change": "/usr/local/bin/ha-change-proposal-mcp",
        "ha_memory": "/usr/local/bin/ha-memory-mcp",
        "ha_read": "/usr/local/bin/ha-read-mcp",
        "ha_validate": "/usr/local/bin/ha-validate-mcp",
        "playwright": "/usr/local/bin/ha-playwright-mcp",
    }.items():
        server = plugin_mcp_config["mcpServers"][name]
        assert server["command"] == command
        assert server["args"] == []
        assert server["cwd"] == "/config"
        assert "env" not in server
    telegram_agent = (plugin / "agents/ha-telegram/agent.md").read_text(
        encoding="utf-8"
    )
    proposal_skill = (plugin / "skills/ha-change-proposal/SKILL.md").read_text(
        encoding="utf-8"
    )
    feedback_skill = (plugin / "skills/ha-feedback/SKILL.md").read_text(
        encoding="utf-8"
    )
    assert '"ha_change"' in plugin_mcp
    assert "/usr/local/bin/ha-change-proposal-mcp" in plugin_mcp
    assert '"ha_read"' in plugin_mcp
    assert "/usr/local/bin/ha-read-mcp" in plugin_mcp
    assert '"ha_validate"' in plugin_mcp
    assert "/usr/local/bin/ha-validate-mcp" in plugin_mcp
    assert "mcp(ha_change/ha_change_propose)" in helper
    for tool in (
        "ha_read_app_logs",
        "ha_read_config",
        "ha_read_core_logs",
        "ha_read_history",
        "ha_read_registry",
        "ha_read_services",
        "ha_read_state",
        "ha_read_states",
        "ha_read_system_info",
        "ha_read_traces",
    ):
        assert f'"{tool}"' in helper
    assert "mcp(ha_read/${tool})" in helper
    assert "ha_change_propose" in telegram_agent
    assert "`device_test`" in telegram_agent
    assert "always-restore/fresh-verify" in telegram_agent
    assert '`proposal_ids` to `[]`' in telegram_agent
    assert "exactly that one broker-owned `proposal_id`" in telegram_agent
    assert "run_command" not in telegram_agent
    assert "Do not supply or invent requester" in proposal_skill
    assert "process environment" in proposal_skill
    assert "Use `device_test`, never `service_call`" in proposal_skill
    assert "`expected_prior_state`" in proposal_skill
    assert "`rollback_failed`/`in_doubt`" in proposal_skill
    assert "/ha-feedback bug <symptom>" in feedback_skill
    assert "$ha-feedback" not in feedback_skill
    for tool in (
        "ha_read_app_logs",
        "ha_read_config",
        "ha_read_core_logs",
        "ha_read_history",
        "ha_read_registry",
        "ha_read_services",
        "ha_read_state",
        "ha_read_states",
        "ha_read_system_info",
        "ha_read_traces",
    ):
        assert f"`{tool}`" in telegram_agent
    for tool in ("ha_validate_config", "ha_verify_state"):
        assert f'"{tool}"' in helper
        assert f"`{tool}`" in telegram_agent
    assert "generic `ha-api`, `supervisor-api`" in telegram_agent

    assert 'const DEFAULT_SETTINGS_PATH = "/etc/antigravity/settings.json"' in helper
    assert 'const DEFAULT_MCP_CONFIG_PATH = "/etc/antigravity/mcp_config.json"' in helper
    for native_rule in (
        "command(*)",
        "mcp(home-assistant/*)",
        "command(sudo)",
        "command(rm -rf)",
        "write_file(.git/)",
    ):
        assert f'"{native_rule}"' in helper
    assert "managed-plugin-update.mjs" in init_script
    assert "plugin uninstall" not in init_script
    assert "plugin uninstall" not in plugin_update
    assert 'await saveJournal(journal, "backed_up")' in plugin_update
    assert 'await saveJournal(journal, "staged")' in plugin_update
    assert 'await saveJournal(journal, "validated")' in plugin_update
    assert 'await saveJournal(journal, "activating")' in plugin_update
    assert 'await saveJournal(journal, "postcondition_verified")' in plugin_update
    assert "await recoverPendingTransaction()" in plugin_update
    assert "await copyVerifiedTree(TARGET, paths.backup, before)" in plugin_update
    assert "await rename(paths.stage, TARGET)" in plugin_update
    assert "await validateInstalledPostcondition" in plugin_update
    assert 'const MIGRATION_ROOT = join(APP_DATA_ROOT, "migration")' in plugin_update
    assert 'const BACKUP_ROOT = join(APP_DATA_ROOT, "backups")' in plugin_update
    assert 'AGY_CLI_DISABLE_AUTO_UPDATE: "true"' in plugin_update
    assert "SUPERVISOR_TOKEN" not in plugin_update
