import hashlib
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
        "read_source_app_version",
        'config_path.read_text(encoding="utf-8")',
        '--arg candidate_version "${CANDIDATE_APP_VERSION}"',
        '.applied == {settings:[$candidate_version],mcp:[]}',
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
        ".installed_version == $candidate_version",
        ".applied_versions == [$candidate_version]",
        'antigravity-real plugin validate',
        "settings_hash_before",
        "mcp_hash_before",
        "native plugin validation changed user settings",
        'test ! -e "${plugin}/agents/ha-telegram"',
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
        '.toolPermission == "request-review"',
        ".enableTerminalSandbox == false",
        ".allowNonWorkspaceAccess == true",
        '.permissions.allow | index("command(*)") == null',
        '.permissions.allow | index("mcp(*)") == null',
        '.permissions.allow | index("read_file(*)") == null',
        '.permissions.allow | index("mcp(ha_files/ha_files_list)") != null',
        '.permissions.allow | index("mcp(ha_files/ha_files_read_text)") != null',
        '"mcp(ha_files/ha_files_write_text)"',
        ".permissions.ask | sort",
        '.permissions.deny | index("read_file(*)") != null',
        '.permissions.deny | index("write_file(*)") != null',
        'index("mcp(telegram_action/telegram_action_propose)")',
        "Legacy antigravity_sandbox_mode was retired",
        (
            '.permissions.deny | index("write_file('
            '/data/home/.gemini/antigravity-cli/settings.json)") != null'
        ),
        '$state.managed.settings.permission_rules',
        'colorScheme:"tokyo night"',
        "settings_metadata_and_semantics_preserved: true",
        "mcp_byte_preserved: true",
    ):
        assert required in smoke

    assert "SOURCE_MANIFEST_TOOL verify-image interface is pending" not in smoke
    assert "Legacy antigravity_sandbox_mode was conservatively mapped" not in smoke
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
    assert "settings_and_mcp_byte_preserved" not in smoke
    assert re.search(r"(?<!v)2\.0\.[0-9]+", smoke) is None


