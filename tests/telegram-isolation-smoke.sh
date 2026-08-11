#!/usr/bin/env bash
set -Eeuo pipefail

TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}
case "$TEST_PLATFORM" in
  linux/amd64) EXPECTED_HA_ARCH=amd64 ;;
  linux/arm64) EXPECTED_HA_ARCH=aarch64 ;;
  *) echo "unsupported TEST_PLATFORM: ${TEST_PLATFORM}" >&2; exit 64 ;;
esac
HA_ARCH=${HA_ARCH:-$EXPECTED_HA_ARCH}
[[ $HA_ARCH == "$EXPECTED_HA_ARCH" ]] || exit 64
export TEST_PLATFORM HA_ARCH

IMAGE=${1:-antigravity-for-home-assistant:test}
EXPECTED_VERSION=$(sed -n \
  's/^ARG ANTIGRAVITY_VERSION=//p' antigravity_home_assistant/Dockerfile)

fail() {
  printf 'telegram isolation smoke: %s\n' "$*" >&2
  exit 1
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
[[ "${EXPECTED_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail 'Dockerfile Antigravity version pin is invalid'

docker run --rm --platform "$TEST_PLATFORM" --network none \
  --env EXPECTED_VERSION="${EXPECTED_VERSION}" \
  --entrypoint /bin/bash "${IMAGE}" -ceu '
    [[ "$(/usr/local/libexec/antigravity-real --version)" == "${EXPECTED_VERSION}" ]]

    install -d -m 0700 \
      /data/home/.gemini/antigravity-cli \
      /data/home/.gemini/config/plugins \
      /data/antigravity-ha/telegram-home/.gemini/config/rules \
      /config/.agents
    cp -a /usr/local/share/antigravity-ha/plugins/home-assistant \
      /data/home/.gemini/config/plugins/home-assistant
    install -m 0600 /etc/antigravity/settings.json \
      /data/home/.gemini/antigravity-cli/settings.json

    printf "%s\n" \
      "import { writeFileSync } from \"node:fs\";" \
      "const surface = process.env.HOME === \"/data/home\" ? \"interactive\" : \"isolated\";" \
      "writeFileSync(process.argv[2] + \".\" + surface, \"launched\\n\", { mode: 0o600 });" \
      "process.stdin.resume();" \
      > /tmp/telegram-isolation-marker.mjs
    chmod 0600 /tmp/telegram-isolation-marker.mjs

    printf "%s\n" \
      "{\"mcpServers\":{\"user_global_marker\":{\"command\":\"/usr/bin/node\",\"args\":[\"/tmp/telegram-isolation-marker.mjs\",\"/tmp/user-global-mcp-launched\"]}}}" \
      > /data/home/.gemini/config/mcp_config.json
    printf "%s\n" \
      "{\"mcpServers\":{\"workspace_marker\":{\"command\":\"/usr/bin/node\",\"args\":[\"/tmp/telegram-isolation-marker.mjs\",\"/tmp/workspace-mcp-launched\"]}}}" \
      > /config/.agents/mcp_config.json
    user_mcp_before=$(sha256sum /data/home/.gemini/config/mcp_config.json)
    printf "%s\n" "# stale global Telegram rule canary" \
      > /data/antigravity-ha/telegram-home/.gemini/config/rules/canary.md

    /usr/local/libexec/ha-telegram-home-bootstrap --runtime
    cmp -s /etc/antigravity/telegram-settings.json \
      /data/antigravity-ha/telegram-home/.gemini/antigravity-cli/settings.json
    jq -e "
      .toolPermission == \"request-review\" and
      .allowNonWorkspaceAccess == false and
      (.permissions.ask | length == 0) and
      (.permissions.allow | index(\"mcp(ha_change/ha_change_propose)\") != null) and
      (.permissions.allow | index(\"mcp(ha_read/ha_read_registry)\") != null) and
      (.permissions.allow | index(\"mcp(ha_validate/ha_validate_config)\") != null) and
      (.permissions.deny | index(\"command(*)\") != null) and
      (.permissions.deny | index(\"mcp(playwright/browser_click)\") != null)
    " /data/antigravity-ha/telegram-home/.gemini/antigravity-cli/settings.json \
      >/dev/null
    cmp -s /etc/antigravity/mcp_config.json \
      /data/antigravity-ha/telegram-home/.gemini/config/mcp_config.json
    jq -e "
      (.mcpServers | keys) == [
        \"ha_change\",
        \"ha_memory\",
        \"ha_read\",
        \"ha_validate\",
        \"playwright\"
      ] and
      ([.mcpServers[].cwd] | all(
        . == \"/usr/local/share/antigravity-ha/telegram-workspace\"
      ))
    " /data/antigravity-ha/telegram-home/.gemini/config/plugins/home-assistant/mcp_config.json \
      >/dev/null
    [[ ! -e /data/antigravity-ha/telegram-home/.gemini/config/rules ]]

    cp /usr/local/libexec/antigravity-real /tmp/antigravity-real.settings-canary
    printf "%s\n" \
      "#!/bin/bash -p" \
      "set -Eeuo pipefail" \
      "if [[ \"\${1:-}\" == agent ]]; then" \
      "  /tmp/antigravity-real.settings-canary \"\$@\"" \
      "  settings=/data/antigravity-ha/telegram-home/.gemini/antigravity-cli/settings.json" \
      "  jq \".showTips = true\" \"\${settings}\" > \"\${settings}.canary\"" \
      "  chmod 0600 \"\${settings}.canary\"" \
      "  mv -f \"\${settings}.canary\" \"\${settings}\"" \
      "  exit 0" \
      "fi" \
      "exec /tmp/antigravity-real.settings-canary \"\$@\"" \
      > /usr/local/libexec/antigravity-real
    chmod 0755 /usr/local/libexec/antigravity-real
    set +e
    /usr/local/libexec/ha-telegram-home-bootstrap --runtime \
      >/tmp/settings-canary.out 2>/tmp/settings-canary.err
    settings_canary_status=$?
    set -e
    [[ "${settings_canary_status}" == 1 ]]
    grep -Fq "managed customization changed during validation" \
      /tmp/settings-canary.err
    install -m 0755 /tmp/antigravity-real.settings-canary \
      /usr/local/libexec/antigravity-real
    /usr/local/libexec/ha-telegram-home-bootstrap --runtime
    cmp -s /etc/antigravity/telegram-settings.json \
      /data/antigravity-ha/telegram-home/.gemini/antigravity-cli/settings.json

    install -d -m 0700 \
      /data/antigravity-ha/telegram-home/.native-auth-backend-unknown
    printf "preserve-without-path-inference\n" \
      > /data/antigravity-ha/telegram-home/.native-auth-backend-unknown/sentinel
    /usr/local/libexec/ha-telegram-home-bootstrap --login
    [[ -f /data/antigravity-ha/telegram-home/.native-auth-backend-unknown/sentinel ]]
    [[ ! -e /data/antigravity-ha/telegram-home/.gemini/config/plugins/home-assistant ]]
    /usr/local/libexec/ha-telegram-home-bootstrap --runtime
    [[ -f /data/antigravity-ha/telegram-home/.native-auth-backend-unknown/sentinel ]]
    [[ -d /data/antigravity-ha/telegram-home/.gemini/config/plugins/home-assistant ]]

    cd /usr/local/share/antigravity-ha/telegram-workspace
    HOME=/data/home AGY_CLI_DISABLE_AUTO_UPDATE=true \
      /usr/local/libexec/antigravity-real agent </dev/null \
      | grep -Fxq ha-telegram
    set +e
    printf "canary\n" | HOME=/data/home AGY_CLI_DISABLE_AUTO_UPDATE=true \
      timeout 12s /usr/local/libexec/antigravity-real \
        --print \
        --output-format stream-json \
        --print-timeout 5s \
        --agent ha-telegram \
        --mode plan \
        --sandbox \
        --disable-slash-commands \
        >/dev/null 2>/dev/null
    positive_status=$?
    set -e
    for _ in $(seq 1 50); do
      [[ -f /tmp/user-global-mcp-launched.interactive ]] && break
      sleep 0.1
    done
    [[ -f /tmp/user-global-mcp-launched.interactive ]] \
      || { printf "positive control did not launch the user global MCP (status %s)\n" \
        "${positive_status}" >&2; exit 1; }

    set +e
    printf "canary\n" | \
      HOME=/data/antigravity-ha/telegram-home \
      AGY_CLI_DISABLE_AUTO_UPDATE=true \
      HA_TELEGRAM_USER_ID=123456789 \
      HA_TELEGRAM_CHAT_ID=-123456789 \
      timeout 12s /usr/local/libexec/ha-telegram-worker \
        --print \
        --output-format stream-json \
        --print-timeout 5s \
        --agent ha-telegram \
        --mode plan \
        --sandbox \
        --disable-slash-commands \
        >/dev/null 2>/dev/null
    negative_status=$?
    set -e

    [[ ! -e /tmp/user-global-mcp-launched.isolated ]] \
      || { printf "isolated worker launched the interactive global MCP (status %s)\n" \
        "${negative_status}" >&2; exit 1; }
    [[ ! -e /tmp/workspace-mcp-launched.isolated ]] \
      || { printf "isolated worker launched the /config workspace MCP (status %s)\n" \
        "${negative_status}" >&2; exit 1; }
    [[ "$(sha256sum /data/home/.gemini/config/mcp_config.json)" \
      == "${user_mcp_before}" ]]

    printf "%s\n" \
      "{\"mcpServers\":{\"isolated_tamper_marker\":{\"command\":\"/usr/bin/node\",\"args\":[\"/tmp/telegram-isolation-marker.mjs\",\"/tmp/isolated-tamper-launched\"]}}}" \
      > /data/antigravity-ha/telegram-home/.gemini/config/mcp_config.json
    set +e
    printf "canary\n" | \
      HOME=/data/antigravity-ha/telegram-home \
      AGY_CLI_DISABLE_AUTO_UPDATE=true \
      HA_TELEGRAM_USER_ID=123456789 \
      HA_TELEGRAM_CHAT_ID=-123456789 \
      /usr/local/libexec/ha-telegram-worker --print >/dev/null 2>/dev/null
    tamper_status=$?
    set -e
    [[ "${tamper_status}" == 70 ]]
    [[ ! -e /tmp/isolated-tamper-launched.isolated ]]

    /usr/local/libexec/ha-telegram-home-bootstrap --runtime
    install -d -m 0700 \
      /data/antigravity-ha/telegram-home/.gemini/config/rules
    printf "%s\n" "# runtime global Telegram rule tamper canary" \
      > /data/antigravity-ha/telegram-home/.gemini/config/rules/canary.md
    set +e
    HOME=/data/antigravity-ha/telegram-home \
      AGY_CLI_DISABLE_AUTO_UPDATE=true \
      HA_TELEGRAM_USER_ID=123456789 \
      HA_TELEGRAM_CHAT_ID=-123456789 \
      /usr/local/libexec/ha-telegram-worker --version >/dev/null 2>/dev/null
    rule_tamper_status=$?
    set -e
    [[ "${rule_tamper_status}" == 70 ]] \
      || { printf "isolated worker accepted a global rules directory (status %s)\n" \
        "${rule_tamper_status}" >&2; exit 1; }
  ' || fail 'native 1.1.11 HOME/workspace isolation canary failed'

printf 'telegram isolation smoke passed for Antigravity %s\n' \
  "${EXPECTED_VERSION}"
