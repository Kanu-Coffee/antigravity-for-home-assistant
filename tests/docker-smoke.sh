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
TEST_ID="antigravity-ha-smoke-${RANDOM}-$$"
PUBLIC_CONTAINER="${TEST_ID}-public"
DEGRADED_CONTAINER="${TEST_ID}-degraded"
GATEWAY_FIXTURE="${TEST_ID}-gateway-fixture"
IP_REUSE_CONTAINER="${TEST_ID}-ip-reuse"
GATEWAY_NETWORK="${TEST_ID}-gateway-network"
PUBLIC_DATA="${TEST_ID}-public-data"
PUBLIC_CONFIG="${TEST_ID}-public-config"
DEGRADED_DATA="${TEST_ID}-degraded-data"
DEGRADED_CONFIG="${TEST_ID}-degraded-config"
WORK_DIR=$(mktemp -d)
SUPERVISOR_TOKEN=smoke-supervisor-token-do-not-use
BROWSER_TOKEN=smoke-browser-token-read-only-do-not-use
MANAGED_OPERATION_ID=gatewaySmokeManagedOperation0001
GATEWAY_MARKER='HA_BROWSER_GATEWAY_AUTHENTICATED:antigravity HA fixture'

# Git Bash rewrites Linux container paths before invoking native Windows programs.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN=python3
else
  PYTHON_BIN=python
fi

cleanup() {
  docker rm -f \
    "${PUBLIC_CONTAINER}" \
    "${DEGRADED_CONTAINER}" \
    "${IP_REUSE_CONTAINER}" \
    "${GATEWAY_FIXTURE}" >/dev/null 2>&1 || true
  docker volume rm -f \
    "${PUBLIC_DATA}" \
    "${PUBLIC_CONFIG}" \
    "${DEGRADED_DATA}" \
    "${DEGRADED_CONFIG}" >/dev/null 2>&1 || true
  docker network rm "${GATEWAY_NETWORK}" >/dev/null 2>&1 || true
  rm -rf -- "${WORK_DIR}"
}
trap cleanup EXIT

fail() {
  printf 'docker smoke: %s\n' "$*" >&2
  for container in \
    "${PUBLIC_CONTAINER}" \
    "${DEGRADED_CONTAINER}" \
    "${GATEWAY_FIXTURE}"; do
    docker logs "${container}" 2>/dev/null \
      | sed \
        -e "s/${SUPERVISOR_TOKEN}/[REDACTED_HOME_ASSISTANT_TOKEN]/g" \
        -e "s/${BROWSER_TOKEN}/[REDACTED_HOME_ASSISTANT_TOKEN]/g" \
      || true
  done
  exit 1
}

wait_for_log() {
  local container=$1
  local pattern=$2
  local _
  for _ in $(seq 1 60); do
    if docker logs "${container}" 2>&1 | grep -Fq "${pattern}"; then
      return 0
    fi
    if [[ $(docker inspect --format '{{.State.Running}}' "${container}") != true ]]; then
      fail "${container} exited before logging: ${pattern}"
    fi
    sleep 1
  done
  fail "timed out waiting for ${container} log: ${pattern}"
}

wait_for_process() {
  local container=$1
  local pattern=$2
  local _
  for _ in $(seq 1 30); do
    if docker exec "${container}" pgrep -f "${pattern}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "timed out waiting for ${container} process: ${pattern}"
}

