import json
import re
import subprocess
from copy import deepcopy
from pathlib import Path

import pytest
import yaml


CURRENT_MODE_SCHEMA = (
    "list(preserve|refresh_managed|reset_v2|refresh_agents|refresh_all)"
)
CURRENT_MODES = {
    "preserve",
    "refresh_managed",
    "reset_v2",
    "refresh_agents",
    "refresh_all",
}


def _merge(defaults: dict, overrides: dict) -> dict:
    """Model Supervisor's dict-merge strategy for this flat option fixture."""
    value = deepcopy(defaults)
    value.update(deepcopy(overrides))
    return value


def _validate_value(schema: object, value: object) -> None:
    if isinstance(schema, list):
        assert len(schema) == 1
        if not isinstance(value, list):
            raise ValueError("list option is invalid")
        for item in value:
            _validate_value(schema[0], item)
        return
    if schema == "bool":
        if not isinstance(value, bool):
            raise ValueError("boolean option is invalid")
        return
    if isinstance(schema, str) and schema.startswith("list("):
        allowed = schema.removeprefix("list(").removesuffix(")").split("|")
        if not isinstance(value, str) or value not in allowed:
            raise ValueError("enum option is invalid")
        return
    if isinstance(schema, str) and schema.startswith("match("):
        pattern = schema.removeprefix("match(").removesuffix(")")
        if not isinstance(value, str) or re.fullmatch(pattern, value) is None:
            raise ValueError("matched string option is invalid")
        return
    if isinstance(schema, str) and schema.rstrip("?") in {"password", "str"}:
        if not isinstance(value, str):
            raise ValueError("string option is invalid")
        return
    raise AssertionError(f"fixture does not model schema element {schema!r}")


def _supervisor_write_options_model(
    defaults: dict,
    persisted: dict,
    schema: dict,
) -> dict:
    """Model App.options merge followed by AppOptions validation/drop."""
    merged = _merge(defaults, persisted)
    validated = {}
    for key, value in merged.items():
        if key not in schema:
            continue
        _validate_value(schema[key], value)
        validated[key] = deepcopy(value)
    missing = set(schema) - set(validated)
    required_missing = {
        key
        for key in missing
        if not (
            isinstance(schema[key], str) and schema[key].endswith("?")
        )
    }
    if required_missing:
        raise ValueError(f"required options are missing: {sorted(required_missing)}")
    return validated


