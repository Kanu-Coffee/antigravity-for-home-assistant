import json
import os
import re
import subprocess
from pathlib import Path


MEMORY_BINARIES = {
    "ha-memory": "ha-memory.mjs",
    "ha-memory-mcp": "ha-memory-mcp.mjs",
}

MEMORY_SHARE_FILES = (
    "ha-memory-core.mjs",
    "ha-memory-ha-client.mjs",
    "ha-memory.mjs",
    "ha-memory-mcp.mjs",
)

MEMORY_TABLES = (
    "metadata",
    "sync_runs",
    "catalog_objects",
    "catalog_relations",
    "catalog_revisions",
    "memory_items",
    "memory_evidence",
    "conflicts",
    "change_records",
    "audit_events",
    "audit_changes",
    "search_fts",
)

MEMORY_ITEM_STATUSES = (
    "pending",
    "verified",
    "applied",
    "rejected",
    "conflict",
    "superseded",
)

CHANGE_STATUSES = (
    "pending",
    "verified",
    "mismatch",
    "unavailable",
)


def _table_definition(source: str, table: str) -> str:
    match = re.search(
        rf"CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"
        rf"{re.escape(table)}\b(?P<body>.*?);",
        source,
        re.IGNORECASE | re.DOTALL,
    )
    assert match, f"missing SQL table definition: {table}"
    return match.group("body")


def _assert_quoted_sql_values(source: str, values: tuple[str, ...]) -> None:
    for value in values:
        assert re.search(rf"(['\"]){re.escape(value)}\1", source), value


def _assert_nearby_terms(
    source: str,
    anchor: str,
    required: tuple[str, ...],
    distance: int = 320,
) -> None:
    for match in re.finditer(anchor, source):
        nearby = source[
            max(0, match.start() - distance) : min(len(source), match.end() + distance)
        ]
        if all(re.search(pattern, nearby) for pattern in required):
            return
    raise AssertionError(f"terms were not found near /{anchor}/: {required}")


def test_memory_runtime_artifacts_are_image_managed(rootfs: Path) -> None:
    binary_root = rootfs / "usr/local/bin"
    share_root = rootfs / "usr/local/share/antigravity-ha"

    for binary_name, module_name in MEMORY_BINARIES.items():
        binary = binary_root / binary_name
        assert binary.is_file(), binary_name

        wrapper = binary.read_text(encoding="utf-8")
        assert wrapper.splitlines()[:3] == [
            "#!/bin/bash -p",
            "set -Eeuo pipefail",
            "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN",
        ]
        assert "antigravity_ha_load_supervisor_credential" not in wrapper
        assert "exec /usr/bin/env -i" in wrapper
        assert "set -Eeuo pipefail" in wrapper
        assert "/usr/bin/node" in wrapper
        assert f"/usr/local/share/antigravity-ha/{module_name}" in wrapper

    for filename in MEMORY_SHARE_FILES:
        module = share_root / filename
        assert module.is_file(), filename
        assert module.read_text(encoding="utf-8").strip(), filename


def test_memory_runtime_is_packaged_with_node_sqlite(
    addon_root: Path,
) -> None:
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")

    assert "nodejs" in dockerfile
    assert "node:sqlite" in dockerfile
    assert re.search(r"node\s+-e\s+.*node:sqlite", dockerfile, re.DOTALL)

    executable_chmod = re.search(
        r"chmod\s+0755\s+\\(?P<body>.*?)(?=&&\s+chmod\s+0644)",
        dockerfile,
        re.DOTALL,
    )
    assert executable_chmod
    assert "/usr/local/bin/*" in executable_chmod.group("body")

    private_modules_chmod = re.search(
        r"chmod\s+0644\s+\\(?P<body>.*?)(?=\n\n|\Z)",
        dockerfile,
        re.DOTALL,
    )
    assert private_modules_chmod
    for filename in MEMORY_SHARE_FILES:
        assert (
            f"/usr/local/share/antigravity-ha/{filename}"
            in private_modules_chmod.group("body")
        )