seed_options() {
  local volume=$1
  local options_json=$2
  printf '%s' "${options_json}" | docker run --rm --interactive \
    --platform "$TEST_PLATFORM" \
    --entrypoint /bin/sh \
    --volume "${volume}:/data" \
    "${IMAGE}" \
    -c 'umask 077; cat > /data/options.json'
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 || fail "image not found: ${IMAGE}"
tests/telegram-isolation-smoke.sh "${IMAGE}" \
  || fail 'Telegram native HOME isolation smoke failed'
PINNED_ANTIGRAVITY_VERSION=$(sed -n \
  's/^ARG ANTIGRAVITY_VERSION=//p' antigravity_home_assistant/Dockerfile)
[[ "${PINNED_ANTIGRAVITY_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail 'Dockerfile Antigravity version pin is invalid'
[[ $(docker run --rm --platform "$TEST_PLATFORM" \
  --entrypoint /usr/local/libexec/antigravity-real "${IMAGE}" --version) \
  == "${PINNED_ANTIGRAVITY_VERSION}" ]] \
  || fail 'candidate image does not contain the pinned Antigravity version'
docker run --rm --platform "$TEST_PLATFORM" --network none \
  --entrypoint /bin/bash "${IMAGE}" -ceu '
    [[ "${AGY_CLI_DISABLE_AUTO_UPDATE:-}" == true ]]
    install -d -m 0700 /tmp/agy-update-home /tmp/agy-update-workspace
    before=$(sha512sum /usr/local/libexec/antigravity-real)
    cd /tmp/agy-update-workspace
    HOME=/tmp/agy-update-home \
      /usr/local/libexec/antigravity-real agent </dev/null >/dev/null
    after=$(sha512sum /usr/local/libexec/antigravity-real)
    [[ "${before}" == "${after}" ]]
    grep -R -Fq "Auto-update disabled via environment variable AGY_CLI_DISABLE_AUTO_UPDATE" \
      /tmp/agy-update-home/.gemini/antigravity-cli/log
    if grep -R -Fq "Spawned background update process" \
      /tmp/agy-update-home/.gemini/antigravity-cli/log; then
      exit 1
    fi
  ' || fail 'native Antigravity self-updater was not disabled reproducibly'
[[ $(docker run --rm --platform "$TEST_PLATFORM" --entrypoint stat "${IMAGE}" \
  -c '%a:%U:%G' /etc/antigravity/settings.json) == 644:root:root ]] \
  || fail 'image default Antigravity settings have unexpected ownership or mode'
docker run --rm --platform "$TEST_PLATFORM" \
  --entrypoint /usr/local/libexec/antigravity-real "${IMAGE}" \
  plugin validate /usr/local/share/antigravity-ha/plugins/home-assistant >/dev/null \
  || fail 'image-managed Home Assistant plugin failed Antigravity validation'
ANTIGRAVITY_HELP=$(docker run --rm --platform "$TEST_PLATFORM" \
  --entrypoint /usr/local/libexec/antigravity-real "${IMAGE}" --help 2>&1)
for help_literal in \
  '--print' \
  '--output-format' \
  'stream-json' \
  '--json-schema' \
  '--agent' \
  '--mode' \
  '--conversation' \
  '--disable-slash-commands' \
  '--sandbox' \
  'Short alias for --continue'; do
  grep -Fq -- "${help_literal}" <<< "${ANTIGRAVITY_HELP}" \
    || fail "Antigravity help is missing ${help_literal}"
done
if grep -Eq '^  (debug|mcp)[[:space:]]' <<< "${ANTIGRAVITY_HELP}"; then
  fail 'Antigravity exposed an unsupported debug or mcp subcommand'
fi
unset ANTIGRAVITY_HELP help_literal
for rejected_flag in \
  --dangerously-skip-permissions \
  --dangerously-skip-permissions=true \
  -dangerously-skip-permissions \
  -dangerously-skip-permissions=true \
  --sandbox=false \
  -sandbox=false \
  --sandbox=TRUE \
  -sandbox=1; do
  if docker run --rm --platform "$TEST_PLATFORM" \
    --entrypoint /usr/local/bin/antigravity "${IMAGE}" \
    "${rejected_flag}" --help >/dev/null 2>&1; then
    fail "Antigravity wrapper accepted unsafe flag ${rejected_flag}"
  fi
done
for safe_sandbox_flag in \
  --sandbox \
  -sandbox \
  --sandbox=true \
  -sandbox=true; do
  docker run --rm --platform "$TEST_PLATFORM" \
    --entrypoint /usr/local/bin/antigravity "${IMAGE}" \
    "${safe_sandbox_flag}" --help >/dev/null 2>&1 \
    || fail "Antigravity wrapper rejected safe flag ${safe_sandbox_flag}"
done
unset rejected_flag safe_sandbox_flag

for volume in \
  "${PUBLIC_DATA}" \
  "${PUBLIC_CONFIG}" \
  "${DEGRADED_DATA}" \
  "${DEGRADED_CONFIG}"; do
  docker volume create "${volume}" >/dev/null
done

GATEWAY_SUBNET=''
for (( attempt = 0; attempt < 32; attempt += 1 )); do
  if (( attempt == 0 )); then
    candidate_subnet='10.253.214.0/24'
  else
    candidate_subnet="10.253.$((1 + RANDOM % 254)).0/24"
  fi
  if docker network create \
    --subnet "${candidate_subnet}" \
    "${GATEWAY_NETWORK}" >/dev/null 2>&1; then
    GATEWAY_SUBNET=${candidate_subnet}
    break
  fi
done
[[ -n "${GATEWAY_SUBNET}" ]] \
  || fail 'Unable to allocate a user-configured private subnet for IP reuse testing'
docker create \
  --platform "$TEST_PLATFORM" \
  --name "${GATEWAY_FIXTURE}" \
  --network "${GATEWAY_NETWORK}" \
  --network-alias supervisor \
  --network-alias homeassistant \
  --env GATEWAY_FIXTURE_TOKEN="${SUPERVISOR_TOKEN}" \
  --env GATEWAY_FIXTURE_BROWSER_TOKEN="${BROWSER_TOKEN}" \
  --env GATEWAY_FIXTURE_OPERATION_ID="${MANAGED_OPERATION_ID}" \
  --entrypoint node \
  "${IMAGE}" \
  /tmp/ha_browser_gateway_fixture.mjs >/dev/null
docker cp tests/ha_browser_gateway_fixture.mjs \
  "${GATEWAY_FIXTURE}:/tmp/ha_browser_gateway_fixture.mjs"
docker start "${GATEWAY_FIXTURE}" >/dev/null
wait_for_log "${GATEWAY_FIXTURE}" 'Home Assistant browser gateway fixture ready'

ssh-keygen -q -t ed25519 -N '' -f "${WORK_DIR}/client_key"
PUBLIC_KEY=$(< "${WORK_DIR}/client_key.pub")
PUBLIC_OPTIONS=$("${PYTHON_BIN}" -c '
import json, sys
print(json.dumps({
    "authorized_keys": [sys.argv[1]],
    "web_terminal_auto_start_antigravity": False,
    "tmux_session_name": "antigravity-ha-smoke",
    "antigravity_tool_permission": "request-review",
    "antigravity_terminal_sandbox": True,
    "home_assistant_browser_auto_auth": True,
    "log_level": "info",
}))
' "${PUBLIC_KEY}")
MANAGED_STATE=$("${PYTHON_BIN}" -c '
import json, sys
operation_id = sys.argv[1]
print(json.dumps({
    "version": 1,
    "operation_id": operation_id,
    "display_name": "antigravity Browser (managed) " + operation_id[:16],
    "client_name": "Antigravity for Home Assistant browser " + operation_id,
    "phase": "ready",
    "user_id": "antigravity-browser-read-only-user",
}))
' "${MANAGED_OPERATION_ID}")
DEGRADED_OPTIONS='{"authorized_keys":["ssh-ed25519 AAAA invalid-fixture"],"web_terminal_auto_start_antigravity":false,"tmux_session_name":"antigravity-ha-degraded","antigravity_tool_permission":"request-review","antigravity_terminal_sandbox":true,"log_level":"info"}'

seed_options "${PUBLIC_DATA}" "${PUBLIC_OPTIONS}"
seed_options "${DEGRADED_DATA}" "${DEGRADED_OPTIONS}"
printf '%s\n%s\n' "${MANAGED_STATE}" "${BROWSER_TOKEN}" \
  | docker run --rm --interactive \
  --platform "$TEST_PLATFORM" \
  --entrypoint /bin/sh \
  --volume "${PUBLIC_DATA}:/data" \
  "${IMAGE}" -ceu '
    install -d -m 0700 /data/browser-auth
    IFS= read -r fixture_state
    IFS= read -r fixture_token
    printf "%s\n" "${fixture_state}" > /data/browser-auth/managed-user.json
    printf "%s" "${fixture_token}" > /data/browser-auth/managed-token
    chmod 0600 \
      /data/browser-auth/managed-user.json \
      /data/browser-auth/managed-token
  '
docker run --rm \
  --platform "$TEST_PLATFORM" \
  --entrypoint /bin/sh \
  --volume "${DEGRADED_DATA}:/data" \
  "${IMAGE}" \
  -c 'mkdir -p /data/ssh /data/antigravity && : > /data/ssh/ssh_host_ed25519_key && printf "%s\n" "# user override" > /data/antigravity/AGENTS.override.md && chmod 0600 /data/antigravity/AGENTS.override.md'

docker run --detach \
  --platform "$TEST_PLATFORM" \
  --name "${PUBLIC_CONTAINER}" \
  --network "${GATEWAY_NETWORK}" \
  --env SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}" \
  --publish 127.0.0.1::22 \
  --publish 127.0.0.1::17682 \
  --volume "${PUBLIC_DATA}:/data" \
  --volume "${PUBLIC_CONFIG}:/config" \
  "${IMAGE}" >/dev/null

wait_for_log "${PUBLIC_CONTAINER}" 'antigravity runtime ready:'
wait_for_log "${GATEWAY_FIXTURE}" \
  'Gateway fixture accepted authenticated /core/info'
wait_for_log "${GATEWAY_FIXTURE}" \
  'Core WebSocket fixture accepted browser auth/current_user'
wait_for_log "${GATEWAY_FIXTURE}" \
  'Supervisor WebSocket fixture accepted Supervisor config/auth/list'
wait_for_process "${PUBLIC_CONTAINER}" '/usr/sbin/sshd'
wait_for_process "${PUBLIC_CONTAINER}" 'ttyd'
wait_for_process "${PUBLIC_CONTAINER}" 'nginx'

docker exec "${PUBLIC_CONTAINER}" /bin/sh -c '
  ha-browser-auth-status | jq --exit-status '\''
    .status == "ready"
    and .source == "managed"
    and .user.group_ids == ["system-read-only"]
    and .user.local_only == true
    and .user.is_admin == false
  '\'' >/dev/null
' || fail 'Dedicated Home Assistant browser user validation was not ready'
docker exec "${PUBLIC_CONTAINER}" test -f /data/browser-auth/managed-user.json \
  || fail 'managed browser user state was not preserved'
docker exec "${PUBLIC_CONTAINER}" test -f /data/browser-auth/managed-token \
  || fail 'managed browser token was not preserved'
docker exec "${PUBLIC_CONTAINER}" /bin/bash -c '
  set -Eeuo pipefail
  export HOME=/data/home
  /usr/local/libexec/antigravity-real agent | grep -Fxq ha-telegram
  grep -Fq "http://127.0.0.1:8099/" \
    /data/home/.gemini/config/plugins/home-assistant/skills/ha-dashboard/SKILL.md
  grep -Fq memory_search \
    /data/home/.gemini/config/plugins/home-assistant/skills/ha-memory/SKILL.md
  grep -Fq memory_verify_change \
    /data/home/.gemini/config/plugins/home-assistant/skills/ha-memory/SKILL.md
' || fail 'Antigravity did not discover the image-managed Home Assistant agent and skills'

NETWORK_INFO=$(docker exec "${PUBLIC_CONTAINER}" ha-browser-network-info) \
  || fail 'Home Assistant browser network diagnostics failed'
PUBLIC_APP_IP=$(docker inspect --format \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  "${PUBLIC_CONTAINER}")
SOCKET_SOURCE_IP=$("${PYTHON_BIN}" -c \
  'import json, sys; print(json.load(sys.stdin)["socket_source_ip"])' \
  <<< "${NETWORK_INFO}")
SUPERVISOR_REPORTED_IP=$("${PYTHON_BIN}" -c \
  'import json, sys; print(json.load(sys.stdin)["supervisor_reported_app_ip"])' \
  <<< "${NETWORK_INFO}")
NETWORK_POLICY=$("${PYTHON_BIN}" -c \
  'import json, sys; value=json.load(sys.stdin); print(str(value["safe_for_persistent_trusted_networks"]).lower())' \
  <<< "${NETWORK_INFO}")
[[ -n "${PUBLIC_APP_IP}" && "${PUBLIC_APP_IP}" == "${SOCKET_SOURCE_IP}" ]] \
  || fail "Docker App IP ${PUBLIC_APP_IP} did not match socket source ${SOCKET_SOURCE_IP}"
[[ "${PUBLIC_APP_IP}" == "${SUPERVISOR_REPORTED_IP}" ]] \
  || fail "Supervisor-reported App IP ${SUPERVISOR_REPORTED_IP} did not match ${PUBLIC_APP_IP}"
[[ "${NETWORK_POLICY}" == false ]] \
  || fail 'Dynamic App address was incorrectly declared safe for persistent trusted_networks'
wait_for_log "${GATEWAY_FIXTURE}" \
  "Core fixture observed /auth/providers from ${PUBLIC_APP_IP}"

CORE_CONFIG=$(docker exec "${PUBLIC_CONTAINER}" curl \
  --fail \
  --silent \
  --show-error \
  --header "Authorization: Bearer ${BROWSER_TOKEN}" \
  http://homeassistant:8123/api/config) \
  || fail 'Dedicated browser token could not call Core /api/config directly'
CORE_OBSERVED_IP=$("${PYTHON_BIN}" -c \
  'import json, sys; print(json.load(sys.stdin)["request_source_ip"])' \
  <<< "${CORE_CONFIG}")
[[ "${CORE_OBSERVED_IP}" == "${PUBLIC_APP_IP}" ]] \
  || fail "Core observed ${CORE_OBSERVED_IP}, expected App IP ${PUBLIC_APP_IP}"
if docker exec "${PUBLIC_CONTAINER}" curl \
  --fail \
  --silent \
  --output /dev/null \
  --header "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
  http://homeassistant:8123/api/config; then
  fail 'Supervisor token unexpectedly authorized a direct Core browser request'
fi

docker exec "${PUBLIC_CONTAINER}" /bin/sh -c '
  jq --exit-status '\''
    .mcpServers.playwright.command == "/usr/local/bin/ha-playwright-mcp"
    and .mcpServers.playwright.cwd == "/config"
    and .mcpServers.playwright.args == []
    and .mcpServers.ha_memory.command == "/usr/local/bin/ha-memory-mcp"
    and .mcpServers.ha_memory.args == []
    and .mcpServers.ha_read.command == "/usr/local/bin/ha-read-mcp"
    and .mcpServers.ha_read.args == []
    and .mcpServers.ha_validate.command == "/usr/local/bin/ha-validate-mcp"
    and .mcpServers.ha_validate.args == []
    and .mcpServers.ha_change.command == "/usr/local/bin/ha-change-proposal-mcp"
    and .mcpServers.ha_change.args == []
  '\'' /data/home/.gemini/config/plugins/home-assistant/mcp_config.json >/dev/null
' || fail 'antigravity did not discover every image-managed Home Assistant stdio MCP'
if docker exec "${PUBLIC_CONTAINER}" \
  /usr/local/bin/ha-playwright-mcp --port 8931 >/dev/null 2>&1; then
  fail 'Playwright wrapper accepted a transport-changing command-line argument'
fi

docker cp tests/playwright_mcp_smoke.mjs \
  "${PUBLIC_CONTAINER}:/tmp/playwright_mcp_smoke.mjs"
docker cp tests/ha_browser_gateway_fixture.mjs \
  "${PUBLIC_CONTAINER}:/tmp/ha_browser_gateway_fixture.mjs"
MCP_OUTPUT_FILE="${WORK_DIR}/playwright-mcp-smoke.log"
if ! docker exec \
  --workdir /config \
  --env PLAYWRIGHT_MCP_SMOKE_URL=http://127.0.0.1:8099/ \
  --env PLAYWRIGHT_MCP_SMOKE_EXPECT_TEXT="${GATEWAY_MARKER}" \
  --env PLAYWRIGHT_MCP_SMOKE_EXPECT_SOURCE_IP="${PUBLIC_APP_IP}" \
  --env PLAYWRIGHT_MCP_SMOKE_SCREENSHOT_DIR=/tmp/antigravity-ha-browser-evidence \
  --env PLAYWRIGHT_MCP_SMOKE_CHILD_ENV='{"NODE_OPTIONS":"--require=/tmp/antigravity-ha-missing-node-options.cjs","NODE_PATH":"/tmp/antigravity-ha-node-path","PLAYWRIGHT_MCP_INIT_PAGE":"/tmp/antigravity-ha-missing-init-page.mjs","PLAYWRIGHT_MCP_SECRETS_FILE":"/tmp/antigravity-ha-missing-secrets.env","PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS":"true"}' \
  "${PUBLIC_CONTAINER}" \
  node /tmp/playwright_mcp_smoke.mjs \
    /usr/bin/env -i \
    HOME=/run/antigravity-ha/playwright-home \
    LANG=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    /usr/local/bin/ha-playwright-mcp \
  > "${MCP_OUTPUT_FILE}" 2>&1; then
  fail 'Playwright MCP browser smoke failed'
fi
if grep -Fq -- "${SUPERVISOR_TOKEN}" "${MCP_OUTPUT_FILE}" || \
  grep -Fq -- "${BROWSER_TOKEN}" "${MCP_OUTPUT_FILE}"; then
  fail 'Playwright MCP output disclosed a Home Assistant credential'
fi
cat "${MCP_OUTPUT_FILE}"
TELEGRAM_MCP_POLICY_OUTPUT_FILE="${WORK_DIR}/playwright-mcp-telegram-policy.log"
if ! docker exec \
  --workdir /config \
  --env HA_TELEGRAM_USER_ID=123456789 \
  --env HA_TELEGRAM_CHAT_ID=-100123456789 \
  --env PLAYWRIGHT_MCP_SMOKE_EXPECT_TELEGRAM_READ_ONLY=1 \
  --env PLAYWRIGHT_MCP_SMOKE_POLICY_ONLY=1 \
  --env PLAYWRIGHT_MCP_SMOKE_TELEGRAM_REDIRECT_URL=http://127.0.0.1:8099/security/redirect-outside \
  "${PUBLIC_CONTAINER}" \
  node /tmp/playwright_mcp_smoke.mjs /usr/local/bin/ha-playwright-mcp \
  > "${TELEGRAM_MCP_POLICY_OUTPUT_FILE}" 2>&1; then
  fail 'Telegram Playwright MCP read-only policy smoke failed'
fi
if grep -Fq -- "${SUPERVISOR_TOKEN}" "${TELEGRAM_MCP_POLICY_OUTPUT_FILE}" || \
  grep -Fq -- "${BROWSER_TOKEN}" "${TELEGRAM_MCP_POLICY_OUTPUT_FILE}"; then
  fail 'Telegram Playwright policy output disclosed a Home Assistant credential'
fi
cat "${TELEGRAM_MCP_POLICY_OUTPUT_FILE}"
for screenshot in \
  home-assistant-internal-desktop.png \
  home-assistant-internal-mobile.png; do
  docker exec "${PUBLIC_CONTAINER}" test -s \
    "/tmp/antigravity-ha-browser-evidence/${screenshot}" \
    || fail "Internal Home Assistant screenshot was not captured: ${screenshot}"
done
if [[ -n "${antigravity_HA_SMOKE_ARTIFACT_DIR:-}" ]]; then
  mkdir -p "${antigravity_HA_SMOKE_ARTIFACT_DIR}"
  for screenshot in \
    home-assistant-internal-desktop.png \
    home-assistant-internal-mobile.png; do
    docker exec "${PUBLIC_CONTAINER}" base64 \
      "/tmp/antigravity-ha-browser-evidence/${screenshot}" \
      | base64 --decode \
      > "${antigravity_HA_SMOKE_ARTIFACT_DIR}/${screenshot}"
  done
fi
wait_for_log "${GATEWAY_FIXTURE}" \
  "Core fixture accepted browser /api/config from ${PUBLIC_APP_IP}"
docker exec "${PUBLIC_CONTAINER}" \
  node /tmp/ha_browser_gateway_fixture.mjs \
  --probe-websocket ws://127.0.0.1:8099/api/websocket "${BROWSER_TOKEN}" \
  || fail 'Home Assistant gateway authenticated Core WebSocket failed'
wait_for_log "${GATEWAY_FIXTURE}" \
  'Core WebSocket fixture accepted browser auth/current_user'
docker exec "${GATEWAY_FIXTURE}" curl \
  --silent \
  --connect-timeout 1 \
  --max-time 2 \
  "http://${PUBLIC_CONTAINER}:7681/" >/dev/null \
  || fail 'Gateway fixture could not reach the app container network address'
if docker exec "${GATEWAY_FIXTURE}" curl \
  --silent \
  --connect-timeout 1 \
  --max-time 2 \
  "http://${PUBLIC_CONTAINER}:8099/" >/dev/null 2>&1; then
  fail 'Home Assistant browser gateway was reachable outside app loopback'
fi

docker exec --detach "${PUBLIC_CONTAINER}" \
  ttyd \
  --interface 0.0.0.0 \
  --port 17682 \
  --writable \
  --debug 1 \
  /usr/local/bin/web-terminal-entrypoint
wait_for_process "${PUBLIC_CONTAINER}" 'ttyd.*--port 17682'
TTYD_PORT=$(docker port "${PUBLIC_CONTAINER}" 17682/tcp | head -n1 | sed 's/.*://')
"${PYTHON_BIN}" tests/ttyd_websocket_smoke.py \
  "ws://127.0.0.1:${TTYD_PORT}/ws" \
  || fail 'ttyd WebSocket shell did not stay connected'

EXPECTED_APP_VERSION=$(docker image inspect \
  --format '{{index .Config.Labels "io.hass.version"}}' "${IMAGE}")
APP_VERSION=$(sed -n 's/^version: "\([^"]*\)"/\1/p' antigravity_home_assistant/config.yaml)
[[ -n "${APP_VERSION}" && "${EXPECTED_APP_VERSION}" == "${APP_VERSION}" ]] \
  || fail "image label version ${EXPECTED_APP_VERSION} does not match App version ${APP_VERSION}"
antigravity_OUTPUT=$(docker exec "${PUBLIC_CONTAINER}" antigravity --version)
[[ "${antigravity_OUTPUT}" == "${PINNED_ANTIGRAVITY_VERSION}" ]] \
  || fail "unexpected antigravity version output: ${antigravity_OUTPUT} (App ${EXPECTED_APP_VERSION})"

docker exec "${PUBLIC_CONTAINER}" sshd -t -f /etc/ssh/sshd_config
docker exec "${PUBLIC_CONTAINER}" nginx -t -c /etc/nginx/nginx.conf
docker exec "${PUBLIC_CONTAINER}" test -w /config
docker exec "${PUBLIC_CONTAINER}" test ! -e /run/antigravity-ha/ssh-disabled

docker exec "${PUBLIC_CONTAINER}" env TMUX_TMPDIR=/data/tmux \
  tmux -L smoke-false new-session -d -s smoke-false -c /config \
  /usr/local/bin/tmux-session-shell
[[ $(docker exec "${PUBLIC_CONTAINER}" env TMUX_TMPDIR=/data/tmux \
  tmux -L smoke-false display-message -p -t smoke-false:0.0 \
  '#{pane_current_path}:#{pane_current_command}') == '/config:bash' ]]
docker exec "${PUBLIC_CONTAINER}" test ! -e /tmp/antigravity-auto-started
docker exec "${PUBLIC_CONTAINER}" env TMUX_TMPDIR=/data/tmux \
  tmux -L smoke-false kill-server

docker cp tests/fixtures/fake-antigravity.sh \
  "${PUBLIC_CONTAINER}:/tmp/fake-antigravity"
docker exec "${PUBLIC_CONTAINER}" chmod 0755 /tmp/fake-antigravity
docker exec "${PUBLIC_CONTAINER}" cp -p \
  /usr/local/libexec/antigravity-real \
  /tmp/antigravity-real.smoke-original
docker exec "${PUBLIC_CONTAINER}" install -m 0755 \
  /tmp/fake-antigravity /usr/local/libexec/antigravity-real
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c \
  'jq ".web_terminal_auto_start_antigravity = true" /data/options.json > /data/options.json.tmp && mv /data/options.json.tmp /data/options.json'
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c '
  jq ".web_terminal_auto_start_antigravity = true" \
    /run/antigravity-ha/ha-feedback-options.json \
    > /run/antigravity-ha/.ha-feedback-options.smoke
  chmod 0600 /run/antigravity-ha/.ha-feedback-options.smoke
  mv -f /run/antigravity-ha/.ha-feedback-options.smoke \
    /run/antigravity-ha/ha-feedback-options.json
'
docker exec "${PUBLIC_CONTAINER}" env \
  TMUX_TMPDIR=/data/tmux \
  tmux -L smoke-true new-session -d -s smoke-true -c /config \
  /usr/local/bin/tmux-session-shell
for _ in $(seq 1 20); do
  if docker exec "${PUBLIC_CONTAINER}" test -e /tmp/antigravity-auto-started; then
    break
  fi
  sleep 0.1
done
docker exec "${PUBLIC_CONTAINER}" test -e /tmp/antigravity-auto-started
docker exec "${PUBLIC_CONTAINER}" install -m 0755 \
  /tmp/antigravity-real.smoke-original \
  /usr/local/libexec/antigravity-real
RESTORED_ANTIGRAVITY_OUTPUT=$(docker exec "${PUBLIC_CONTAINER}" antigravity --version)
[[ "${RESTORED_ANTIGRAVITY_OUTPUT}" == "${antigravity_OUTPUT}" ]] \
  || fail 'the native Antigravity binary was not restored after the auto-start probe'
[[ $(docker exec "${PUBLIC_CONTAINER}" env TMUX_TMPDIR=/data/tmux \
  tmux -L smoke-true display-message -p -t smoke-true:0.0 \
  '#{pane_current_path}:#{pane_current_command}') == '/config:bash' ]]
docker exec "${PUBLIC_CONTAINER}" env TMUX_TMPDIR=/data/tmux \
  tmux -L smoke-true kill-server

for executable in \
  /etc/s6-overlay/s6-rc.d/antigravity-ha-init/run \
  /etc/s6-overlay/s6-rc.d/ingress/run \
  /etc/s6-overlay/s6-rc.d/sshd/run \
  /etc/s6-overlay/s6-rc.d/ttyd/run \
  /usr/local/bin/antigravity-ha-init \
  /usr/local/bin/ha-api \
  /usr/local/bin/ha-browser-auth-status \
  /usr/local/bin/ha-browser-network-info \
  /usr/local/bin/supervisor-api \
  /usr/local/bin/web-terminal-entrypoint; do
  docker exec "${PUBLIC_CONTAINER}" test -x "${executable}"
done

[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /data/ssh/authorized_keys) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /data/ssh/ssh_host_ed25519_key) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /data/ssh/ssh_host_ed25519_key.pub) == 644 ]]
docker exec "${PUBLIC_CONTAINER}" test ! -e /run/antigravity-ha/runtime.env
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /run/antigravity-ha/browser-auth-status.json) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /run/antigravity-ha/browser-network-info.json) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /run/antigravity-ha/home-assistant-browser.token) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' /root/.ssh/environment) == 600 ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a:%U:%G' \
  /data/home/.gemini/antigravity-cli/settings.json) == 600:root:root ]]
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a:%U:%G' \
  /data/home/.gemini/config/mcp_config.json) == 600:root:root ]]