def test_public_v1_runtime_scan_only_allows_native_cli_log_links(
    repository_root: Path,
) -> None:
    smoke = (repository_root / "tests/public-v1-upgrade-smoke.sh").read_text(
        encoding="utf-8"
    )
    for required in (
        "validate_native_cli_log_link",
        "/data/home/.gemini/antigravity-cli/cli.log",
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
    assert "/data/antigravity-ha/telegram-home" not in smoke
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
    assert "antigravity_terminal_sandbox=true is deprecated and ignored" in init_script
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
    assert "terminalSandbox = false" in helper
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
    assert "function resetManagedSettings(" in helper
    assert "reset.permissions = {" in helper
    assert "never retain user buckets or unknown" in helper
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
    assert "preparePreservePermissionMigration(" in helper
    assert "antigravity_terminal_sandbox=true is deprecated" in helper
    assert "hasLegacy206PermissionOwnership(" in helper
    assert 'options.mode === "preserve"' in helper
    assert 'permission_migration: permissionMigration' in helper
    assert '"skipped_unowned"' in helper
    assert '"skipped_ambiguous"' in helper
    assert "replaceTopLevelJsonPropertyValue(" in helper
    assert "A non-permission setting changed during migration" in helper
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


def test_telegram_refresh_reconciles_malformed_owned_permissions_before_merge(
    rootfs: Path,
    repository_root: Path,
) -> None:
    helper = (
        rootfs / "usr/local/share/antigravity-ha/user-files-update.mjs"
    ).read_text(encoding="utf-8")
    smoke_path = repository_root / "tests/user-files-update-smoke.sh"
    smoke = smoke_path.read_text(encoding="utf-8")

    managed_branch = helper.index("const managedMergeBase = options.telegramEnabled")
    generic_merge = helper.index(
        "candidates.settings = mergeManagedSettings(", managed_branch
    )
    final_reconciliation = helper.index(
        "if (options.telegramEnabled && preflight.targets.settings.existed)",
        generic_merge,
    )
    assert managed_branch < generic_merge < final_reconciliation
    assert (
        "options.telegramEnabled\n"
        "        ? TELEGRAM_SETTINGS_MAX_BYTES\n"
        "        : MAX_USER_FILE_BYTES"
    ) in helper
    assert (
        "const managedMergeBase = options.telegramEnabled\n"
        "      ? reconcileTelegramManagedSettings("
    ) in helper
    assert (
        "candidates.settings = mergeManagedSettings(\n"
        "      managedMergeBase,"
    ) in helper

    subprocess.run(["bash", "-n", str(smoke_path)], check=True)
    for required in (
        'TELEGRAM_MALFORMED_REFRESH_VOLUME="${TEST_ID}-telegram-malformed-refresh"',
        "9.9.9-telegramold",
        "9.9.9-telegramnew",
        '.permissions.ask = {synthetic_malformed_bucket: true}',
        '"${TELEGRAM_MALFORMED_BACKUP}/settings.before"',
        'synthetic_refresh_marker = "preserve-unrelated-setting"',
        'synthetic_mcp_marker: "preserve-byte-exact"',
        'and (.permissions.allow | index("read_file(*)") == null)',
        '["mcp(ha_files/ha_files_write_text)", "execute_url(*)", "command(*)"]',
        'index("mcp(ha_files/ha_files_read_text)") != null',
        'index("read_file(*)") != null',
        'index("read_file(/config/secrets.yaml)") != null',
        "loadTelegramPermissionBoundary",
        "Telegram malformed-refresh repair was not restart-idempotent",
        "Telegram-disabled managed refresh accepted a malformed permission bucket",
        "Existing settings.json permissions.ask must be a string array",
    ):
        assert required in smoke

    matrix_case_block = smoke.split(
        "TELEGRAM_MALFORMED_MATRIX_CASES=(", 1
    )[1].split("\n)", 1)[0]
    assert re.findall(r'^\s+"([^"]+)"$', matrix_case_block, re.MULTILINE) == [
        "allow:non-array",
        "allow:array-non-string",
        "ask:non-array",
        "ask:array-non-string",
        "deny:non-array",
        "deny:array-non-string",
    ]
    for required in (
        '"${TELEGRAM_MALFORMED_MATRIX_VOLUMES[@]}"',
        'for TELEGRAM_MATRIX_CASE in "${TELEGRAM_MALFORMED_MATRIX_CASES[@]}"',
        'TELEGRAM_MATRIX_BUCKET=${TELEGRAM_MATRIX_CASE%%:*}',
        'TELEGRAM_MATRIX_SHAPE=${TELEGRAM_MATRIX_CASE#*:}',
        "9.9.9-matrixold",
        "9.9.9-matrixnew",
        ".permissions[$bucket] = (",
        "{synthetic_malformed_bucket: true}",
        '["synthetic-string", {synthetic_non_string_entry: true}]',
        '(.permissions[$bucket] | type) != "array"',
        '(.permissions[$bucket] | any(.[]; type != "string"))',
        '"${backup}/settings.before"',
        'synthetic_matrix_marker = $case_name',
        'synthetic_mcp_marker: $case_name',
        'cmp --silent /data/telegram-matrix-mcp.before "${mcp}"',
        'throw new Error("malformed matrix settings did not load in the bridge")',
    ):
        assert required in smoke

    matrix_runtime_block = smoke.split(
        "# Exercise the complete malformed-bucket contract", 1
    )[1].split(
        "# A compact, bounded legacy file can expand", 1
    )[0]
    assert {
        token: matrix_runtime_block.count(token)
        for token in (
            "TELEGRAM_MATRIX_SETTINGS_AFTER",
            "TELEGRAM_MATRIX_STATE_AFTER",
            "TELEGRAM_MATRIX_MCP_AFTER",
            "TELEGRAM_MATRIX_BACKUP_COUNT",
            "TELEGRAM_MATRIX_IDEMPOTENT",
        )
    } == {
        "TELEGRAM_MATRIX_SETTINGS_AFTER": 2,
        "TELEGRAM_MATRIX_STATE_AFTER": 2,
        "TELEGRAM_MATRIX_MCP_AFTER": 2,
        "TELEGRAM_MATRIX_BACKUP_COUNT": 2,
        "TELEGRAM_MATRIX_IDEMPOTENT": 3,
    }
    idempotent_block = matrix_runtime_block.split(
        "TELEGRAM_MATRIX_IDEMPOTENT=$(", 1
    )[1]
    for required in (
        "9.9.9-matrixnew",
        "Telegram malformed matrix repair was not idempotent",
        'assert_json "${TELEGRAM_MATRIX_IDEMPOTENT}"',
        ".created == []",
        ".refreshed == []",
        ".backup_directory == null",
        '"${TELEGRAM_MATRIX_SETTINGS_AFTER}"',
        '"${TELEGRAM_MATRIX_STATE_AFTER}"',
        '"${TELEGRAM_MATRIX_MCP_AFTER}"',
        '"${TELEGRAM_MATRIX_BACKUP_COUNT}"',
    ):
        assert required in idempotent_block


def test_user_file_backup_retention_requires_exact_app_ownership(
    rootfs: Path,
    repository_root: Path,
) -> None:
    helper = (
        rootfs / "usr/local/share/antigravity-ha/user-files-update.mjs"
    ).read_text(encoding="utf-8")
    smoke = (repository_root / "tests/user-files-update-smoke.sh").read_text(
        encoding="utf-8"
    )

    for required in (
        'const BACKUP_OWNER = "antigravity-for-home-assistant"',
        'const BACKUP_KIND = "native-files-refresh"',
        "const BACKUP_RETENTION = 2",
        "PRUNE_QUARANTINE_PATTERN",
        'join(transaction.path, "manifest.json")',
        'join(transactionDirectory, "completed.json")',
        "async function inspectCompletedBackup(",
        "async function removeCompletedBackup(",
        "async function pruneCompletedBackups(",
        "await rename(path, quarantine)",
        "await syncDirectory(USER_BACKUPS_DIRECTORY)",
        "if (journal) preserve.add(journal.transaction)",
        "Transactions created by older App versions have no explicit ownership",
        "Unsafe, incomplete, or concurrently changed entries stay untouched",
    ):
        assert required in helper
    assert "await rm(USER_BACKUPS_DIRECTORY" not in helper
    assert helper.index("const recovery = await recoverPendingTransaction();") < helper.index(
        "await pruneCompletedBackups(preservedBackups);"
    )

    for required in (
        'RETENTION_VOLUME="${TEST_ID}-retention"',
        "9.9.9-retention4",
        'test "${#retained[@]}" -eq 2',
        "someone-else",
        ".prune-0123456789ab",
        'test -L "${unsafe}/original"',
        'test "${owned_count}" -le 2',
    ):
        assert required in smoke
    subprocess.run(["bash", "-n", str(repository_root / "tests/user-files-update-smoke.sh")], check=True)


def test_public_2_0_6_preserve_permission_fixture_is_source_bound(
    repository_root: Path,
) -> None:
    fixture_root = repository_root / "tests/fixtures"
    settings_path = fixture_root / "public-2.0.6-preserve-settings.json"
    state_path = fixture_root / "public-2.0.6-preserve-state.json"
    source_path = fixture_root / "public-2.0.6-preserve-source.json"

    settings_bytes = settings_path.read_bytes()
    state_bytes = state_path.read_bytes()
    source = json.loads(source_path.read_text(encoding="utf-8"))
    settings = json.loads(settings_bytes)
    state = json.loads(state_bytes)

    assert source == {
        "image": "ghcr.io/kanu-coffee/antigravity-for-home-assistant:2.0.6",
        "image_digest": (
            "sha256:4e7f33036f5214349ba43aeb50361924a33f6b6081051d7df88540bbbf2dbdc4"
        ),
        "source_revision": "8eb03cfa22bac2cc481f9c5ebab4c1a250d92cb2",
        "options": {
            "antigravity_tool_permission": "request-review",
            "antigravity_terminal_sandbox": True,
            "antigravity_user_files_update_mode": "preserve",
        },
        "settings_sha256": (
            "ee34d8fd24909a90f1afafd4303dc5402571cf73105c8983a083a1101b25749c"
        ),
        "state_sha256": (
            "78353795eadafcb552e8aeae049741d88fec378265bb133ac60e2950fd72e56c"
        ),
    }
    assert hashlib.sha256(settings_bytes).hexdigest() == source["settings_sha256"]
    assert hashlib.sha256(state_bytes).hexdigest() == source["state_sha256"]
    assert "read_file(/data)" in settings["permissions"]["deny"]
    assert "write_file(/data)" in settings["permissions"]["deny"]
    assert "read_file(/config)" not in settings["permissions"]["allow"]
    assert state["managed"]["settings"]["permission_rules"] == [
        *settings["permissions"]["allow"],
        *settings["permissions"]["ask"],
        *settings["permissions"]["deny"],
    ]


def test_public_2_0_8_preserve_permission_fixture_is_source_bound(
    repository_root: Path,
) -> None:
    fixture_root = repository_root / "tests/fixtures"
    settings_path = fixture_root / "public-2.0.8-preserve-settings.json"
    state_path = fixture_root / "public-2.0.8-preserve-state.json"
    source_path = fixture_root / "public-2.0.8-preserve-source.json"

    settings_bytes = settings_path.read_bytes()
    state_bytes = state_path.read_bytes()
    source = json.loads(source_path.read_text(encoding="utf-8"))
    settings = json.loads(settings_bytes)
    state = json.loads(state_bytes)

    assert source == {
        "image": "ghcr.io/kanu-coffee/antigravity-for-home-assistant:2.0.8",
        "image_digest": (
            "sha256:ba07b803b1d57a13656d248eb8d2c36204988d34ba64f884670d799c30358980"
        ),
        "source_revision": "ac8197d907d2a77decf6beb6b5515531ef7ae0eb",
        "options": {
            "antigravity_tool_permission": "request-review",
            "antigravity_terminal_sandbox": True,
            "antigravity_user_files_update_mode": "preserve",
        },
        "settings_sha256": (
            "e2590f1f1b4a61aec2afabbfbc4df884a3a47423749367dec249acd056bfa108"
        ),
        "state_sha256": (
            "ac108d3d3c43158f22f831c7c8e5bf9bd45de63a4cb40cd3ed620b2a6545a4d7"
        ),
    }
    assert hashlib.sha256(settings_bytes).hexdigest() == source["settings_sha256"]
    assert hashlib.sha256(state_bytes).hexdigest() == source["state_sha256"]
    assert "command(*)" in settings["permissions"]["ask"]
    assert "mcp(home-assistant/*)" in settings["permissions"]["ask"]
    assert state["managed"]["settings"]["permission_rules"] == [
        *settings["permissions"]["allow"],
        *settings["permissions"]["ask"],
        *settings["permissions"]["deny"],
    ]


def test_preserve_permission_migration_smoke_covers_atomic_fail_safe_paths(
    repository_root: Path,
) -> None:
    smoke_path = repository_root / "tests/user-files-update-smoke.sh"
    smoke = smoke_path.read_text(encoding="utf-8")
    subprocess.run(["bash", "-n", str(smoke_path)], check=True)

    for required in (
        "public-2.0.6-preserve-settings.json",
        "public-2.0.6-preserve-state.json",
        "public 2.0.6 preserve permission migration failed",
        'process.kill(process.pid, \\"SIGKILL\\")',
        '.phase == "prepared"',
        '.permission_migration == "applied"',
        '.permission_migration == "already_applied"',
        '.permission_migration == "skipped_unowned"',
        '.permission_migration == "skipped_ambiguous"',
        "preserve permission migration changed non-permission bytes",
        'index("user(custom/allow)")',
        'index("user(custom/ask)")',
        'index("user(custom/deny)")',
        'index("read_file(/data)") == null',
        'index("write_file(/data)") == null',
        "2.0.9/2.0.10 broad permission migration failed",
        'index("mcp(telegram_action/telegram_action_propose)")',
        'index("user(v3/deny)")',
    ):
        assert required in smoke


def test_native_defaults_and_plugin_are_fixed_image_managed_inputs(
    rootfs: Path,
) -> None:
    settings = rootfs / "etc/antigravity/settings.json"
    mcp = rootfs / "etc/antigravity/mcp_config.json"
    plugin = rootfs / "usr/local/share/antigravity-ha/plugins/home-assistant"
    helper = (
        rootfs / "usr/local/share/antigravity-ha/user-files-update.mjs"
    ).read_text(encoding="utf-8")
    permission_policy = (
        rootfs / "usr/local/share/antigravity-ha/telegram-permission-policy.mjs"
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
    assert {
        path.relative_to(plugin).as_posix()
        for path in plugin.rglob("*")
        if path.is_file()
    } == {
        "mcp_config.json",
        "plugin.json",
        "rules/home-assistant-safety.md",
        "skills/ha-change-proposal/SKILL.md",
        "skills/ha-dashboard/SKILL.md",
        "skills/ha-feedback/SKILL.md",
        "skills/ha-memory/SKILL.md",
        "skills/home-assistant-operations/SKILL.md",
        "skills/telegram-action-proposal/SKILL.md",
    }
    plugin_manifest = json.loads((plugin / "plugin.json").read_text(encoding="utf-8"))
    assert plugin_manifest == {
        "$schema": "https://antigravity.google/schemas/v1/plugin.json",
        "name": "home-assistant",
        "description": (
            "Requester-bound Telegram approvals for Home Assistant, terminal, "
            "and question workflows"
        ),
    }

    plugin_mcp_path = plugin / "mcp_config.json"
    plugin_mcp = plugin_mcp_path.read_text(encoding="utf-8")
    plugin_mcp_config = json.loads(plugin_mcp)
    assert set(plugin_mcp_config) == {"mcpServers"}
    assert set(plugin_mcp_config["mcpServers"]) == {
        "ha_change",
        "ha_files",
        "telegram_action",
        "ha_memory",
        "ha_read",
        "ha_validate",
        "playwright",
    }
    for name, command in {
        "ha_change": "/usr/local/bin/ha-change-proposal-mcp",
        "ha_files": "/usr/local/bin/ha-files-mcp",
        "telegram_action": "/usr/local/bin/telegram-action-proposal-mcp",
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
    proposal_skill = (plugin / "skills/ha-change-proposal/SKILL.md").read_text(
        encoding="utf-8"
    )
    feedback_skill = (plugin / "skills/ha-feedback/SKILL.md").read_text(
        encoding="utf-8"
    )
    operations_skill = (
        plugin / "skills/home-assistant-operations/SKILL.md"
    ).read_text(encoding="utf-8")
    telegram_action_skill = (
        plugin / "skills/telegram-action-proposal/SKILL.md"
    ).read_text(encoding="utf-8")
    assert '"ha_change"' in plugin_mcp
    assert "/usr/local/bin/ha-change-proposal-mcp" in plugin_mcp
    assert '"telegram_action"' in plugin_mcp
    assert "/usr/local/bin/telegram-action-proposal-mcp" in plugin_mcp
    assert "telegram_action_propose" in telegram_action_skill
    assert "terminal_command" in telegram_action_skill
    assert "multi_choice_terminal" in telegram_action_skill
    assert "question" in telegram_action_skill
    assert "does not mean the user approved" in telegram_action_skill
    assert "ha_read_storage_usage" in operations_skill
    assert "Supervisor owns old-image cleanup" in operations_skill
    assert "Never mount or query the Docker socket" in operations_skill
    assert "multi_choice_service_call" in proposal_skill
    assert re.search(r"Provide 1 to\s+31 choices", proposal_skill)
    assert "callback contains only an opaque token" in proposal_skill
    assert "prevalidated choice" in proposal_skill
    assert '"ha_read"' in plugin_mcp
    assert "/usr/local/bin/ha-read-mcp" in plugin_mcp
    assert '"ha_validate"' in plugin_mcp
    assert "/usr/local/bin/ha-validate-mcp" in plugin_mcp
    assert "mcp(ha_change/ha_change_propose)" in helper
    legacy_bounded_native_read_rules = (
        "read_file(/config)",
        "read_file(/data/home/.gemini/config)",
        "read_file(/data/home/.gemini/antigravity-cli/agents)",
        "read_file(/data/home/.gemini/antigravity-cli/plugins)",
        "read_file(/data/home/.gemini/antigravity-cli/skills)",
        "read_file(/data/home/.gemini/GEMINI.md)",
        "read_file(/data/home/.gemini/antigravity-cli/settings.json)",
    )
    for native_file_rule in legacy_bounded_native_read_rules:
        assert f'"{native_file_rule}"' in helper
    assert (
        '"write_file(/data/home/.gemini/antigravity-cli/settings.json)"'
        in helper
    ), "the public 2.0.8 migration source must remain registered"
    shared_file_rules = helper.split(
        "const LEGACY_2_0_11_2_0_18_NATIVE_READ_PERMISSION_RULES =", 1
    )[1].split("const LEGACY_V3_SHARED_NATIVE_FILE_RULES =", 1)[0]
    assert tuple(
        re.findall(r'^\s*"([^"]+)",$', shared_file_rules, re.MULTILINE)
    ) == legacy_bounded_native_read_rules
    request_review_policy = permission_policy.split(
        "const TELEGRAM_REQUEST_REVIEW_ALLOW_RULES =", 1
    )[1].split("const TELEGRAM_ALWAYS_PROCEED_ALLOW_RULES =", 1)[0]
    for rule in (
        "read_url(*)",
        "mcp(ha_files/ha_files_write_text)",
        "execute_url(*)",
        "command(*)",
    ):
        assert f'"{rule}"' in request_review_policy
    for read_rule in (
        "mcp(ha_files/ha_files_list)",
        "mcp(ha_files/ha_files_read_text)",
    ):
        assert f'"{read_rule}"' in permission_policy
    assert "...TELEGRAM_MANAGED_READ_MCP_RULES" in request_review_policy
    for native_file_rule in ("read_file(*)", "write_file(*)"):
        assert f'"{native_file_rule}"' not in request_review_policy
    assert "...TELEGRAM_REQUIRED_PROPOSAL_RULES" in request_review_policy
    assert '"mcp(ha_change/ha_change_propose)"' in permission_policy
    assert '"mcp(telegram_action/telegram_action_propose)"' in permission_policy
    assert '"mcp(*)"' not in request_review_policy
    always_proceed_policy = permission_policy.split(
        "const TELEGRAM_ALWAYS_PROCEED_ALLOW_RULES =", 1
    )[1].split("const TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES =", 1)[0]
    for rule in (
        "read_url(*)",
        "execute_url(*)",
        "command(*)",
        "mcp(*)",
    ):
        assert f'"{rule}"' in always_proceed_policy
    for native_file_rule in ("read_file(*)", "write_file(*)"):
        assert f'"{native_file_rule}"' not in always_proceed_policy
    image_settings = json.loads(settings.read_text(encoding="utf-8"))
    assert image_settings["toolPermission"] == "request-review"
    assert image_settings["allowNonWorkspaceAccess"] is True
    for sensitive_rule in (
        "read_file(*)",
        "write_file(*)",
        "read_file(/data/home/.gemini)",
        "write_file(/data/home/.gemini)",
        "read_file(/data/home/.gemini/antigravity-cli/settings.json)",
        "write_file(/data/home/.gemini/antigravity-cli/settings.json)",
        "read_file(/data/home/.gemini/config/mcp_config.json)",
        "write_file(/data/home/.gemini/config/mcp_config.json)",
        "read_file(/data/browser-auth)",
        "read_file(/config/secrets.yaml)",
        "write_file(/config/secrets.yaml)",
        "read_file(/config/.storage)",
        "write_file(/config/.storage)",
        "read_file(/config/ssl)",
        "read_file(/etc/ssl/private)",
        "read_file(/proc/self/environ)",
        "read_file(/proc/self/fd)",
    ):
        assert f'"{sensitive_rule}"' in permission_policy
    assert 'oauth*' not in permission_policy
    assert "AppArmor remains responsible for dynamic PID paths" in permission_policy
    assert 'const RETIRED_MANAGED_PERMISSION_RULES = new Set([' in helper
    assert 'const REGISTERED_MANAGED_PERMISSION_RULES = new Set([' in helper
    assert "!REGISTERED_MANAGED_PERMISSION_RULES.has(rule)" in helper
    for tool in (
        "ha_read_addon_logs",
        "ha_read_app_logs",
        "ha_read_config",
        "ha_read_core_logs",
        "ha_read_history",
        "ha_read_host_logs",
        "ha_read_registry",
        "ha_read_services",
        "ha_read_state",
        "ha_read_states",
        "ha_read_storage_usage",
        "ha_read_supervisor_logs",
        "ha_read_system_info",
        "ha_read_traces",
    ):
        assert f'"{tool}"' in helper
    legacy_read_tools = helper.split(
        "const LEGACY_2_0_6_2_0_8_HA_READ_TOOLS = [", 1
    )[1].split("];", 1)[0]
    assert '"ha_read_storage_usage"' not in legacy_read_tools
    assert '"ha_read_addon_logs"' not in legacy_read_tools
    assert '...LEGACY_2_0_6_2_0_8_HA_READ_TOOLS.map(' in helper
    assert "mcp(ha_read/${tool})" in helper
    assert re.search(r"Do not\s+supply or invent requester\s+fields", proposal_skill)
    assert "process environment" in proposal_skill
    assert "Use `device_test`, never `service_call`" in proposal_skill
    assert "`expected_prior_state`" in proposal_skill
    assert "`rollback_failed`/`in_doubt`" in proposal_skill
    assert "/ha-feedback bug <symptom>" in feedback_skill
    assert "$ha-feedback" not in feedback_skill
    for tool in ("ha_validate_config", "ha_verify_state"):
        assert f'"{tool}"' in helper

    assert 'const DEFAULT_SETTINGS_PATH = "/etc/antigravity/settings.json"' in helper
    assert 'const DEFAULT_MCP_CONFIG_PATH = "/etc/antigravity/mcp_config.json"' in helper
    for native_rule in (
        "command(*)",
        "mcp(home-assistant/*)",
        "command(sudo)",
        "command(rm -rf)",
        "write_file(.git/)",
        "read_file(/config/secrets.yaml)",
        "read_file(/config/.storage)",
        "write_file(/config/secrets.yaml)",
        "write_file(/config/.storage)",
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
    assert 'runNative(["agent"])' not in plugin_update
    assert "managed ha-telegram agent" not in plugin_update
    assert 'const MIGRATION_ROOT = join(APP_DATA_ROOT, "migration")' in plugin_update
    assert 'const BACKUP_ROOT = join(APP_DATA_ROOT, "backups")' in plugin_update
    assert "const BACKUP_RETENTION = 2" in plugin_update
    assert "PRUNE_QUARANTINE_PATTERN" in plugin_update
    assert "A managed plugin backup has no ownership manifest" in plugin_update
    assert "if (journal) preserve.add(journal.transaction)" in plugin_update
    assert "await rename(path, quarantine)" in plugin_update
    assert "await rm(quarantine" in plugin_update
    assert "rm(BACKUP_ROOT" not in plugin_update
    assert plugin_update.index(
        "const recovery = await recoverPendingTransaction();"
    ) < plugin_update.index("await pruneCompletedPluginBackups();")
    assert 'AGY_CLI_DISABLE_AUTO_UPDATE: "true"' in plugin_update
    assert "SUPERVISOR_TOKEN" not in plugin_update