def test_memory_daemon_is_optional_to_terminal_and_ssh(rootfs: Path) -> None:
    s6_root = rootfs / "etc/s6-overlay/s6-rc.d"
    user_bundle = s6_root / "user/contents.d"
    memory_service = s6_root / "ha-memoryd"

    assert (user_bundle / "ha-memoryd").is_file()
    assert (memory_service / "type").read_text(encoding="utf-8").strip() == (
        "longrun"
    )
    run_script = (memory_service / "run").read_text(encoding="utf-8")
    assert run_script.startswith("#!/command/with-contenv bashio\n")
    assert "/usr/local/bin/ha-memory" in run_script
    assert ">/dev/null 2>&1" not in run_script
    assert "jq --exit-status --raw-output" in run_script
    assert ".reason" in run_script
    assert ".error" in run_script
    assert ".warnings | length" in run_script
    assert "bounded warning(s)" in run_script
    assert "ha_token_unavailable" in run_script
    assert "ha_auth_rejected" in run_script
    assert "ha_command_automation_config_failed" in run_script
    assert "database_busy" in run_script
    assert "database_corrupt" in run_script
    assert "refresh_reason=ha_unavailable" in run_script
    assert all(
        "refresh_output" not in line
        for line in run_script.splitlines()
        if "bashio::log" in line
    )
    assert (memory_service / "dependencies.d/antigravity-ha-init").is_file()
    assert (memory_service / "dependencies.d/ha-read-broker").is_file()

    for service in ("ttyd", "sshd"):
        assert not (s6_root / service / "dependencies.d/ha-memoryd").exists()


def test_init_bootstraps_only_the_local_memory_database(rootfs: Path) -> None:
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )

    assert re.search(r"install\s+-d\s+-m\s+0700", init_script)
    install_block = init_script.split("install -d -m 0700", 1)[1].split(
        "/root/.ssh", 1
    )[0]
    assert "antigravity-ha-memory" not in install_block
    assert "/usr/local/bin/ha-memory init" in init_script
    assert "if /usr/local/bin/ha-memory init" in init_script
    assert "/usr/local/bin/ha-memory refresh" not in init_script


def test_native_plugin_registers_memory_mcp_and_guidance(rootfs: Path) -> None:
    plugin_root = rootfs / "usr/local/share/antigravity-ha/plugins/home-assistant"
    config = json.loads((plugin_root / "mcp_config.json").read_text(encoding="utf-8"))
    instructions = " ".join(
        (plugin_root / "skills/ha-memory/SKILL.md")
        .read_text(encoding="utf-8")
        .lower()
        .split()
    )
    for required in (
        "/data/antigravity-ha-memory/memory.sqlite3",
        "memory_search",
        "memory_remember_explicit",
        "memory_begin_change",
        "memory_verify_change",
        "empty",
        "degraded",
        "stale",
    ):
        assert required in instructions

    memory_mcp = config["mcpServers"]["ha_memory"]
    assert memory_mcp["command"] == "/usr/local/bin/ha-memory-mcp"
    assert memory_mcp["args"] == []
    assert "SUPERVISOR_TOKEN" not in json.dumps(memory_mcp)
    assert memory_mcp["cwd"] == "/config"
    assert "env" not in memory_mcp


def test_memory_mcp_exposes_only_the_structured_protocol(rootfs: Path) -> None:
    mcp = (
        rootfs / "usr/local/share/antigravity-ha/ha-memory-mcp.mjs"
    ).read_text(encoding="utf-8")

    for method in ("initialize", "ping", "tools/list", "tools/call"):
        assert f'"{method}"' in mcp
    for tool in (
        "memory_remember_explicit",
        "memory_list_candidates",
        "memory_reject_candidate",
    ):
        assert f'name: "{tool}"' in mcp
    assert 'const SERVER_VERSION = "1.1.0"' in mcp
    assert 'required: ["summary", "subjects", "expectations"]' in mcp
    assert "Unsupported argument" in mcp
    assert "HA_MEMORY_INSTALLED_TEST" not in mcp

    search_case = mcp.split('case "memory_search":', 1)[1].split(
        'case "memory_show"', 1
    )[0]
    assert 'requireString(args, "subject", {' in search_case
    assert "optional: true" in search_case

    list_case = mcp.split('case "memory_list_candidates":', 1)[1].split(
        'case "memory_reject_candidate"', 1
    )[0]
    assert 'requireString(args, "subject", { maxLength: 512 })' in list_case
    assert "optional: true" not in list_case