docker exec "${PUBLIC_CONTAINER}" test -f \
  /data/home/.gemini/config/plugins/home-assistant/plugin.json
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a:%U:%G' \
  /data/home/.gemini/config/plugins/home-assistant/.antigravity-ha-managed.json) == 600:root:root ]]
docker exec "${PUBLIC_CONTAINER}" jq --exit-status \
  --arg version "${EXPECTED_APP_VERSION}" '
  .schema == 1
  and .owner == "antigravity-for-home-assistant"
  and .plugin == "home-assistant"
  and .installed_version == $version
  and (.applied_versions | index($version) != null)
' /data/home/.gemini/config/plugins/home-assistant/.antigravity-ha-managed.json \
  >/dev/null
docker exec "${PUBLIC_CONTAINER}" test ! -e /config/AGENTS.md
docker exec "${PUBLIC_CONTAINER}" test ! -e \
  /run/antigravity-ha/playwright-secrets.env
if docker exec "${PUBLIC_CONTAINER}" grep -Fq -- '"--secrets"' \
  /usr/local/share/antigravity-ha/playwright-mcp-proxy.mjs; then
  fail 'Playwright MCP secret substitution remained enabled'
fi

PORT=$(docker port "${PUBLIC_CONTAINER}" 22/tcp | head -n1 | sed 's/.*://')
SSH_OPTIONS=(
  -i "${WORK_DIR}/client_key"
  -p "${PORT}"
  -o BatchMode=yes
  -o ConnectTimeout=5
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile="${WORK_DIR}/known_hosts"
)
ssh-keyscan -p "${PORT}" 127.0.0.1 > "${WORK_DIR}/known_hosts" 2>/dev/null

