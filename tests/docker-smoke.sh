#!/usr/bin/env bash
set -Eeuo pipefail

readonly TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}
case "${TEST_PLATFORM}" in
  linux/amd64) readonly EXPECTED_HA_ARCH=amd64 ;;
  linux/arm64) readonly EXPECTED_HA_ARCH=aarch64 ;;
  *) printf 'unsupported TEST_PLATFORM: %s\n' "${TEST_PLATFORM}" >&2; exit 64 ;;
esac
readonly HA_ARCH=${HA_ARCH:-${EXPECTED_HA_ARCH}}
[[ ${HA_ARCH} == "${EXPECTED_HA_ARCH}" ]] || exit 64
export HA_ARCH TEST_PLATFORM

readonly IMAGE=${1:-antigravity-for-home-assistant:test}
readonly TEST_ID="antigravity-ha-smoke-${RANDOM}-${RANDOM}-$$"
readonly APP_CONTAINER="${TEST_ID}-app"
readonly GATEWAY_FIXTURE="${TEST_ID}-gateway"
readonly GATEWAY_NETWORK="${TEST_ID}-network"
readonly DATA_VOLUME="${TEST_ID}-data"
readonly CONFIG_VOLUME="${TEST_ID}-config"
readonly SUPERVISOR_TOKEN=smoke-supervisor-token-do-not-use
readonly BROWSER_TOKEN=smoke-browser-token-read-only-do-not-use
readonly MANAGED_OPERATION_ID=gatewaySmokeManagedOperation0001
readonly GATEWAY_MARKER='HA_BROWSER_GATEWAY_AUTHENTICATED:antigravity HA fixture'
WORK_DIR=$(mktemp -d)
readonly WORK_DIR