def test_memory_mcp_forces_a_bounded_read_only_telegram_surface(
    addon_root: Path,
    rootfs: Path,
) -> None:
    wrapper = (rootfs / "usr/local/bin/ha-memory-mcp").read_text(
        encoding="utf-8"
    )
    mcp_path = rootfs / "usr/local/share/antigravity-ha/ha-memory-mcp.mjs"
    mcp = mcp_path.read_text(encoding="utf-8")
    apparmor = (addon_root / "apparmor.txt").read_text(encoding="utf-8")

    assert "[[ -v HA_TELEGRAM_USER_ID ]]" in wrapper
    assert "[[ -v HA_TELEGRAM_CHAT_ID ]]" in wrapper
    assert "^[1-9][0-9]{0,19}$" in wrapper
    assert "^-?[1-9][0-9]{0,19}$" in wrapper
    assert 'ANTIGRAVITY_HA_TELEGRAM_READ_ONLY="${telegram_read_only}"' in wrapper
    assert "unset HA_TELEGRAM_USER_ID HA_TELEGRAM_CHAT_ID" in wrapper
    assert "TELEGRAM_READ_ONLY_TOOLS" in mcp
    assert "tools.filter((tool) => TELEGRAM_READ_ONLY_TOOLS.has(tool.name))" in mcp
    assert "Memory tool is not enabled" in mcp
    assert "memory-telegram" in mcp
    assert (
        "/usr/local/bin/ha-memory-mcp Px -> "
        "antigravity_home_assistant-memory-telegram,"
    ) in apparmor
    assert "profile antigravity_home_assistant-memory-telegram" in apparmor

    requests = "\n".join(
        json.dumps(message)
        for message in (
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "memory_remember_explicit",
                    "arguments": {},
                },
            },
        )
    )
    environment = {
        **os.environ,
        "ANTIGRAVITY_HA_TELEGRAM_READ_ONLY": "1",
    }
    completed = subprocess.run(
        ["node", str(mcp_path)],
        input=f"{requests}\n",
        text=True,
        capture_output=True,
        timeout=10,
        check=True,
        env=environment,
    )
    responses = {
        message["id"]: message
        for line in completed.stdout.splitlines()
        if line.strip()
        for message in (json.loads(line),)
    }
    listed_names = {tool["name"] for tool in responses[1]["result"]["tools"]}
    assert listed_names == {
        "memory_search",
        "memory_show",
        "memory_list_candidates",
        "memory_status",
        "memory_history",
        "memory_conflicts",
    }
    assert responses[2]["error"]["code"] == -32601
    assert "not enabled" in responses[2]["error"]["message"]


def test_memory_ha_client_uses_the_fixed_snapshot_allowlist(rootfs: Path) -> None:
    client = (
        rootfs / "usr/local/share/antigravity-ha/ha-memory-ha-client.mjs"
    ).read_text(encoding="utf-8")

    for command in (
        "config/area_registry/list",
        "config/device_registry/list",
        "config/entity_registry/list",
        "get_states",
        "automation/config",
        "search/related",
    ):
        assert command in client
    assert "config/automation/config" not in client
    assert "config/automation/related" not in client
    assert 'item_type: "automation"' in client
    assert "HomeAssistantCommandRejectedError" in client
    assert 'remoteCode === "unknown_error"' in client
    assert "automation_related_unavailable" in client
    assert "incomplete automation detail snapshot" in client
    assert "process.env.HA_WS_URL" not in client
    assert "/usr/local/lib/antigravity-ha/playwright/node_modules/ws/wrapper.mjs" in client
    assert "maxPayload: MAX_MESSAGE_BYTES" in client
    assert "perMessageDeflate: false" in client
    assert "configValue === null" in client