SSH_OUTPUT=$(ssh "${SSH_OPTIONS[@]}" root@127.0.0.1 \
  'printf "%s\n" "$ANTIGRAVITY_HOME" "$LANG"; command -v antigravity; antigravity --version')
grep -Fxq '/data/antigravity' <<< "${SSH_OUTPUT}"
grep -Fxq 'C.UTF-8' <<< "${SSH_OUTPUT}"
grep -Fxq '/usr/local/bin/antigravity' <<< "${SSH_OUTPUT}"
grep -Fxq "${antigravity_OUTPUT}" <<< "${SSH_OUTPUT}"

LOGIN_OUTPUT=$(printf 'pwd\nexit\n' | ssh -tt "${SSH_OPTIONS[@]}" root@127.0.0.1 2>&1)
grep -Fq '/config' <<< "${LOGIN_OUTPUT}"

if ssh \
  -p "${PORT}" \
  -o BatchMode=yes \
  -o ConnectTimeout=5 \
  -o PubkeyAuthentication=no \
  -o PasswordAuthentication=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="${WORK_DIR}/known_hosts" \
  root@127.0.0.1 true >/dev/null 2>&1; then
  fail 'password-only SSH unexpectedly succeeded'
fi

HOST_KEY_BEFORE=$(docker exec "${PUBLIC_CONTAINER}" \
  ssh-keygen -lf /data/ssh/ssh_host_ed25519_key.pub)
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c '
  jq ".preserved_smoke_marker = true" \
    /data/home/.gemini/antigravity-cli/settings.json > /tmp/settings.json
  chmod 0600 /tmp/settings.json
  mv /tmp/settings.json /data/home/.gemini/antigravity-cli/settings.json
  jq ".preserved_smoke_marker = true" \
    /data/home/.gemini/config/mcp_config.json > /tmp/mcp.json
  chmod 0600 /tmp/mcp.json
  mv /tmp/mcp.json /data/home/.gemini/config/mcp_config.json
  printf "%s\n" managed-plugin-preserve \
    > /data/home/.gemini/config/plugins/home-assistant/.preserve-smoke-marker
  install -d -m 0700 /data/home/.gemini/config/plugins/user-smoke
  printf "%s\n" "{\"name\":\"user-smoke\"}" \
    > /data/home/.gemini/config/plugins/user-smoke/plugin.json
  printf "%s\n" user-plugin-preserve \
    > /data/home/.gemini/config/plugins/user-smoke/preserve-marker