def test_current_supervisor_prevalidation_fixture(
    addon_config: dict,
    repository_root: Path,
) -> None:
    fixture_path = (
        repository_root
        / "tests/fixtures/supervisor_manual_update_prevalidation.json"
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    assert fixture["schema"] == (
        "antigravity-ha-supervisor-manual-update-prevalidation/v1"
    )
    assert fixture["supervisor_source"] == {
        "repository": "https://github.com/home-assistant/supervisor",
        "commit": "2475a9ef8b954f399d7dac244d3ee2b1aa6d6236",
        "commit_date": "2026-08-11",
        "flow": [
            "App.update stores the new App config",
            "App.update finally restores the running App with App.start",
            "App.start calls App.write_options",
            "App.write_options validates merged defaults and persisted options",
            "App.start runs the container only after validation succeeds",
        ],
        "unknown_option_behavior": "drop",
    }
    assert fixture["expected_container_init_reached"] is True

    defaults = addon_config["options"]
    schema = addon_config["schema"]
    assert schema["antigravity_user_files_update_mode"] == CURRENT_MODE_SCHEMA
    assert set(CURRENT_MODE_SCHEMA[5:-1].split("|")) == CURRENT_MODES
    pre_compat_schema = deepcopy(schema)
    pre_compat_schema["antigravity_user_files_update_mode"] = (
        "list(preserve|refresh_managed|reset_v2)"
    )

    for legacy_mode in fixture["legacy_update_modes"]:
        persisted = {
            **fixture["v1_persisted_overrides"],
            "antigravity_user_files_update_mode": legacy_mode,
        }
        with pytest.raises(ValueError, match="enum option is invalid"):
            _supervisor_write_options_model(
                defaults,
                persisted,
                pre_compat_schema,
            )

        prevalidated = _supervisor_write_options_model(
            defaults,
            persisted,
            schema,
        )
        assert prevalidated["antigravity_user_files_update_mode"] == legacy_mode
        assert set(fixture["expected_dropped_keys"]).isdisjoint(prevalidated)
        for key in fixture["expected_current_default_keys"]:
            assert prevalidated[key] == defaults[key]
        normalized = {
            **prevalidated,
            "antigravity_user_files_update_mode": fixture["normalized_mode"],
        }
        assert normalized == {
            **prevalidated,
            "antigravity_user_files_update_mode": "refresh_managed",
        }


def test_supervisor_options_migration_component_suite(
    repository_root: Path,
) -> None:
    subprocess.run(
        [
            "node",
            "--test",
            "tests/supervisor_options_migration_test.mjs",
        ],
        cwd=repository_root,
        check=True,
    )


def test_migration_helper_has_fixed_private_request_boundary(
    addon_root: Path,
    rootfs: Path,
) -> None:
    helper_path = (
        rootfs
        / "usr/local/share/antigravity-ha/supervisor-options-migrate.mjs"
    )
    helper = helper_path.read_text(encoding="utf-8")
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")
    apparmor = (addon_root / "apparmor.txt").read_text(encoding="utf-8")

    assert helper.count('"http://supervisor/addons/self/options"') == 1
    assert 'spawnSyncImpl("/usr/bin/curl"' in helper
    assert '"--disable"' in helper
    assert '"--noproxy"' in helper
    assert '"--proxy"' in helper
    assert '"--proto"' in helper
    assert '"=http"' in helper
    assert '"--connect-timeout"' in helper
    assert '"--max-time"' in helper
    assert "timeout: 20_000" in helper
    assert "`@${headerPath}`" in helper
    assert "`@${requestPath}`" in helper
    assert "writePrivateFile(requestPath" in helper
    assert "writePrivateFile(responsePath" in helper
    assert 'HOME: "/nonexistent"' in helper
    assert "delete process.env.SUPERVISOR_TOKEN" in helper
    assert "process.argv.length !== 2" in helper
    assert "writeFileSync(optionsPath" not in helper
    assert "renameSync" not in helper
    for injection_name in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "CURL_HOME",
    ):
        assert f"process.env.{injection_name}" not in helper

    assert "/usr/local/share/antigravity-ha/supervisor-options-migrate.mjs" in (
        dockerfile
    )
    assert (
        "node --check "
        "/usr/local/share/antigravity-ha/supervisor-options-migrate.mjs"
    ) in dockerfile

    init_profile = apparmor.split(
        "profile antigravity_home_assistant-init", maxsplit=1
    )[1].split("\n}\n", maxsplit=1)[0]
    main_profile = apparmor.split("\n}\n", maxsplit=1)[0]
    assert "  network," in init_profile
    assert "  /data/** rwkl," in init_profile
    assert "  /run/antigravity-ha/supervisor.token rw," in init_profile
    assert "deny @{PROC}@{pid}/{cmdline,environ,mem} rwklm," in init_profile
    assert "deny /data/options.json rwklm," in main_profile
    assert "deny /run/antigravity-ha/supervisor.token rwklm," in main_profile


def test_init_preserves_then_confines_supervisor_bootstrap_credential(
    rootfs: Path,
) -> None:
    launcher = (rootfs / "usr/local/libexec/ha-init-runtime").read_text(
        encoding="utf-8"
    )
    init = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    assert launcher.splitlines()[:3] == [
        "#!/bin/bash -p",
        "set -Eeuo pipefail",
        "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH",
    ]
    assert "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN" not in (
        launcher
    )

    capture = "supervisor_credential_bootstrap=${SUPERVISOR_TOKEN:-}"
    capture_index = init.index(capture)
    unset_index = init.index("unset SUPERVISOR_TOKEN", capture_index)
    first_external_index = init.index("rm -rf --", unset_index)
    user_files_index = init.index("/usr/local/bin/antigravity-user-files-update")
    plugin_index = init.index('"${MANAGED_PLUGIN_UPDATE}"')
    telegram_index = init.index(
        "/usr/local/libexec/ha-telegram-home-bootstrap --runtime"
    )
    token_write_index = init.index(
        "printf '%s' \"${supervisor_credential_bootstrap}\""
    )
    bootstrap_unset_index = init.index(
        "unset supervisor_credential_bootstrap", token_write_index
    )
    migration_index = init.index('"${SUPERVISOR_OPTIONS_MIGRATION}"')

    assert capture_index < unset_index < first_external_index
    assert "export -n supervisor_credential_bootstrap" in init[
        unset_index:first_external_index
    ]
    assert user_files_index < plugin_index < telegram_index < token_write_index
    assert token_write_index < bootstrap_unset_index < migration_index
    assert "${SUPERVISOR_TOKEN" not in init[unset_index + 1 :]
    assert "legacy_user_files_mode_migration_pending=false" in init
    assert "persistence will retry on the next App start" in init


def test_legacy_modes_are_documented_as_migration_only(
    addon_root: Path,
) -> None:
    for locale in ("en", "ko"):
        translation = yaml.safe_load(
            (addon_root / "translations" / f"{locale}.yaml").read_text(
                encoding="utf-8"
            )
        )
        description = translation["configuration"][
            "antigravity_user_files_update_mode"
        ]["description"]
        assert "refresh_agents" in description
        assert "refresh_all" in description
        assert "refresh_managed" in description
