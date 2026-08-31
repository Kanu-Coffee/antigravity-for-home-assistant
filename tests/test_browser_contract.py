import json
import re
from pathlib import Path


READ_ONLY_BROWSER_TOOLS = {
    "browser_console_messages",
    "browser_network_requests",
    "browser_snapshot",
    "browser_take_screenshot",
}

PROXY_ALLOWED_NON_INTERACTIVE_TOOLS = {
    "browser_close",
    *READ_ONLY_BROWSER_TOOLS,
    "browser_hover",
    "browser_navigate",
    "browser_navigate_back",
    "browser_resize",
    "browser_tabs",
    "browser_wait_for",
}

INTERACTIVE_BROWSER_TOOLS = {
    "browser_click",
    "browser_fill_form",
    "browser_press_key",
    "browser_select_option",
    "browser_type",
}

ALLOWED_BROWSER_TOOLS = (
    PROXY_ALLOWED_NON_INTERACTIVE_TOOLS | INTERACTIVE_BROWSER_TOOLS
)

DANGEROUS_BROWSER_TOOLS = {
    "browser_evaluate",
    "browser_file_upload",
    "browser_install",
    "browser_network_request",
    "browser_pdf_save",
    "browser_run_code",
    "browser_run_code_unsafe",
}


def test_playwright_dependency_is_locked_and_built_into_image(
    addon_root: Path,
) -> None:
    playwright_root = addon_root / "playwright"
    package = json.loads((playwright_root / "package.json").read_text(encoding="utf-8"))
    lock = json.loads(
        (playwright_root / "package-lock.json").read_text(encoding="utf-8")
    )
    dockerfile = (addon_root / "Dockerfile").read_text(encoding="utf-8")

    expected_version = package["dependencies"]["@playwright/mcp"]
    assert re.fullmatch(r"\d+\.\d+\.\d+", expected_version)
    assert lock["packages"][""]["dependencies"]["@playwright/mcp"] == expected_version
    assert (
        lock["packages"]["node_modules/@playwright/mcp"]["version"]
        == expected_version
    )
    assert re.search(
        rf"^ARG PLAYWRIGHT_MCP_VERSION={re.escape(expected_version)}$",
        dockerfile,
        re.MULTILINE,
    )

    assert "chromium" in dockerfile
    assert "nodejs" in dockerfile
    assert "fonts-noto-cjk" in dockerfile
    assert "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1" in dockerfile
    assert "npm ci --prefix /usr/local/lib/antigravity-ha/playwright" in dockerfile
    for npm_flag in ["--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]:
        assert npm_flag in dockerfile
    assert "chromium --version" in dockerfile
    assert "npx " not in dockerfile


def test_playwright_runtime_drops_supervisor_credential_access(
    addon_root: Path,
    rootfs: Path,
) -> None:
    wrapper = (rootfs / "usr/local/bin/ha-playwright-mcp").read_text(
        encoding="utf-8"
    )
    runtime = (
        rootfs / "usr/local/libexec/ha-playwright-runtime"
    ).read_text(encoding="utf-8")
    apparmor = (addon_root / "apparmor.txt").read_text(encoding="utf-8")

    assert "exec /usr/local/libexec/ha-playwright-runtime" in wrapper
    assert "SUPERVISOR_TOKEN" in runtime
    assert "exec /usr/bin/env -i" in runtime
    assert (
        "/usr/bin/node "
        "/usr/local/share/antigravity-ha/playwright-mcp-proxy.mjs"
    ) in runtime
    assert (
        "/usr/local/libexec/ha-playwright-runtime Px -> "
        "antigravity_home_assistant-browser,"
    ) in apparmor


def test_antigravity_plugin_registers_restricted_playwright_mcp(
    rootfs: Path,
) -> None:
    plugin_root = (
        rootfs / "usr/local/share/antigravity-ha/plugins/home-assistant"
    )
    config = json.loads((plugin_root / "mcp_config.json").read_text(encoding="utf-8"))
    playwright = config["mcpServers"]["playwright"]
    assert playwright["command"] == "/usr/local/bin/ha-playwright-mcp"
    assert playwright["args"] == []
    assert playwright["cwd"] == "/config"
    assert "SUPERVISOR_TOKEN" not in json.dumps(playwright)
    assert {
        "browser_evaluate",
        "browser_file_upload",
        "browser_install",
        "browser_run_code",
    } <= set(playwright["disabledTools"])

    dashboard_skill = (
        plugin_root / "skills/ha-dashboard/SKILL.md"
    ).read_text(encoding="utf-8")
    safety_rule = (
        plugin_root / "rules/home-assistant-safety.md"
    ).read_text(encoding="utf-8")
    for guidance in (dashboard_skill, safety_rule):
        assert "http://127.0.0.1:8099/" in guidance
        assert "explicit" in guidance.lower()

    proxy = (
        rootfs / "usr/local/share/antigravity-ha/playwright-mcp-proxy.mjs"
    ).read_text(encoding="utf-8")
    allowlist_match = re.search(
        r"const ALLOWED_TOOLS = new Set\(\[(.*?)\]\);", proxy, re.DOTALL
    )
    assert allowlist_match
    proxy_tools = set(re.findall(r'"(browser_[a-z_]+)"', allowlist_match.group(1)))
    assert ALLOWED_BROWSER_TOOLS == proxy_tools
    assert READ_ONLY_BROWSER_TOOLS.isdisjoint(INTERACTIVE_BROWSER_TOOLS)


def test_playwright_approval_policy_uses_native_settings_permissions(
    rootfs: Path,
) -> None:
    wrapper = (rootfs / "usr/local/bin/antigravity").read_text(encoding="utf-8")
    settings = (rootfs / "etc/antigravity/settings.json").read_text(
        encoding="utf-8"
    )

    assert "mcp_servers.playwright" not in wrapper
    assert " -c " not in wrapper
    assert "-dangerously-skip-permissions" in wrapper
    assert "-sandbox | -sandbox=*" in wrapper
    assert "--sandbox | --sandbox=*" in wrapper
    assert "-no-sandbox | -no-sandbox=*" in wrapper
    assert "--no-sandbox | --no-sandbox=*" in wrapper
    assert "native sandbox overrides are disabled" in wrapper
    assert '"permissions"' not in settings
    assert "toolPermission" not in settings


def test_playwright_wrapper_uses_only_the_image_managed_stdio_server(
    rootfs: Path,
) -> None:
    wrapper = (rootfs / "usr/local/bin/ha-playwright-mcp").read_text(
        encoding="utf-8"
    )

    assert wrapper.splitlines()[:3] == [
        "#!/bin/bash -p",
        "set -Eeuo pipefail",
        "unset BASH_ENV ENV NODE_OPTIONS NODE_PATH SUPERVISOR_TOKEN",
    ]
    assert "set -Eeuo pipefail" in wrapper
    assert "umask 077" in wrapper
    assert 'readonly PLAYWRIGHT_HOME=/run/antigravity-ha/playwright-home' in wrapper
    assert '"${RUNTIME_DIR}/playwright-output" "${PLAYWRIGHT_HOME}"' in wrapper
    assert "PLAYWRIGHT_PROXY" not in wrapper
    assert 'if (( $# != 0 )); then' in wrapper
    assert "ANTIGRAVITY_HA_CHANNEL" in wrapper
    assert "exec /usr/local/libexec/ha-playwright-runtime" in wrapper
    assert 'readonly NODE_BINARY=/usr/bin/node' in wrapper
    assert "NODE_OPTIONS" in wrapper
    assert "NODE_PATH" in wrapper
    assert 'for variable in "${!PLAYWRIGHT_MCP_@}"' in wrapper
    assert "antigravity_HA_BROWSER_TOKEN_VALIDATED=1" in wrapper
    assert '"${NODE_BINARY}" "${BROWSER_AUTH_CHECK}"' in wrapper
    ensure_call = "/usr/local/bin/ha-browser-auth-ensure --quiet || true"
    assert ensure_call in wrapper
    assert wrapper.index(ensure_call) < wrapper.index(
        'if [[ -r "${BROWSER_TOKEN_FILE}" ]]'
    )
    assert '"$@"' not in wrapper
    assert "npx" not in wrapper
    assert "npm" not in wrapper
    assert "--port" not in wrapper

    runtime = (
        rootfs / "usr/local/libexec/ha-playwright-runtime"
    ).read_text(encoding="utf-8")
    assert "/usr/local/share/antigravity-ha/playwright-mcp-proxy.mjs" in runtime
    assert "SUPERVISOR_TOKEN" in runtime
    assert "exec /usr/bin/env -i" in runtime

    proxy = (
        rootfs / "usr/local/share/antigravity-ha/playwright-mcp-proxy.mjs"
    ).read_text(encoding="utf-8")
    assert '"--config", PLAYWRIGHT_CONFIG' in proxy
    assert '"--secrets"' not in proxy
    assert "PLAYWRIGHT_SECRETS" not in proxy
    assert 'readFileSync(HOME_ASSISTANT_BROWSER_TOKEN, "utf8")' in proxy
    assert "childEnvironment.HA_BROWSER_TOKEN = token" in proxy
    assert "const childEnvironment = {" in proxy
    assert "...process.env" not in proxy
    assert "PLAYWRIGHT_MCP_" not in proxy
    assert "NODE_OPTIONS" not in proxy
    assert "NODE_PATH" not in proxy
    assert 'process.env.antigravity_HA_BROWSER_TOKEN_VALIDATED === "1"' in proxy
    assert "function redactExactSecret(value)" in proxy
    assert "writeJson(process.stdout, message, true)" in proxy
    assert 'createInterface({ input: child.stderr, crlfDelay: Infinity })' in proxy
    assert 'Object.prototype.hasOwnProperty.call(toolArgs, "filename")' in proxy
    assert "enabledTools.has(toolName)" in proxy
    assert ".filter((tool) => enabledTools.has(tool.name))" in proxy
    assert "HOME_ASSISTANT_NAVIGATION_GUIDANCE" in proxy
    assert "http://127.0.0.1:8099/" in proxy
    assert ".map(addImageManagedGuidance)" in proxy



def test_playwright_runtime_is_headless_isolated_and_ephemeral(
    rootfs: Path,
) -> None:
    config = json.loads(
        (rootfs / "usr/local/share/antigravity-ha/playwright-mcp.json").read_text(
            encoding="utf-8"
        )
    )

    browser = config["browser"]
    launch = browser["launchOptions"]
    context = browser["contextOptions"]
    assert browser["browserName"] == "chromium"
    assert browser["isolated"] is True
    assert "userDataDir" not in browser
    assert launch["headless"] is True
    assert launch["executablePath"] == "/usr/bin/chromium"
    assert launch["chromiumSandbox"] is False
    assert {"--disable-dev-shm-usage", "--no-sandbox"} <= set(launch["args"])
    assert context["viewport"] == {"width": 1440, "height": 900}
    assert context["locale"] == "ko-KR"

    assert set(config["capabilities"]) == {"core", "network"}
    assert config["outputDir"] == "/run/antigravity-ha/playwright-output"
    assert config["outputMaxSize"] == 50 * 1024 * 1024
    assert config["outputMode"] == "stdout"
    assert config["saveSession"] is False
    assert config["sharedBrowserContext"] is False
    assert config["imageResponses"] == "allow"
    assert config["allowUnrestrictedFileAccess"] is False
    assert config["codegen"] == "none"
    assert config["browser"]["initPage"] == [
        "/usr/local/share/antigravity-ha/playwright-init-page.ts"
    ]


def test_home_assistant_browser_auth_is_limited_to_loopback_gateway(
    rootfs: Path,
) -> None:
    init_page = (
        rootfs / "usr/local/share/antigravity-ha/playwright-init-page.ts"
    ).read_text(encoding="utf-8")
    nginx = (rootfs / "etc/nginx/nginx.conf").read_text(encoding="utf-8")

    assert 'process.env.HA_BROWSER_TOKEN' in init_page
    assert "SUPERVISOR_TOKEN" not in init_page
    assert 'window.location.origin !== "http://127.0.0.1:8099"' in init_page
    assert 'window.location.origin !== "http://localhost:8099"' in init_page
    assert 'window.localStorage.setItem("hassTokens"' in init_page
    assert "console." not in init_page

    assert "listen 127.0.0.1:8099;" in nginx
    assert not re.search(r"^\s*listen\s+8099;", nginx, re.MULTILINE)
    assert "location = /api/websocket" in nginx
    assert "rewrite ^ /core/websocket break;" not in nginx
    assert "rewrite ^/api/(.*)$ /core/api/$1 break;" not in nginx
    assert "proxy_pass $supervisor_upstream;" not in nginx
    assert "include /run/antigravity-ha/home-assistant-render-upstream.conf;" in nginx
    assert nginx.count("proxy_pass $ha_frontend_upstream;") == 3
    assert nginx.count('proxy_set_header X-Forwarded-For "";') == 3
    assert nginx.count('proxy_set_header X-Real-IP "";') == 3
    assert nginx.count('proxy_set_header Forwarded "";') == 3
    assert nginx.count("proxy_ssl_server_name on;") == 3
    assert nginx.count("proxy_ssl_name homeassistant;") == 3
    assert nginx.count(
        "proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;"
    ) == 3
    assert nginx.count("proxy_ssl_verify on;") == 3
    assert "proxy_ssl_verify off;" not in nginx


def test_browser_auth_refresh_is_private_fail_closed_and_called_at_init(
    rootfs: Path,
) -> None:
    init_script = (rootfs / "usr/local/bin/antigravity-ha-init").read_text(
        encoding="utf-8"
    )
    refresh = (rootfs / "usr/local/bin/ha-browser-auth-refresh").read_text(
        encoding="utf-8"
    )

    assert "HA_BROWSER_AUTH_STATUS=${RUNTIME_DIR}/browser-auth-status.json" in init_script
    assert 'install -d -m 0700' in init_script
    assert "PLAYWRIGHT_HOME=${RUNTIME_DIR}/playwright-home" in init_script
    assert "PLAYWRIGHT_OUTPUT=${RUNTIME_DIR}/playwright-output" in init_script
    assert 'rm -rf -- "${PLAYWRIGHT_HOME}" "${PLAYWRIGHT_OUTPUT}"' in init_script
    assert 'printf \'HA_BROWSER_TOKEN=%s\\n\'' not in init_script
    assert "unset NODE_OPTIONS NODE_PATH" in init_script
    assert 'for variable in "${!PLAYWRIGHT_MCP_@}"' in init_script
    init_ensure = "/usr/local/bin/ha-browser-auth-ensure --quiet"
    assert init_ensure in init_script
    assert init_script.index(init_ensure) < init_script.index(
        "browser_auth_status=$(jq"
    )
    assert "home_assistant_browser_token" not in init_script
    assert 'HA_BROWSER_TOKEN="${browser_token}"' not in init_script
    assert "Browser automatic authentication is not ready" in init_script
    assert "system-read-only" in (
        rootfs / "usr/local/share/antigravity-ha/browser-auth-check.mjs"
    ).read_text(encoding="utf-8")
    assert 'chmod 0600 "${upstream_tmp}"' in init_script
    assert 'mv -f "${upstream_tmp}" "${HA_RENDER_UPSTREAM}"' in init_script
    assert "'$ha_frontend_upstream'" in init_script
    assert "'\\$ha_frontend_upstream'" not in init_script

    assert "RUNTIME_TOKEN=${RUNTIME_DIR}/home-assistant-browser.token" in refresh
    assert "RUNTIME_STATUS=${RUNTIME_DIR}/browser-auth-status.json" in refresh
    assert "MANAGED_TOKEN=/data/browser-auth/managed-token" in refresh
    assert 'install -d -m 0700 "${RUNTIME_DIR}"' in refresh
    remove_runtime_token = 'rm -f "${RUNTIME_TOKEN}"'
    assert remove_runtime_token in refresh
    assert refresh.index(remove_runtime_token) < refresh.index(
        "antigravity_ha_config_validate"
    )
    assert 'status_tmp=$(mktemp "${RUNTIME_DIR}/.browser-auth-status.XXXXXX")' in (
        refresh
    )
    assert 'check_tmp=$(mktemp "${RUNTIME_DIR}/.browser-auth-check.XXXXXX")' in (
        refresh
    )
    assert 'chmod 0600 "${status_tmp}"' in refresh
    assert 'mv -f "${status_tmp}" "${RUNTIME_STATUS}"' in refresh
    optional_credential_load = (
        "if ! antigravity_ha_load_supervisor_credential --optional; then"
    )
    assert optional_credential_load in refresh
    assert refresh.index('status_tmp=$(mktemp "${RUNTIME_DIR}/.browser-auth-status.') < (
        refresh.index(optional_credential_load)
    )
    assert refresh.index("write_status()") < refresh.index(optional_credential_load)
    assert refresh.index(optional_credential_load) < refresh.index(
        "antigravity_ha_config_validate"
    )
    assert "write_status rejected invalid_options" in refresh
    assert "antigravity_ha_config_bool home_assistant_browser_auto_auth true" in refresh
    assert "write_status disabled option_disabled" in refresh
    assert "write_status rejected invalid_token_format" in refresh
    assert "write_status rejected supervisor_validation_unavailable" in refresh
    assert "write_status rejected user_or_token_validation_failed" in refresh
    assert "2>/dev/null" in refresh

    assert 'token_tmp=$(mktemp "${RUNTIME_DIR}/.home-assistant-browser-token.XXXXXX")' in (
        refresh
    )
    assert 'printf \'%s\' "${browser_token}" > "${token_tmp}"' in refresh
    assert 'chmod 0600 "${token_tmp}"' in refresh
    assert 'mv -f "${token_tmp}" "${RUNTIME_TOKEN}"' in refresh
    assert 'echo "${browser_token}"' not in refresh
    assert '"${AUTH_CHECK}" "${browser_token}"' not in refresh


def test_browser_auth_refresh_accepts_only_managed_identity(
    rootfs: Path,
) -> None:
    refresh = (rootfs / "usr/local/bin/ha-browser-auth-refresh").read_text(
        encoding="utf-8"
    )

    validation = 'if ! HA_BROWSER_TOKEN="${browser_token}"'
    assert "home_assistant_browser_token" not in refresh
    assert "source_name=manual" not in refresh
    assert "source_name=managed" not in refresh
    assert '-L "${MANAGED_TOKEN}"' in refresh
    assert '-L "${MANAGED_STATE}"' in refresh
    assert '! -f "${MANAGED_TOKEN}"' in refresh
    assert '! -r "${MANAGED_TOKEN}"' in refresh
    assert '! -f "${MANAGED_STATE}"' in refresh
    assert '! -r "${MANAGED_STATE}"' in refresh
    assert "write_status unconfigured" in refresh
    assert '.phase == "ready"' in refresh
    assert '(has("temporary_username") | not)' in refresh
    assert '.operation_id[0:16]' in refresh
    assert "write_status rejected managed_state_invalid" in refresh
    assert validation in refresh
    assert (
        'HA_BROWSER_EXPECTED_USER_ID="${expected_managed_user_id:-}"' in refresh
    )
    assert (
        'HA_BROWSER_EXPECTED_CLIENT_NAME="${expected_managed_client_name:-}"'
        in refresh
    )
    assert "write_status rejected managed_state_user_mismatch" in refresh
    assert '--arg source managed' in refresh
    assert "select(.status == \"ready\") | . + {source: $source}" in refresh
    assert refresh.index("cleanup_managed_temps") < refresh.index(
        '-L "${MANAGED_TOKEN}"'
    )
    assert refresh.index('-L "${MANAGED_TOKEN}"') < refresh.index(validation)


def test_browser_network_diagnostic_is_read_only_and_rejects_ip_trust(
    rootfs: Path,
) -> None:
    diagnostic = (rootfs / "usr/local/bin/ha-browser-network-info").read_text(
        encoding="utf-8"
    )

    assert "--write-out '%{local_ip}\\n%{remote_ip}\\n%{http_code}\\n'" in diagnostic
    assert "/apps/self/info /addons/self/info" in diagnostic
    assert 'safe_for_persistent_trusted_networks: false' in diagnostic
    assert "configuration.yaml" not in diagnostic
    assert ".storage" not in diagnostic
    assert "trusted_proxies" not in diagnostic


def test_browser_auth_checker_requires_exact_least_privilege_user(
    rootfs: Path,
) -> None:
    checker = (
        rootfs / "usr/local/share/antigravity-ha/browser-auth-check.mjs"
    ).read_text(encoding="utf-8")

    assert 'browserSession.request("auth/current_user")' in checker
    assert (
        'const supervisorWebsocketUrl = "ws://supervisor/core/websocket"'
        in checker
    )
    assert 'fetch("http://supervisor/core/info"' in checker
    assert '://homeassistant:${port}/api/websocket`' in checker
    assert "browserToken, coreWebsocketUrl" in checker
    assert "supervisorToken," in checker
    assert "supervisorWebsocketUrl," in checker
    assert "HA_BROWSER_AUTH_WEBSOCKET_URL" not in checker
    assert 'supervisorSession.request("config/auth/list")' in checker
    assert 'currentUser.is_admin === false' in checker
    assert 'user.local_only === true' in checker
    assert 'user.system_generated === false' in checker
    assert 'groupIds.length === 1' in checker
    assert 'groupIds[0] === "system-read-only"' in checker
    assert checker.count("access_token: accessToken") == 1
    assert (
        'socket.send(JSON.stringify({ type: "auth", access_token: accessToken }))'
        in checker
    )
    assert "process.env.HA_BROWSER_EXPECTED_USER_ID" in checker
    assert "process.env.HA_BROWSER_EXPECTED_CLIENT_NAME" in checker
    assert 'browserSession.request("auth/refresh_tokens")' in checker
    assert 'currentRefreshToken?.type !== "long_lived_access_token"' in checker
    assert (
        "currentRefreshToken?.client_name !== expectedManagedClientName" in checker
    )
    status_output = checker.split("process.stdout.write", 1)[1].split(
        "} catch (error)", 1
    )[0]
    for secret_name in ("browserToken", "supervisorToken", "accessToken"):
        assert secret_name not in status_output


def test_real_playwright_mcp_smoke_is_part_of_container_validation(
    repository_root: Path,
) -> None:
    smoke_script = repository_root / "tests/playwright_mcp_smoke.mjs"
    gateway_fixture = repository_root / "tests/ha_browser_gateway_fixture.mjs"
    docker_smoke = (repository_root / "tests/docker-smoke.sh").read_text(
        encoding="utf-8"
    )

    assert smoke_script.read_text(encoding="utf-8").startswith(
        'import assert from "node:assert/strict";\n'
    )
    assert gateway_fixture.read_text(encoding="utf-8").startswith(
        'import assert from "node:assert/strict";\n'
    )
    assert "tests/playwright_mcp_smoke.mjs" in docker_smoke
    assert "tests/ha_browser_gateway_fixture.mjs" in docker_smoke
    assert "tests/v3-upgrade-smoke.sh" in docker_smoke
    assert "/usr/local/bin/ha-playwright-mcp" in docker_smoke
    assert "plugin validate" in docker_smoke
    assert "mcpServers.playwright.command" in docker_smoke
    assert "PLAYWRIGHT_MCP_SMOKE_URL=http://127.0.0.1:8099/" in docker_smoke
    assert "PLAYWRIGHT_MCP_SMOKE_EXPECT_SOURCE_IP" in docker_smoke
    assert "PLAYWRIGHT_MCP_SMOKE_POLICY_ONLY=1" in docker_smoke
    assert "home-assistant-internal-desktop.png" in docker_smoke
    assert "home-assistant-internal-mobile.png" in docker_smoke
    assert "--probe-websocket ws://127.0.0.1:8099/api/websocket" in docker_smoke
    assert "Home Assistant browser gateway was reachable outside app loopback" in docker_smoke
    assert '"home_assistant_browser_token"' not in docker_smoke
    assert 'Antigravity Remote Control is waiting for ha-antigravity-remote-login.' in (
        docker_smoke
    )
    assert '.source == "managed"' in docker_smoke
    assert "/data/browser-auth/managed-user.json" in docker_smoke
    assert "/data/browser-auth/managed-token" in docker_smoke