'
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c \
  'printf "%s\n" sentinel > /run/antigravity-ha/playwright-output/init-sentinel'
docker exec "${PUBLIC_CONTAINER}" rm -f /data/ssh/ssh_host_rsa_key.pub
docker exec "${PUBLIC_CONTAINER}" antigravity-ha-init >/dev/null
docker exec "${PUBLIC_CONTAINER}" test ! -e \
  /run/antigravity-ha/playwright-output/init-sentinel
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' \
  /run/antigravity-ha/playwright-output) == 700 ]]
docker exec "${PUBLIC_CONTAINER}" jq --exit-status '.preserved_smoke_marker == true' \
  /data/home/.gemini/antigravity-cli/settings.json >/dev/null
docker exec "${PUBLIC_CONTAINER}" jq --exit-status '.preserved_smoke_marker == true' \
  /data/home/.gemini/config/mcp_config.json >/dev/null
docker exec "${PUBLIC_CONTAINER}" grep -Fxq managed-plugin-preserve \
  /data/home/.gemini/config/plugins/home-assistant/.preserve-smoke-marker
docker exec "${PUBLIC_CONTAINER}" grep -Fxq user-plugin-preserve \
  /data/home/.gemini/config/plugins/user-smoke/preserve-marker
docker exec "${PUBLIC_CONTAINER}" test -s /data/ssh/ssh_host_rsa_key.pub
[[ $(docker exec "${PUBLIC_CONTAINER}" stat -c '%a' \
  /data/home/.gemini/antigravity-cli/settings.json) == 600 ]]

