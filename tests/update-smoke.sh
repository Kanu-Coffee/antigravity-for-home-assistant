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

CANDIDATE_IMAGE=${1:-antigravity-for-home-assistant:test}
TEST_ID="antigravity-ha-update-${RANDOM}-$$"
FIRST_CONTAINER="${TEST_ID}-first"
SECOND_CONTAINER="${TEST_ID}-second"
DATA_VOLUME="${TEST_ID}-data"
CONFIG_VOLUME="${TEST_ID}-config"
MARKER="${TEST_ID}-preserve-marker"

# Git Bash rewrites Linux container paths before invoking native Windows tools.
if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

cleanup() {
  docker rm -f "${FIRST_CONTAINER}" "${SECOND_CONTAINER}" \
    >/dev/null 2>&1 || true
  docker volume rm -f "${DATA_VOLUME}" "${CONFIG_VOLUME}" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf 'update smoke: %s\n' "$*" >&2
  exit 1
}

if ! docker image inspect "${CANDIDATE_IMAGE}" >/dev/null 2>&1; then
  fail "candidate image not found: ${CANDIDATE_IMAGE}"
fi

wait_for_ready() {
  local container=$1
  local attempt

  for ((attempt = 0; attempt < 90; attempt += 1)); do
    if docker logs "${container}" 2>&1 \
      | grep -Fq 'antigravity runtime ready:'; then
      return 0
    fi
    if [[ $(docker inspect --format '{{.State.Running}}' "${container}") != true ]]; then
      docker logs "${container}" >&2 || true
      fail "${container} exited before becoming ready"
    fi
    sleep 1
  done
  docker logs "${container}" >&2 || true
  fail "timed out waiting for ${container}"
}

start_app() {
  local container=$1

  docker run --detach \
    --platform "$TEST_PLATFORM" \
    --name "${container}" \
    --volume "${DATA_VOLUME}:/data" \
    --volume "${CONFIG_VOLUME}:/config" \
    "${CANDIDATE_IMAGE}" >/dev/null
  wait_for_ready "${container}"
}

container_hash() {
  local container=$1
  local path=$2

  docker exec "${container}" sha256sum "${path}" | awk '{print $1}'
}

host_key_fingerprint() {
  local container=$1

  docker exec "${container}" ssh-keygen -E sha256 -lf \
    /data/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'
}

docker volume create "${DATA_VOLUME}" >/dev/null
docker volume create "${CONFIG_VOLUME}" >/dev/null

# Model an existing v1 installation without depending on a mutable or deleted
# registry tag. Both legacy files and already-customized native v2 files must
# survive container replacement while image-managed plugin files may refresh.
docker run --rm --interactive \
  --platform "$TEST_PLATFORM" \
  --env UPDATE_SMOKE_MARKER="${MARKER}" \
  --entrypoint /bin/bash \
  --volume "${DATA_VOLUME}:/data" \
  --volume "${CONFIG_VOLUME}:/config" \
  "${CANDIDATE_IMAGE}" -s <<'SEED'
set -Eeuo pipefail
umask 077
install -d -m 0700 \
  /data/antigravity \
  /data/github-cli \
  /data/home/.gemini/antigravity-cli \
  /data/home/.gemini/config \
  /data/antigravity-ha-memory
jq --null-input \
  --arg marker "${UPDATE_SMOKE_MARKER}" \
  '{
    telegram_enabled: false,
    telegram_bot_token: "",
    telegram_allowed_user_ids: [],
    telegram_allowed_chat_ids: [],
    telegram_access_mode: "confirm_changes",
    authorized_keys: [],
    web_terminal_auto_start_antigravity: false,
    tmux_session_name: "antigravity-ha-update-smoke",
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: true,
    antigravity_user_files_update_mode: "preserve",
    home_assistant_browser_auto_auth: false,
    log_level: "info",
    antigravity_approval_policy: "on-request",
    antigravity_sandbox_mode: "danger-full-access",
    legacy_marker: $marker
  }' > /data/options.json
jq --null-input \
  '{
    colorScheme: "terminal",
    toolPermission: "strict",
    enableTerminalSandbox: true
  }' > /data/home/.gemini/antigravity-cli/settings.json
printf '%s\n' '{"mcpServers":{}}' \
  > /data/home/.gemini/config/mcp_config.json
printf '%s\n' "${UPDATE_SMOKE_MARKER}-legacy-auth" \
  > /data/antigravity/auth.json
