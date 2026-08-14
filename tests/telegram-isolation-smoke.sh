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
      ([.permissions.allow[] | select(startswith(\"read_file(\"))] == [
        \"read_file(/data/antigravity-ha/telegram-home/.gemini/config/plugins/home-assistant/skills/ha-change-proposal/SKILL.md)\",
        \"read_file(/data/antigravity-ha/telegram-home/.gemini/config/plugins/home-assistant/skills/ha-memory/SKILL.md)\",
        \"read_file(/data/antigravity-ha/telegram-home/.gemini/config/plugins/home-assistant/skills/home-assistant-operations/SKILL.md)\"
      ]) and
      (.permissions.allow | index(\"read_file(*)\") == null) and
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
        --output-format stream-json \
        --print-timeout 5s \
        --agent ha-telegram \
        --mode plan \
        --sandbox \
        --disable-slash-commands \
        >/dev/null 2>/dev/null
    negative_status=$?
    set -e

    [[ "${negative_status}" == 1 ]] \
      || { printf "first isolated unauthenticated worker returned status %s\n" \
        "${negative_status}" >&2; exit 1; }
    [[ ! -e /tmp/user-global-mcp-launched.isolated ]] \
      || { printf "isolated worker launched the interactive global MCP (status %s)\n" \
        "${negative_status}" >&2; exit 1; }
    [[ ! -e /tmp/workspace-mcp-launched.isolated ]] \
      || { printf "isolated worker launched the /config workspace MCP (status %s)\n" \
        "${negative_status}" >&2; exit 1; }
    [[ "$(sha256sum /data/home/.gemini/config/mcp_config.json)" \
      == "${user_mcp_before}" ]]

    telegram_settings=/data/antigravity-ha/telegram-home/.gemini/antigravity-cli/settings.json
    [[ ! -L "${telegram_settings}" ]]
    [[ "$(stat -c "%u:%h:%a" "${telegram_settings}")" == "0:1:600" ]]
    ! cmp -s /etc/antigravity/telegram-settings.json "${telegram_settings}"
    . /usr/local/lib/antigravity-ha/telegram-plugin.sh
    antigravity_ha_telegram_settings_match \
      /etc/antigravity/telegram-settings.json "${telegram_settings}"

    set +e
    printf "repeat canary\n" | \
      HOME=/data/antigravity-ha/telegram-home \
      AGY_CLI_DISABLE_AUTO_UPDATE=true \
      HA_TELEGRAM_USER_ID=123456789 \
      HA_TELEGRAM_CHAT_ID=-123456789 \
      timeout 12s /usr/local/libexec/ha-telegram-worker \
        --output-format stream-json \
        --print-timeout 5s \
        --agent ha-telegram \
        --mode plan \
        --sandbox \
        --disable-slash-commands \
        >/dev/null 2>/dev/null
    repeated_negative_status=$?
    set -e
    [[ "${repeated_negative_status}" == 1 ]] \
      || { printf "normalized settings rejected with status %s\n" \
        "${repeated_negative_status}" >&2; exit 1; }

    reject_settings_fixture() {
      local name=$1
      local fixture=$2
      local temporary status
      temporary=$(mktemp \
        /data/antigravity-ha/telegram-home/.gemini/antigravity-cli/.settings-tamper.XXXXXX)
      case "${fixture}" in
        __explicit_sorted__)
          jq --sort-keys . \
            /etc/antigravity/telegram-settings.json > "${temporary}"
          ;;
        __invalid_json__)
          printf "%s\n" "{\"altScreenMode\":" > "${temporary}"
          ;;
        *)
          jq "
            del(.toolPermission, .allowNonWorkspaceAccess, .permissions.ask)
            | ${fixture}
          " /etc/antigravity/telegram-settings.json > "${temporary}"
          ;;
      esac
      chmod 0600 "${temporary}"
      mv -f -- "${temporary}" "${telegram_settings}"
      set +e
      HOME=/data/antigravity-ha/telegram-home \
        AGY_CLI_DISABLE_AUTO_UPDATE=true \
        HA_TELEGRAM_USER_ID=123456789 \
        HA_TELEGRAM_CHAT_ID=-123456789 \
        /usr/local/libexec/ha-telegram-worker --version \
        >/dev/null 2>/dev/null
      status=$?
      set -e
      [[ "${status}" == 70 ]] \
        || { printf "worker accepted unsafe settings fixture %s (status %s)\n" \
          "${name}" "${status}" >&2; exit 1; }
    }

    reject_settings_fixture \
      "arbitrary explicit serialization" "__explicit_sorted__"
    reject_settings_fixture \
      "unsafe tool permission" ".toolPermission = \"always-proceed\""
    reject_settings_fixture \
      "unsafe workspace access" ".allowNonWorkspaceAccess = true"
    reject_settings_fixture \
      "nonempty review queue" ".permissions.ask = [\"command(*)\"]"
    reject_settings_fixture \
      "unknown customization" ".unexpectedCustomization = true"
    reject_settings_fixture \
      "missing policy" "del(.permissions.deny)"
    reject_settings_fixture \
      "missing managed setting" "del(.showTips)"
    reject_settings_fixture "invalid JSON" "__invalid_json__"

    /usr/local/libexec/ha-telegram-home-bootstrap --runtime
    printf "%s\n" \
      "{\"mcpServers\":{\"isolated_tamper_marker\":{\"command\":\"/usr/bin/node\",\"args\":[\"/tmp/telegram-isolation-marker.mjs\",\"/tmp/isolated-tamper-launched\"]}}}" \
      > /data/antigravity-ha/telegram-home/.gemini/config/mcp_config.json
    set +e
    printf "canary\n" | \
      HOME=/data/antigravity-ha/telegram-home \
      AGY_CLI_DISABLE_AUTO_UPDATE=true \
      HA_TELEGRAM_USER_ID=123456789 \
      HA_TELEGRAM_CHAT_ID=-123456789 \
      /usr/local/libexec/ha-telegram-worker \
        --output-format stream-json >/dev/null 2>/dev/null
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

docker run --rm --platform "$TEST_PLATFORM" --network none \
  --tmpfs /data:rw,nosuid,nodev,noexec,mode=0755 \
  --tmpfs /run:rw,nosuid,nodev,noexec,mode=0755 \
  --entrypoint /bin/bash "${IMAGE}" -ceu '
    /usr/local/libexec/ha-telegram-home-bootstrap --runtime

    settings_with_provider=$(mktemp)
    settings_home_temporary=$(mktemp \
      /data/antigravity-ha/telegram-home/.gemini/antigravity-cli/.settings.XXXXXX)
    jq ".modelProvider = \"gemini\"" \
      /etc/antigravity/telegram-settings.json > "${settings_with_provider}"
    install -m 0644 "${settings_with_provider}" \
      /etc/antigravity/telegram-settings.json
    install -m 0600 "${settings_with_provider}" \
      "${settings_home_temporary}"
    mv -f -- "${settings_home_temporary}" \
      /data/antigravity-ha/telegram-home/.gemini/antigravity-cli/settings.json

    mock_log=$(mktemp)
    native_stdout=$(mktemp)
    native_stderr=$(mktemp)
    mock_pid=
    cleanup_mock() {
      if [[ -n "${mock_pid}" ]] && kill -0 "${mock_pid}" 2>/dev/null; then
        kill "${mock_pid}" 2>/dev/null || true
        wait "${mock_pid}" 2>/dev/null || true
      fi
    }
    trap cleanup_mock EXIT

    /usr/bin/node - > "${mock_log}" 2>&1 <<\NODE &
const http = require("node:http");

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    if (request.method !== "POST") {
      sendJson(response, 200, {});
      return;
    }

    let flattened = "";
    try {
      flattened = JSON.stringify(JSON.parse(body));
    } catch {
      sendJson(response, 400, { error: "invalid synthetic request" });
      return;
    }
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    process.stdout.write(`${JSON.stringify({
      kind: "request",
      pathname,
      stdin_sentinel: flattened.includes("TELEGRAM_NATIVE_STDIN_SENTINEL"),
      output_format_literal: flattened.includes("--output-format"),
    })}\n`);

    if (pathname.includes("countTokens")) {
      sendJson(response, 200, { totalTokens: 1 });
      return;
    }
    const answer = JSON.stringify({
      response: "MOCK_RESPONSE_OK",
      proposal_ids: [],
    });
    const event = {
      candidates: [{
        content: { parts: [{ text: answer }], role: "model" },
        finishReason: "STOP",
        index: 0,
      }],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        totalTokenCount: 2,
      },
      modelVersion: "synthetic-model",
    };
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  });
});