SIMULATED_APP_VERSION="${EXPECTED_APP_VERSION}-smoke"
printf '%s\n' "${SIMULATED_APP_VERSION}" \
  | docker exec --interactive "${PUBLIC_CONTAINER}" /bin/sh -c \
    'cat > /usr/local/share/antigravity-ha/app-version'
docker exec "${PUBLIC_CONTAINER}" antigravity-ha-init >/dev/null
docker exec "${PUBLIC_CONTAINER}" jq --arg version "${SIMULATED_APP_VERSION}" \
  --exit-status '
    .installed_version == $version
    and (.applied_versions | index($version) != null)
  ' \
  /data/home/.gemini/config/plugins/home-assistant/.antigravity-ha-managed.json \
  >/dev/null
docker exec "${PUBLIC_CONTAINER}" test ! -e \
  /data/home/.gemini/config/plugins/home-assistant/.preserve-smoke-marker \
  || fail 'preserve mode skipped an App-version plugin refresh'
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c '
  jq ".same_version_user_marker = true" \
    /data/home/.gemini/config/plugins/home-assistant/plugin.json \
    > /tmp/plugin.json
  mv /tmp/plugin.json \
    /data/home/.gemini/config/plugins/home-assistant/plugin.json
'
docker exec "${PUBLIC_CONTAINER}" antigravity-ha-init >/dev/null
docker exec "${PUBLIC_CONTAINER}" jq --exit-status \
  '.same_version_user_marker == true' \
  /data/home/.gemini/config/plugins/home-assistant/plugin.json >/dev/null \
  || fail 'same-version startup reinstalled the managed plugin'
printf '%s\n' "${EXPECTED_APP_VERSION}" \
  | docker exec --interactive "${PUBLIC_CONTAINER}" /bin/sh -c \
    'cat > /usr/local/share/antigravity-ha/app-version'
docker exec "${PUBLIC_CONTAINER}" antigravity-ha-init >/dev/null
docker exec "${PUBLIC_CONTAINER}" jq --arg version "${EXPECTED_APP_VERSION}" \
  --exit-status '.installed_version == $version' \
  /data/home/.gemini/config/plugins/home-assistant/.antigravity-ha-managed.json \
  >/dev/null
if docker exec "${PUBLIC_CONTAINER}" jq --exit-status \
  '.same_version_user_marker == true' \
  /data/home/.gemini/config/plugins/home-assistant/plugin.json >/dev/null; then
  fail 'App-version rollback did not restore the canonical managed plugin'
fi
docker exec "${PUBLIC_CONTAINER}" jq --exit-status '.preserved_smoke_marker == true' \
  /data/home/.gemini/antigravity-cli/settings.json >/dev/null
docker exec "${PUBLIC_CONTAINER}" jq --exit-status '.preserved_smoke_marker == true' \
  /data/home/.gemini/config/mcp_config.json >/dev/null
docker exec "${PUBLIC_CONTAINER}" grep -Fxq user-plugin-preserve \
  /data/home/.gemini/config/plugins/user-smoke/preserve-marker