printf '%s\n' "${UPDATE_SMOKE_MARKER}-legacy-config" \
  > /data/antigravity/config.toml
printf '%s\n' "${UPDATE_SMOKE_MARKER}-legacy-agents" \
  > /data/antigravity/AGENTS.md
printf '%s\n' "${UPDATE_SMOKE_MARKER}-github" \
  > /data/github-cli/hosts.yml
printf '%s\n' "${UPDATE_SMOKE_MARKER}-memory" \
  > /data/antigravity-ha-memory/update-smoke-marker
printf '%s\n' "${UPDATE_SMOKE_MARKER}-config" \
  > /config/.antigravity-ha-update-smoke-marker
SEED

# A heredoc is not forwarded through `docker run` unless stdin is kept open.
# Validate the named volume independently before attributing a later startup
# failure to the candidate image.
docker run --rm \
  --platform "$TEST_PLATFORM" \
  --entrypoint /bin/sh \
  --volume "${DATA_VOLUME}:/data" \
  "${CANDIDATE_IMAGE}" -ceu '
    test -s /data/options.json
    jq --exit-status '\''type == "object"'\'' /data/options.json >/dev/null
  ' || fail 'seeded App options were not persisted to the update data volume'

start_app "${FIRST_CONTAINER}"

preserved_paths=(
  /data/options.json
  /data/antigravity/auth.json
  /data/antigravity/config.toml
  /data/antigravity/AGENTS.md
  /data/github-cli/hosts.yml
  /data/home/.gemini/antigravity-cli/settings.json
  /data/home/.gemini/config/mcp_config.json
  /data/antigravity-ha-memory/update-smoke-marker
  /config/.antigravity-ha-update-smoke-marker
)
declare -A hashes_before=()
for path in "${preserved_paths[@]}"; do
  hashes_before["${path}"]=$(container_hash "${FIRST_CONTAINER}" "${path}")
done
host_key_before=$(host_key_fingerprint "${FIRST_CONTAINER}")

docker exec "${FIRST_CONTAINER}" test -s \
  /data/antigravity-ha-memory/memory.sqlite3
[[ $(docker exec "${FIRST_CONTAINER}" sqlite3 \
  /data/antigravity-ha-memory/memory.sqlite3 'PRAGMA quick_check;') == ok ]] \
  || fail 'memory database failed integrity validation before restart'
docker exec "${FIRST_CONTAINER}" test -f \
  /data/home/.gemini/config/plugins/home-assistant/plugin.json

# A Home Assistant App update replaces the container while retaining its /data
# and mapped /config volumes. Reusing the candidate here makes this test local,
# deterministic, and independent from mutable external release tags.
docker rm -f "${FIRST_CONTAINER}" >/dev/null
start_app "${SECOND_CONTAINER}"

for path in "${preserved_paths[@]}"; do
  [[ $(container_hash "${SECOND_CONTAINER}" "${path}") == "${hashes_before[${path}]}" ]] \
    || fail "persistent file changed across container replacement: ${path}"
done
[[ $(host_key_fingerprint "${SECOND_CONTAINER}") == "${host_key_before}" ]] \
  || fail 'SSH host key changed across container replacement'
[[ $(docker exec "${SECOND_CONTAINER}" sqlite3 \
  /data/antigravity-ha-memory/memory.sqlite3 'PRAGMA quick_check;') == ok ]] \
  || fail 'memory database failed integrity validation after restart'
docker exec "${SECOND_CONTAINER}" test -f \
  /data/home/.gemini/config/plugins/home-assistant/plugin.json
docker exec "${SECOND_CONTAINER}" jq --exit-status '
  .legacy_marker == $marker
  and .antigravity_approval_policy == "on-request"
  and .antigravity_sandbox_mode == "danger-full-access"
' --arg marker "${MARKER}" /data/options.json >/dev/null \
  || fail 'legacy Home Assistant options were not preserved'
[[ $(docker exec "${SECOND_CONTAINER}" stat -c '%a:%U:%G' \
  /data/home/.gemini/antigravity-cli/settings.json) == 600:root:root ]]
[[ $(docker exec "${SECOND_CONTAINER}" stat -c '%a:%U:%G' \
  /data/home/.gemini/config/mcp_config.json) == 600:root:root ]]
[[ $(docker exec "${SECOND_CONTAINER}" stat -c '%a:%U:%G' \
  /data/github-cli) == 700:root:root ]]

printf 'Local update persistence smoke passed for %s\n' "${CANDIDATE_IMAGE}"
