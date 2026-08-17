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
TEST_ID="antigravity-ha-browser-approval-${RANDOM}-$$"
CONTAINERS=()

READ_ONLY_TOOLS=(
  browser_console_messages
  browser_network_requests
  browser_snapshot
  browser_take_screenshot
)
NON_READ_ONLY_TOOLS=(
  browser_close
  browser_hover
  browser_navigate
  browser_navigate_back
  browser_resize
  browser_tabs
  browser_wait_for
  browser_click
  browser_fill_form
  browser_press_key
  browser_select_option
  browser_type
)

# Git Bash rewrites Linux container paths before invoking native Windows programs.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

cleanup() {
  if (( ${#CONTAINERS[@]} > 0 )); then
    docker rm -f "${CONTAINERS[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  printf 'browser approval smoke: %s\n' "$*" >&2
  exit 1
}

seed_wrapper_options() {
  local name=$1
  local terminal_sandbox=$2

  printf '{"antigravity_terminal_sandbox":%s,"antigravity_sensitive_data_access":false}' \
    "${terminal_sandbox}" \
    | docker exec --interactive "${name}" /bin/sh -c '
      umask 077
      snapshot=$(mktemp /run/antigravity-ha/.ha-feedback-options.XXXXXX)
      cat > "${snapshot}"
      chmod 0600 "${snapshot}"
      mv -f "${snapshot}" /run/antigravity-ha/ha-feedback-options.json
    '
}

start_probe() {
  local name=$1
  local options_json=$2

  docker create \
    --platform "$TEST_PLATFORM" \
    --name "${name}" \
    --entrypoint /bin/sleep \
    "${IMAGE}" infinity >/dev/null
  CONTAINERS+=("${name}")
  docker start "${name}" >/dev/null
  docker exec "${name}" /bin/sh -c \
    'install -d -m 0700 /run/antigravity-ha /data/home /data/antigravity; install -d -m 0755 /config'
  printf '%s' "${options_json}" \
    | docker exec --interactive "${name}" /bin/sh -c \
      'umask 077; cat > /data/options.json'
  seed_wrapper_options "${name}" true
}

settings_path=/data/home/.gemini/antigravity-cli/settings.json
mcp_path=/data/home/.gemini/config/mcp_config.json

permission_is_present() {
  local name=$1
  local bucket=$2
  local tool=$3

  docker exec "${name}" jq --exit-status \
    --arg bucket "${bucket}" \
    --arg permission "mcp(playwright/${tool})" \
    '(.permissions[$bucket] | index($permission)) != null' \
    "${settings_path}" >/dev/null
}

assert_permission_bucket() {
  local name=$1
  local expected_bucket=$2
  local tool=$3
  local other_bucket=ask

  if [[ "${expected_bucket}" == ask ]]; then
    other_bucket=allow
  fi
  permission_is_present "${name}" "${expected_bucket}" "${tool}" \
    || fail "${tool} was not in settings.permissions.${expected_bucket}"
  if permission_is_present "${name}" "${other_bucket}" "${tool}"; then
    fail "${tool} was unexpectedly in settings.permissions.${other_bucket}"
  fi
}

probe_policy() {
  local policy=$1
  local _effective_policy=$2
  local options_json
  local name="${TEST_ID}-${policy}"
  local tool

  if [[ "${policy}" == missing ]]; then
    options_json='{}'
  else
    options_json="{\"browser_approval_policy\":\"${policy}\"}"
  fi
  start_probe "${name}" "${options_json}"
  docker exec "${name}" antigravity-user-files-update >/dev/null \
    || fail "native settings generation rejected ${policy}"

  [[ $(docker exec "${name}" stat -c '%a:%U:%G' "${settings_path}") \
    == 600:root:root ]] \
    || fail "${policy} settings.json mode or owner is unsafe"
  [[ $(docker exec "${name}" stat -c '%a:%U:%G' "${mcp_path}") \
    == 600:root:root ]] \
    || fail "${policy} mcp_config.json mode or owner is unsafe"
  docker exec "${name}" jq --exit-status '.mcpServers == {}' "${mcp_path}" \
    >/dev/null || fail 'global MCP configuration was not kept empty'
  docker exec "${name}" jq --exit-status \
    '.permissions.deny | index("read_file(/config/secrets.yaml)") != null' \
    "${settings_path}" >/dev/null \
    || fail 'native settings did not protect Home Assistant secrets'

  for tool in "${READ_ONLY_TOOLS[@]}"; do
    assert_permission_bucket "${name}" allow "${tool}"
  done
  for tool in "${NON_READ_ONLY_TOOLS[@]}"; do
    if permission_is_present "${name}" allow "${tool}" \
      || permission_is_present "${name}" ask "${tool}"; then
      fail "${tool} was not kept fail-closed"
    fi
  done
}

assert_invalid_policy() {
  local suffix=$1
  local options_json=$2
  local name="${TEST_ID}-${suffix}"
  local status

  start_probe "${name}" "${options_json}"
  set +e
  docker exec "${name}" antigravity-user-files-update >/dev/null 2>&1
  status=$?
  set -e
  [[ "${status}" -eq 20 ]] \
    || fail "${suffix} returned ${status}, expected 20"
}

probe_policy missing safe
MISSING_SETTINGS=$(docker exec "${TEST_ID}-missing" sha256sum "${settings_path}" \
  | awk '{print $1}')
probe_policy safe safe
SAFE_SETTINGS=$(docker exec "${TEST_ID}-safe" sha256sum "${settings_path}" \
  | awk '{print $1}')
[[ "${MISSING_SETTINGS}" == "${SAFE_SETTINGS}" ]] \
  || fail 'missing policy did not match the explicit safe policy'
probe_policy never safe
NEVER_SETTINGS=$(docker exec "${TEST_ID}-never" sha256sum "${settings_path}" \
  | awk '{print $1}')
probe_policy always safe
ALWAYS_SETTINGS=$(docker exec "${TEST_ID}-always" sha256sum "${settings_path}" \
  | awk '{print $1}')
[[ "${NEVER_SETTINGS}" == "${SAFE_SETTINGS}" \
  && "${ALWAYS_SETTINGS}" == "${SAFE_SETTINGS}" ]] \
  || fail 'legacy browser approval modes changed the v3 default-allow policy'

docker cp tests/fake-antigravity-real.sh \
  "${TEST_ID}-safe:/usr/local/libexec/antigravity-real" >/dev/null
docker exec "${TEST_ID}-safe" chmod 0755 /usr/local/libexec/antigravity-real
WRAPPER_OUTPUT=$(docker exec --workdir /config "${TEST_ID}-safe" \
  antigravity __probe__ passthrough-value)
[[ $(grep -Fxc 'ARG=<__probe__>' <<< "${WRAPPER_OUTPUT}" || true) -eq 1 ]]
[[ $(grep -Fxc 'ARG=<passthrough-value>' <<< "${WRAPPER_OUTPUT}" || true) -eq 1 ]]
[[ $(grep -Ec '^ARG=<-{1,2}(no-)?sandbox(=.*)?>$' \
  <<< "${WRAPPER_OUTPUT}" || true) -eq 0 ]] \
  || fail 'wrapper injected a native sandbox override'
[[ $(grep -Fxc 'ARG=<-c>' <<< "${WRAPPER_OUTPUT}" || true) -eq 0 ]] \
  || fail 'wrapper injected the legacy Codex -c option'
for sandbox_override in \
  --sandbox \
  -sandbox \
  --sandbox=true \
  -sandbox=true \
  --sandbox=false \
  -sandbox=false \
  --sandbox=TRUE \
  -sandbox=1 \
  --no-sandbox \
  --no-sandbox=true \
  -no-sandbox \
  -no-sandbox=false; do
  set +e
  docker exec --workdir /config "${TEST_ID}-safe" \
    antigravity "${sandbox_override}" >/tmp/sandbox.out 2>/tmp/sandbox.err
  sandbox_status=$?
  set -e
  [[ "${sandbox_status}" -eq 78 ]] \
    || fail "wrapper returned ${sandbox_status} for ${sandbox_override}, expected 78"
done
unset sandbox_override sandbox_status
for dangerous_argument in \
  --dangerously-skip-permissions \
  --dangerously-skip-permissions=true \
  --dangerously-skip-permissions=false \
  -dangerously-skip-permissions \
  -dangerously-skip-permissions=true \
  -dangerously-skip-permissions=false; do
  if docker exec --workdir /config "${TEST_ID}-safe" \
    antigravity "${dangerous_argument}" >/dev/null 2>&1; then
    fail "wrapper accepted ${dangerous_argument}"
  fi
done
unset dangerous_argument
docker exec "${TEST_ID}-safe" /bin/sh -c '
  jq ".antigravity_terminal_sandbox = false" /data/options.json > /tmp/options.json
  chmod 0600 /tmp/options.json
  mv /tmp/options.json /data/options.json
'
RAW_OPTIONS_OUTPUT=$(docker exec --workdir /config "${TEST_ID}-safe" \
  antigravity __probe__)
[[ $(grep -Ec '^ARG=<-{1,2}(no-)?sandbox(=.*)?>$' \
  <<< "${RAW_OPTIONS_OUTPUT}" || true) -eq 0 ]] \
  || fail 'raw options injected a native sandbox override'
seed_wrapper_options "${TEST_ID}-safe" false
NO_SANDBOX_OUTPUT=$(docker exec --workdir /config "${TEST_ID}-safe" \
  antigravity __probe__)
[[ $(grep -Ec '^ARG=<-{1,2}(no-)?sandbox(=.*)?>$' \
  <<< "${NO_SANDBOX_OUTPUT}" || true) -eq 0 ]] \
  || fail 'safe snapshot injected a native sandbox override'
docker exec "${TEST_ID}-safe" /bin/sh -c '
  jq ".antigravity_terminal_sandbox = true" /data/options.json > /tmp/options.json
  chmod 0600 /tmp/options.json
  mv /tmp/options.json /data/options.json
'
set +e
docker exec --workdir /config "${TEST_ID}-safe" \
  antigravity --sandbox __probe__ >/tmp/explicit.out 2>/tmp/explicit.err
explicit_status=$?
set -e
[[ "${explicit_status}" -eq 78 ]] \
  || fail "wrapper returned ${explicit_status} for explicit --sandbox, expected 78"

assert_invalid_policy invalid-enum \
  '{"browser_approval_policy":"unexpected"}'
assert_invalid_policy invalid-type \
  '{"browser_approval_policy":42}'

printf 'Browser approval policy smoke passed: %s\n' "${IMAGE}"