RUNTIME_LOGS_FILE="${WORK_DIR}/runtime.log"
{
  docker logs "${PUBLIC_CONTAINER}"
  docker logs "${GATEWAY_FIXTURE}"
} > "${RUNTIME_LOGS_FILE}" 2>&1
for secret in "${SUPERVISOR_TOKEN}" "${BROWSER_TOKEN}"; do
  if grep -Fq -- "${secret}" "${RUNTIME_LOGS_FILE}"; then
    fail 'A Home Assistant credential appeared in container logs'
  fi
done

docker rm -f "${PUBLIC_CONTAINER}" >/dev/null
docker create \
  --platform "$TEST_PLATFORM" \
  --name "${IP_REUSE_CONTAINER}" \
  --network "${GATEWAY_NETWORK}" \
  --ip "${PUBLIC_APP_IP}" \
  --entrypoint /bin/sh \
  "${IMAGE}" \
  -c 'sleep 30' >/dev/null \
  || fail "Docker could not reassign the released App address ${PUBLIC_APP_IP}"
docker start "${IP_REUSE_CONTAINER}" >/dev/null
REUSED_APP_IP=$(docker inspect --format \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  "${IP_REUSE_CONTAINER}")
[[ "${REUSED_APP_IP}" == "${PUBLIC_APP_IP}" ]] \
  || fail "Docker did not reuse the released App address ${PUBLIC_APP_IP}"
if docker exec "${IP_REUSE_CONTAINER}" curl \
  --fail \
  --silent \
  --output /dev/null \
  http://homeassistant:8123/api/config; then
  fail 'A replacement container inherited browser access from the stale App IP'
fi
if docker exec "${IP_REUSE_CONTAINER}" curl \
  --fail \
  --silent \
  --output /dev/null \
  --header "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
  http://homeassistant:8123/api/config; then
  fail 'A replacement container used the Supervisor token as a browser credential'
fi
docker rm -f "${IP_REUSE_CONTAINER}" >/dev/null

docker run --detach \
  --platform "$TEST_PLATFORM" \
  --name "${PUBLIC_CONTAINER}" \
  --network "${GATEWAY_NETWORK}" \
  --env SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}" \
  --volume "${PUBLIC_DATA}:/data" \
  --volume "${PUBLIC_CONFIG}:/config" \
  "${IMAGE}" >/dev/null
wait_for_log "${PUBLIC_CONTAINER}" 'antigravity runtime ready:'
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c \
  'ha-browser-auth-status | jq --exit-status '\''.status == "ready"'\'' >/dev/null' \
  || fail 'Dedicated browser authentication was not restored after replacement'
HOST_KEY_AFTER=$(docker exec "${PUBLIC_CONTAINER}" \
  ssh-keygen -lf /data/ssh/ssh_host_ed25519_key.pub)
[[ "${HOST_KEY_BEFORE}" == "${HOST_KEY_AFTER}" ]] \
  || fail 'SSH host key changed after container replacement'
docker exec "${PUBLIC_CONTAINER}" jq --exit-status '.preserved_smoke_marker == true' \
  /data/home/.gemini/antigravity-cli/settings.json >/dev/null
docker exec "${PUBLIC_CONTAINER}" jq --exit-status '.preserved_smoke_marker == true' \
  /data/home/.gemini/config/mcp_config.json >/dev/null
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c '
  set -eu
  jq ".home_assistant_browser_auto_auth = false" \
    /data/options.json > /data/options.json.tmp
  mv /data/options.json.tmp /data/options.json
  jq ".home_assistant_browser_auto_auth = false" \
    /run/antigravity-ha/ha-feedback-options.json \
    > /run/antigravity-ha/.ha-feedback-options.smoke
  chmod 0600 /run/antigravity-ha/.ha-feedback-options.smoke
  mv /run/antigravity-ha/.ha-feedback-options.smoke \
    /run/antigravity-ha/ha-feedback-options.json
'
docker exec "${PUBLIC_CONTAINER}" ha-browser-auth-refresh --quiet \
  || fail 'managed browser authentication did not accept automatic authentication OFF'
docker exec "${PUBLIC_CONTAINER}" jq --exit-status \
  '.status == "disabled" and .reason == "option_disabled"' \
  /run/antigravity-ha/browser-auth-status.json >/dev/null \
  || fail 'managed browser authentication was not suppressed while automatic authentication was OFF'
docker exec "${PUBLIC_CONTAINER}" test ! -e \
  /run/antigravity-ha/home-assistant-browser.token \
  || fail 'managed browser authentication left a runtime token while automatic authentication was OFF'
docker exec "${PUBLIC_CONTAINER}" /bin/sh -c '
  set -eu
  jq ".home_assistant_browser_auto_auth = true" \
    /data/options.json > /data/options.json.tmp
  mv /data/options.json.tmp /data/options.json
  jq ".home_assistant_browser_auto_auth = true" \
    /run/antigravity-ha/ha-feedback-options.json \
    > /run/antigravity-ha/.ha-feedback-options.smoke
  chmod 0600 /run/antigravity-ha/.ha-feedback-options.smoke
  mv /run/antigravity-ha/.ha-feedback-options.smoke \
    /run/antigravity-ha/ha-feedback-options.json
'
docker exec "${PUBLIC_CONTAINER}" ha-browser-auth-ensure --quiet \
  || fail 'managed browser authentication did not reactivate after automatic authentication was enabled'
docker exec "${PUBLIC_CONTAINER}" jq --exit-status \
  '.status == "ready" and .source == "managed"' \
  /run/antigravity-ha/browser-auth-status.json >/dev/null \
  || fail 'managed browser authentication did not return after automatic authentication was enabled'

docker run --detach \
  --platform "$TEST_PLATFORM" \
  --name "${DEGRADED_CONTAINER}" \
  --network "${GATEWAY_NETWORK}" \
  --volume "${DEGRADED_DATA}:/data" \
  --volume "${DEGRADED_CONFIG}:/config" \
  "${IMAGE}" >/dev/null
wait_for_log "${DEGRADED_CONTAINER}" 'antigravity runtime ready:'
wait_for_log "${DEGRADED_CONTAINER}" 'Ignored 1 invalid SSH public key(s)'
wait_for_log "${DEGRADED_CONTAINER}" 'SSH service is disabled'
wait_for_process "${DEGRADED_CONTAINER}" 'ttyd'
wait_for_process "${DEGRADED_CONTAINER}" 'nginx'

docker exec "${DEGRADED_CONTAINER}" test -e /run/antigravity-ha/ssh-disabled
docker exec "${DEGRADED_CONTAINER}" test -s /data/ssh/ssh_host_ed25519_key
docker exec "${DEGRADED_CONTAINER}" /bin/sh -c \
  'ha-browser-auth-status | jq --exit-status '\''.status == "unconfigured"'\'' >/dev/null' \
  || fail 'Missing browser token did not fail closed as unconfigured'
docker exec "${DEGRADED_CONTAINER}" test ! -e \
  /run/antigravity-ha/home-assistant-browser.token