def test_default_guidance_defines_verified_memory_workflow(rootfs: Path) -> None:
    guidance = (
        rootfs / "usr/local/share/antigravity-ha/AGENTS.md"
    ).read_text(encoding="utf-8")
    memory_guidance = guidance.split("## Validated Home Assistant memory", 1)[1].split(
        "## Browser validation", 1
    )[0]
    normalized = " ".join(memory_guidance.lower().split())

    assert "/data/antigravity-ha-memory/memory.sqlite3" in normalized
    assert "ha-memory search" in normalized
    assert "memory_remember_explicit" in normalized
    assert "ha-memory remember" in normalized
    assert re.search(
        r"candidate.{0,160}verified.{0,160}applied",
        normalized,
    )

    assert "memory_begin_change" in normalized
    assert "memory_verify_change" in normalized
    assert "every persistent home assistant" in normalized
    assert "when practical" not in normalized
    assert "never use a weaker exists/name check" in normalized
    assert "home assistant api" in normalized
    _assert_nearby_terms(
        normalized,
        r"memory_verify_change",
        (r"after|following", r"fresh", r"home assistant api"),
    )

    _assert_nearby_terms(
        normalized,
        r"agents\.md",
        (r"never", r"entity-specific", r"aliases|preferences|relationships"),
    )

    _assert_nearby_terms(
        normalized,
        r"transient|temporary|current",
        (r"do not|never", r"persist|store", r"state"),
    )
    _assert_nearby_terms(
        normalized,
        r"database|sqlite",
        (r"do not|never", r"read|dump|load", r"entire|whole|full"),
    )

    assert "ha-memory rollback" in normalized
    assert "history" in normalized or "audit" in normalized
    _assert_nearby_terms(
        normalized,
        r"roll back|rollback",
        (r"do not|never", r"home assistant|snapshot"),
    )


def test_memory_schema_declares_catalog_workflow_and_audit_tables(
    rootfs: Path,
) -> None:
    core = (
        rootfs / "usr/local/share/antigravity-ha/ha-memory-core.mjs"
    ).read_text(encoding="utf-8")

    definitions = {table: _table_definition(core, table) for table in MEMORY_TABLES}
    assert re.search(
        r"CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?search_fts",
        core,
        re.IGNORECASE,
    )

    memory_status_sql = definitions["memory_items"]
    assert re.search(r"\bstatus\b", memory_status_sql, re.IGNORECASE)
    _assert_quoted_sql_values(memory_status_sql, MEMORY_ITEM_STATUSES)

    change_status_sql = definitions["change_records"]
    assert re.search(r"\bstatus\b", change_status_sql, re.IGNORECASE)
    assert re.search(r"\bexpectation_hash\b", change_status_sql, re.IGNORECASE)
    _assert_quoted_sql_values(change_status_sql, CHANGE_STATUSES)


def test_memory_feature_does_not_expand_app_privileges(
    addon_config: dict,
) -> None:
    assert addon_config["homeassistant_api"] is True
    assert addon_config["hassio_api"] is True
    assert addon_config["hassio_role"] == "manager"
    assert addon_config.get("apparmor", True) is True

    for forbidden_key in ("docker_api", "full_access", "host_network"):
        assert forbidden_key not in addon_config


def test_v2_memory_migration_is_identity_and_fail_closed(
    repository_root: Path, rootfs: Path
) -> None:
    core = (
        rootfs / "usr/local/share/antigravity-ha/ha-memory-core.mjs"
    ).read_text(encoding="utf-8")
    migration = (repository_root / "docs/v2/migration-release.md").read_text(
        encoding="utf-8"
    )
    smoke = (repository_root / "tests/memory-smoke.sh").read_text(encoding="utf-8")

    assert "export const MEMORY_SCHEMA_VERSION = 1" in core
    assert '"migration_required"' in core
    assert '"unsupported_schema"' in core
    assert "readOnly: true" in core
    assert "PRAGMA quick_check" in core
    assert "public 1.0.4와 v2.0.0은 모두 application schema `1`" in migration
    assert "현재 binary는 forward migration을 구현하지 않는다" in migration
    assert "PERSISTED_MCP_RECALL" in smoke
    assert "new MCP process did not recall the MCP-applied fact" in smoke