server.listen(18787, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ kind: "ready" })}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
NODE
    mock_pid=$!

    for _ in $(seq 1 100); do
      grep -Fq "\"kind\":\"ready\"" "${mock_log}" && break
      kill -0 "${mock_pid}" 2>/dev/null \
        || { printf "synthetic Gemini endpoint stopped during startup\n" >&2; exit 1; }
      sleep 0.05
    done
    grep -Fq "\"kind\":\"ready\"" "${mock_log}"

    cd /usr/local/share/antigravity-ha/telegram-workspace
    printf "%s\n" "TELEGRAM_NATIVE_STDIN_SENTINEL" | /usr/bin/env -i \
      AGY_CLI_DISABLE_AUTO_UPDATE=true \
      GEMINI_API_KEY=synthetic-telegram-canary \
      GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:18787 \
      HOME=/data/antigravity-ha/telegram-home \
      HA_TELEGRAM_USER_ID=123456789 \
      HA_TELEGRAM_CHAT_ID=-123456789 \
      LANG=C.UTF-8 \
      LC_ALL=C.UTF-8 \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      TERM=dumb \
      NO_COLOR=1 \
      timeout 20s /usr/local/libexec/ha-telegram-worker \
        --output-format stream-json \
        --print-timeout 10s \
        --json-schema /usr/local/share/antigravity-ha/telegram-result-schema.json \
        --agent ha-telegram \
        --mode plan \
        --disable-slash-commands \
        --sandbox \
        > "${native_stdout}" 2> "${native_stderr}"

    kill "${mock_pid}" 2>/dev/null || true
    wait "${mock_pid}" 2>/dev/null || true
    mock_pid=
    [[ ! -s "${native_stderr}" ]]
    jq -s -e "
      length >= 2 and
      (.[0].event == \"init\") and
      (.[-1].event == \"result\") and
      (.[-1].result.status == \"SUCCESS\") and
      ([.[] | select(.event == \"init\")] | length == 1) and
      ([.[] | select(.event == \"result\")] | length == 1) and
      ([.[] | (.event | type)] | all(. == \"string\"))
    " "${native_stdout}" >/dev/null
    jq -s -e "
      ([.[] | select(.kind == \"request\")] | length) > 0 and
      any(.[]; .kind == \"request\" and .stdin_sentinel == true) and
      all(.[]; .kind != \"request\" or .output_format_literal == false)
    " "${mock_log}" >/dev/null
  ' || fail 'native 1.1.11 stdin stream-json canary failed'

printf 'telegram isolation smoke passed for Antigravity %s\n' \
  "${EXPECTED_VERSION}"