docker exec "${DEGRADED_CONTAINER}" test ! -e \
  /run/antigravity-ha/playwright-secrets.env
printf '%s\n%s\n' "${MANAGED_STATE}" "${BROWSER_TOKEN}" \
  | docker exec --interactive "${DEGRADED_CONTAINER}" /bin/sh -ceu '
    install -d -m 0700 /data/browser-auth
    IFS= read -r fixture_state
    IFS= read -r fixture_token
    printf "%s\n" "${fixture_state}" > /data/browser-auth/managed-user.json
    printf "%s" "${fixture_token}" > /data/browser-auth/managed-token
    chmod 0600 \
      /data/browser-auth/managed-user.json \
      /data/browser-auth/managed-token
  '
if docker exec "${DEGRADED_CONTAINER}" ha-browser-auth-refresh --quiet; then
  fail 'Managed browser material activated without a Supervisor credential'
fi
docker exec "${DEGRADED_CONTAINER}" jq --exit-status '
  .status == "rejected" and .reason == "supervisor_validation_unavailable"
' /run/antigravity-ha/browser-auth-status.json >/dev/null \
  || fail 'Missing Supervisor credential did not produce a sanitized rejected status'
docker exec "${DEGRADED_CONTAINER}" test ! -e \
  /run/antigravity-ha/home-assistant-browser.token \
  || fail 'Missing Supervisor credential created a runtime browser token'
docker exec "${DEGRADED_CONTAINER}" rm -f \
  /data/browser-auth/managed-user.json \
  /data/browser-auth/managed-token
if docker exec "${DEGRADED_CONTAINER}" ha-browser-auth-refresh --quiet; then
  fail 'Missing managed browser material unexpectedly activated authentication'
fi
docker exec "${DEGRADED_CONTAINER}" jq --exit-status \
  '.status == "unconfigured"' \
  /run/antigravity-ha/browser-auth-status.json >/dev/null \
  || fail 'Removing managed browser material did not restore unconfigured status'
docker exec "${DEGRADED_CONTAINER}" test ! -e \
  /run/antigravity-ha/home-assistant-browser.token \
  || fail 'Unconfigured browser authentication created a runtime token'
docker cp tests/playwright_mcp_smoke.mjs \
  "${DEGRADED_CONTAINER}:/tmp/playwright_mcp_smoke.mjs"
DEGRADED_MCP_OUTPUT_FILE="${WORK_DIR}/playwright-mcp-degraded.log"
if ! docker exec \
  --workdir /config \
  --env HA_BROWSER_TOKEN="${BROWSER_TOKEN}" \
  --env PLAYWRIGHT_MCP_SMOKE_URL=http://127.0.0.1:8099/ \
  --env PLAYWRIGHT_MCP_SMOKE_EXPECT_TEXT=HA_BROWSER_GATEWAY_FAILED \
  --env PLAYWRIGHT_MCP_SMOKE_EXPECT_UNAUTHENTICATED=1 \
  "${DEGRADED_CONTAINER}" \
  node /tmp/playwright_mcp_smoke.mjs /usr/local/bin/ha-playwright-mcp \
  > "${DEGRADED_MCP_OUTPUT_FILE}" 2>&1; then
  fail 'Inherited HA_BROWSER_TOKEN did not fail closed without a validated token file'
fi
if grep -Fq -- "${BROWSER_TOKEN}" "${DEGRADED_MCP_OUTPUT_FILE}"; then
  fail 'Fail-closed Playwright MCP output disclosed the inherited browser token'
fi
docker exec "${DEGRADED_CONTAINER}" test ! -e /data/antigravity/AGENTS.md
docker exec "${DEGRADED_CONTAINER}" grep -Fxq '# user override' /data/antigravity/AGENTS.override.md
[[ $(docker exec "${DEGRADED_CONTAINER}" stat -c '%a' /data/antigravity/AGENTS.override.md) == 600 ]]

docker exec "${DEGRADED_CONTAINER}" rm -f /data/antigravity/AGENTS.override.md
docker exec "${DEGRADED_CONTAINER}" ln -s missing-user-guidance /data/antigravity/AGENTS.md
docker exec "${DEGRADED_CONTAINER}" antigravity-ha-init >/dev/null
docker exec "${DEGRADED_CONTAINER}" test -L /data/antigravity/AGENTS.md
[[ $(docker exec "${DEGRADED_CONTAINER}" readlink /data/antigravity/AGENTS.md) == missing-user-guidance ]]

docker exec "${DEGRADED_CONTAINER}" rm -f /data/antigravity/AGENTS.md
docker exec "${DEGRADED_CONTAINER}" install -m 0600 /dev/null /data/antigravity/AGENTS.md
docker exec "${DEGRADED_CONTAINER}" antigravity-ha-init >/dev/null
docker exec "${DEGRADED_CONTAINER}" test ! -s /data/antigravity/AGENTS.md
[[ $(docker exec "${DEGRADED_CONTAINER}" stat -c '%a' /data/antigravity/AGENTS.md) == 600 ]]

docker exec "${DEGRADED_CONTAINER}" /bin/sh -c \
  'printf "%s\n" "# existing user guidance" > /data/antigravity/AGENTS.md && chmod 0600 /data/antigravity/AGENTS.md'
USER_GUIDANCE_HASH_BEFORE=$(docker exec "${DEGRADED_CONTAINER}" sha256sum /data/antigravity/AGENTS.md)
docker exec "${DEGRADED_CONTAINER}" antigravity-ha-init >/dev/null
USER_GUIDANCE_HASH_AFTER=$(docker exec "${DEGRADED_CONTAINER}" sha256sum /data/antigravity/AGENTS.md)
[[ "${USER_GUIDANCE_HASH_BEFORE}" == "${USER_GUIDANCE_HASH_AFTER}" ]]
[[ $(docker exec "${DEGRADED_CONTAINER}" stat -c '%a' /data/antigravity/AGENTS.md) == 600 ]]
if docker exec "${DEGRADED_CONTAINER}" pgrep -f '/usr/sbin/sshd' >/dev/null 2>&1; then
  fail 'sshd is running without an authorized key'
fi
docker exec "${DEGRADED_CONTAINER}" curl --fail --silent --show-error \
  http://127.0.0.1:7681/ >/dev/null

{
  docker logs "${PUBLIC_CONTAINER}"
  docker logs "${DEGRADED_CONTAINER}"
  docker logs "${GATEWAY_FIXTURE}"
} > "${RUNTIME_LOGS_FILE}" 2>&1
for secret in "${SUPERVISOR_TOKEN}" "${BROWSER_TOKEN}"; do
  if grep -Fq -- "${secret}" "${RUNTIME_LOGS_FILE}"; then
    fail 'A Home Assistant credential appeared in final container logs'
  fi
done

printf 'Docker smoke tests passed for %s (%s)\n' "${IMAGE}" "${antigravity_OUTPUT}"
