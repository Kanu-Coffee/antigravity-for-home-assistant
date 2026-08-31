import subprocess
from pathlib import Path


EXPECTED_OPTIONS = {
    "remote_control_name": "home-assistant",
    "antigravity_sensitive_data_access": False,
    "home_assistant_browser_auto_auth": True,
    "log_level": "info",
}


def test_v3_public_option_surface(addon_config: dict) -> None:
    assert addon_config["options"] == EXPECTED_OPTIONS
    assert set(addon_config["schema"]) == set(EXPECTED_OPTIONS)


def test_v3_option_reset_component_suite(repository_root: Path) -> None:
    subprocess.run(
        ["node", "--test", "tests/supervisor_options_migration_test.mjs"],
        cwd=repository_root,
        check=True,
    )


def test_option_reset_has_fixed_private_supervisor_boundary(
    addon_root: Path,
    rootfs: Path,
) -> None:
    helper = (
        rootfs
        / "usr/local/share/antigravity-ha/supervisor-options-migrate.mjs"
    ).read_text(encoding="utf-8")
    init = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    assert helper.count('"http://supervisor/addons/self/options"') == 1
    assert '"--noproxy", "*"' in helper
    assert '"--proto", "=http"' in helper
    assert "`@${headerPath}`" in helper
    assert "`@${requestPath}`" in helper
    assert 'HOME: "/nonexistent"' in helper
    assert "delete process.env.SUPERVISOR_TOKEN" in helper
    assert "DEFAULT_OPTIONS" in helper
    assert "writeFileSync(optionsPath" not in helper
    assert "supervisor_credential_bootstrap=${SUPERVISOR_TOKEN:-}" in init
    assert "unset SUPERVISOR_TOKEN" in init
    assert 'chmod 0400 "${credential_tmp}"' in init
    assert 'unset supervisor_credential_bootstrap' in init