# Git Bash rewrites Linux container paths before invoking native Windows tools.
if [[ ${OSTYPE:-} == msys* || ${OSTYPE:-} == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

if command -v python3 >/dev/null 2>&1; then
  readonly PYTHON_BIN=python3
else
  readonly PYTHON_BIN=python
fi

cleanup() {
  docker rm -f "${APP_CONTAINER}" "${GATEWAY_FIXTURE}" \
    >/dev/null 2>&1 || true
  docker volume rm -f "${DATA_VOLUME}" "${CONFIG_VOLUME}" \
    >/dev/null 2>&1 || true
  docker network rm "${GATEWAY_NETWORK}" >/dev/null 2>&1 || true
  rm -rf -- "${WORK_DIR}"
}
trap cleanup EXIT

fail() {
  printf 'docker smoke: %s\n' "$*" >&2
  for container in "${APP_CONTAINER}" "${GATEWAY_FIXTURE}"; do
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
  local attempt

  for ((attempt = 0; attempt < 90; attempt += 1)); do
    if docker logs "${container}" 2>&1 | grep -Fq "${pattern}"; then
      return 0
    fi
    if [[ $(docker inspect --format '{{.State.Running}}' "${container}" \
      2>/dev/null || true) != true ]]; then
      fail "${container} exited before logging: ${pattern}"
    fi
    sleep 1
  done
  fail "timed out waiting for ${container} log: ${pattern}"
}

wait_for_process() {
  local container=$1
  local pattern=$2
  local attempt

  for ((attempt = 0; attempt < 60; attempt += 1)); do
    if docker exec "${container}" pgrep -f "${pattern}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "timed out waiting for ${container} process: ${pattern}"
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"

# The destructive 2.x-to-3.0 migration and its restart idempotence have one
# image-level owner. Fresh-start checks below seed its completion marker so
# browser fixtures are not mistaken for 2.x state.
tests/v3-upgrade-smoke.sh "${IMAGE}" \
  || fail '3.0 one-time upgrade reset smoke failed'

docker run --rm --platform "${TEST_PLATFORM}" \
  --entrypoint /bin/bash "${IMAGE}" -ceu '
    [[ -z "$(find /var/lib/apt/lists -mindepth 1 -print -quit)" ]]
    [[ -z "$(find /var/cache/apt/archives -mindepth 1 -print -quit)" ]]
    [[ -z "$(find /var/cache/apt -maxdepth 1 -type f -name "*.bin" -print -quit)" ]]
    [[ ! -e /tmp/npm-cache ]]
    [[ ! -e /root/.cache/ms-playwright ]]
  ' || fail 'candidate image retained package-manager or browser download caches'

PINNED_ANTIGRAVITY_VERSION=$(sed -n \
  's/^ARG ANTIGRAVITY_VERSION=//p' antigravity_home_assistant/Dockerfile)
readonly PINNED_ANTIGRAVITY_VERSION
[[ ${PINNED_ANTIGRAVITY_VERSION} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail 'Dockerfile Antigravity version pin is invalid'
[[ $(docker run --rm --platform "${TEST_PLATFORM}" \
  --entrypoint /usr/local/libexec/antigravity-real "${IMAGE}" --version) \
  == "${PINNED_ANTIGRAVITY_VERSION}" ]] \
  || fail 'candidate image does not contain the pinned Antigravity version'
docker run --rm --platform "${TEST_PLATFORM}" \
  --entrypoint /usr/local/libexec/antigravity-real "${IMAGE}" \
  plugin validate /usr/local/share/antigravity-ha/plugins/home-assistant \
  >/dev/null || fail 'image-managed Home Assistant plugin failed validation'

for rejected_flag in \
  --dangerously-skip-permissions \
  --no-sandbox \
  --sandbox \
  --sandbox=true; do
  set +e
  docker run --rm --platform "${TEST_PLATFORM}" \
    --entrypoint /usr/local/bin/antigravity "${IMAGE}" \
    "${rejected_flag}" --help >/dev/null 2>&1
  rejected_status=$?
  set -e
  [[ ${rejected_status} -eq 78 ]] \
    || fail "native permission wrapper accepted ${rejected_flag}"
done
unset rejected_flag rejected_status

docker network create "${GATEWAY_NETWORK}" >/dev/null
docker volume create "${DATA_VOLUME}" >/dev/null
docker volume create "${CONFIG_VOLUME}" >/dev/null

docker create \
  --platform "${TEST_PLATFORM}" \
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
wait_for_log "${GATEWAY_FIXTURE}" \
  'Home Assistant browser gateway fixture ready'

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
readonly MANAGED_STATE

printf '%s\n%s\n' "${MANAGED_STATE}" "${BROWSER_TOKEN}" \
  | docker run --rm --interactive \
    --platform "${TEST_PLATFORM}" \
    --entrypoint /bin/sh \
    --volume "${DATA_VOLUME}:/data" \
    "${IMAGE}" -ceu '
      umask 077
      cat > /data/options.json <<"JSON"
{"remote_control_name":"home-assistant","antigravity_sensitive_data_access":false,"home_assistant_browser_auto_auth":true,"log_level":"info"}
JSON
      cat > /data/.antigravity-ha-v3-reset-complete.json <<"JSON"
{"schema":"antigravity-ha-v3-factory-reset/v1","completed":true}
JSON
      install -d -m 0700 /data/browser-auth
      IFS= read -r fixture_state
      IFS= read -r fixture_token
      printf "%s\n" "${fixture_state}" \
        > /data/browser-auth/managed-user.json
      printf "%s" "${fixture_token}" \
        > /data/browser-auth/managed-token
      chmod 0600 \
        /data/options.json \
        /data/.antigravity-ha-v3-reset-complete.json \
        /data/browser-auth/managed-user.json \
        /data/browser-auth/managed-token
    '

docker run --detach \
  --platform "${TEST_PLATFORM}" \
  --name "${APP_CONTAINER}" \
  --network "${GATEWAY_NETWORK}" \
  --env SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}" \
  --publish 127.0.0.1::17682 \
  --volume "${DATA_VOLUME}:/data" \
  --volume "${CONFIG_VOLUME}:/config" \
  "${IMAGE}" >/dev/null

wait_for_log "${APP_CONTAINER}" \
  "Antigravity ${PINNED_ANTIGRAVITY_VERSION} runtime ready"
wait_for_log "${APP_CONTAINER}" \
  'Antigravity Remote Control is waiting for ha-antigravity-remote-login.'
wait_for_process "${APP_CONTAINER}" \
  '/usr/local/libexec/ha-antigravity-remote-runtime'
wait_for_process "${APP_CONTAINER}" 'ttyd'
wait_for_process "${APP_CONTAINER}" 'nginx'

docker exec "${APP_CONTAINER}" jq --exit-status '
  keys == [
    "antigravity_sensitive_data_access",
    "home_assistant_browser_auto_auth",
    "log_level",
    "remote_control_name"
  ]
  and .remote_control_name == "home-assistant"
  and .antigravity_sensitive_data_access == false
  and .home_assistant_browser_auto_auth == true
  and .log_level == "info"
' /run/antigravity-ha/ha-feedback-options.json >/dev/null \
  || fail 'runtime options are not the four-option 3.0 interface'
[[ $(docker exec "${APP_CONTAINER}" stat -c '%a:%U:%G' \
  /run/antigravity-ha/supervisor.token) == 400:root:root ]] \
  || fail 'isolated Supervisor credential metadata is unsafe'

docker exec "${APP_CONTAINER}" ha-browser-auth-status \
  | docker exec --interactive "${APP_CONTAINER}" jq --exit-status '
      .status == "ready"
      and .source == "managed"
      and .user.group_ids == ["system-read-only"]
      and .user.local_only == true
      and .user.is_admin == false
    ' >/dev/null \
  || fail 'managed Home Assistant browser identity was not ready'
wait_for_log "${GATEWAY_FIXTURE}" \
  'Gateway fixture accepted authenticated /core/info'
wait_for_log "${GATEWAY_FIXTURE}" \
  'Core WebSocket fixture accepted browser auth/current_user'
wait_for_log "${GATEWAY_FIXTURE}" \
  'Supervisor WebSocket fixture accepted Supervisor config/auth/list'

docker exec "${APP_CONTAINER}" jq --exit-status '
  (.mcpServers | keys) == [
    "ha_files",
    "ha_memory",
    "ha_read",
    "ha_validate",
    "playwright"
  ]
  and .mcpServers.playwright.command == "/usr/local/bin/ha-playwright-mcp"
  and .mcpServers.ha_memory.command == "/usr/local/bin/ha-memory-mcp"
  and .mcpServers.ha_read.command == "/usr/local/bin/ha-read-mcp"
  and .mcpServers.ha_files.command == "/usr/local/bin/ha-files-mcp"
  and .mcpServers.ha_validate.command == "/usr/local/bin/ha-validate-mcp"
' /data/home/.gemini/config/plugins/home-assistant/mcp_config.json >/dev/null \
  || fail 'installed Home Assistant plugin MCP surface is unexpected'

docker cp tests/playwright_mcp_smoke.mjs \
  "${APP_CONTAINER}:/tmp/playwright_mcp_smoke.mjs"
docker cp tests/ha_browser_gateway_fixture.mjs \
  "${APP_CONTAINER}:/tmp/ha_browser_gateway_fixture.mjs"
APP_IP=$(docker inspect --format \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  "${APP_CONTAINER}")
readonly APP_IP
readonly MCP_OUTPUT_FILE="${WORK_DIR}/playwright-mcp-smoke.log"
if ! docker exec \
  --workdir /config \
  --env PLAYWRIGHT_MCP_SMOKE_URL=http://127.0.0.1:8099/ \
  --env PLAYWRIGHT_MCP_SMOKE_EXPECT_TEXT="${GATEWAY_MARKER}" \
  --env PLAYWRIGHT_MCP_SMOKE_EXPECT_SOURCE_IP="${APP_IP}" \
  --env PLAYWRIGHT_MCP_SMOKE_SCREENSHOT_DIR=/tmp/antigravity-ha-browser-evidence \
  "${APP_CONTAINER}" \
  node /tmp/playwright_mcp_smoke.mjs /usr/local/bin/ha-playwright-mcp \
  > "${MCP_OUTPUT_FILE}" 2>&1; then
  fail 'Playwright MCP browser smoke failed'
fi
if grep -Fq -- "${SUPERVISOR_TOKEN}" "${MCP_OUTPUT_FILE}" \
  || grep -Fq -- "${BROWSER_TOKEN}" "${MCP_OUTPUT_FILE}"; then
  fail 'Playwright MCP output disclosed a Home Assistant credential'
fi
cat "${MCP_OUTPUT_FILE}"

readonly POLICY_OUTPUT_FILE="${WORK_DIR}/playwright-mcp-policy.log"
docker exec \
  --workdir /config \
  --env PLAYWRIGHT_MCP_SMOKE_POLICY_ONLY=1 \
  "${APP_CONTAINER}" \
  node /tmp/playwright_mcp_smoke.mjs /usr/local/bin/ha-playwright-mcp \
  > "${POLICY_OUTPUT_FILE}" 2>&1 \
  || fail 'Playwright MCP native policy smoke failed'
if grep -Fq -- "${SUPERVISOR_TOKEN}" "${POLICY_OUTPUT_FILE}" \
  || grep -Fq -- "${BROWSER_TOKEN}" "${POLICY_OUTPUT_FILE}"; then
  fail 'Playwright MCP policy output disclosed a Home Assistant credential'
fi

for screenshot in \
  home-assistant-internal-desktop.png \
  home-assistant-internal-mobile.png; do
  docker exec "${APP_CONTAINER}" test -s \
    "/tmp/antigravity-ha-browser-evidence/${screenshot}" \
    || fail "Home Assistant screenshot was not captured: ${screenshot}"
  if [[ -n ${antigravity_HA_SMOKE_ARTIFACT_DIR:-} ]]; then
    mkdir -p "${antigravity_HA_SMOKE_ARTIFACT_DIR}"
    docker exec "${APP_CONTAINER}" base64 \
      "/tmp/antigravity-ha-browser-evidence/${screenshot}" \
      | base64 --decode \
      > "${antigravity_HA_SMOKE_ARTIFACT_DIR}/${screenshot}"
  fi
done

docker exec "${APP_CONTAINER}" \
  node /tmp/ha_browser_gateway_fixture.mjs \
  --probe-websocket ws://127.0.0.1:8099/api/websocket "${BROWSER_TOKEN}" \
  || fail 'loopback Home Assistant gateway WebSocket failed'
if docker exec "${GATEWAY_FIXTURE}" curl \
  --silent --connect-timeout 1 --max-time 2 \
  "http://${APP_CONTAINER}:8099/" >/dev/null 2>&1; then
  fail 'Home Assistant browser gateway was reachable outside app loopback'
fi

docker exec "${APP_CONTAINER}" nginx -t -c /etc/nginx/nginx.conf
docker exec --detach "${APP_CONTAINER}" \
  ttyd \
  --interface 0.0.0.0 \
  --port 17682 \
  --writable \
  --debug 1 \
  /usr/local/bin/web-terminal-entrypoint
wait_for_process "${APP_CONTAINER}" 'ttyd.*--port 17682'
TTYD_PORT=$(docker port "${APP_CONTAINER}" 17682/tcp \
  | head -n1 | sed 's/.*://')
readonly TTYD_PORT
"${PYTHON_BIN}" tests/ttyd_websocket_smoke.py \
  "ws://127.0.0.1:${TTYD_PORT}/ws" \
  || fail 'Ingress recovery terminal WebSocket did not stay connected'

EXPECTED_APP_VERSION=$(docker image inspect \
  --format '{{index .Config.Labels "io.hass.version"}}' "${IMAGE}")
readonly EXPECTED_APP_VERSION
APP_VERSION=$(sed -n \
  's/^version: "\([^"]*\)"/\1/p' antigravity_home_assistant/config.yaml)
readonly APP_VERSION
[[ -n ${APP_VERSION} && ${EXPECTED_APP_VERSION} == "${APP_VERSION}" ]] \
  || fail "image label version ${EXPECTED_APP_VERSION} does not match ${APP_VERSION}"

printf 'docker smoke passed for %s\n' "${TEST_PLATFORM}"
