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
TEST_ID="antigravity-ha-plugin-transaction-${RANDOM}-$$"
DATA_VOLUME="${TEST_ID}-data"

if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

cleanup() {
  docker volume rm -f "${DATA_VOLUME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf 'managed plugin transaction smoke: %s\n' "$*" >&2
  exit 1
}

run_script() {
  local arguments=("$@")
  docker run --rm \
    --interactive \
    --platform "$TEST_PLATFORM" \
    --entrypoint /bin/bash \
    --tmpfs /config:rw,nosuid,nodev,mode=0755 \
    --volume "${DATA_VOLUME}:/data" \
    "${IMAGE}" -s -- "${arguments[@]}"
}

assert_json() {
  local value=$1
  local expression=$2
  printf '%s\n' "${value}" | docker run --rm --interactive \
    --platform "$TEST_PLATFORM" \
    --entrypoint jq \
    "${IMAGE}" --exit-status "${expression}" >/dev/null \
    || fail "JSON assertion failed: ${expression}"
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
docker volume create "${DATA_VOLUME}" >/dev/null

INITIAL_OUTPUT=$(run_script <<'SCRIPT'
  set -Eeuo pipefail
  /usr/bin/env -i \
    AGY_CLI_DISABLE_AUTO_UPDATE=true \
    HOME=/data/home \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    /usr/bin/node \
    /usr/local/share/antigravity-ha/managed-plugin-update.mjs
SCRIPT
) || fail 'initial managed plugin transaction failed'
assert_json "${INITIAL_OUTPUT}" '
  .updated == true
  and .degraded == false
  and .recovered == false
  and .backup_directory == null
'

run_script <<'SCRIPT'
  set -Eeuo pipefail
  jq '.rollback_sentinel = "preserve-old-plugin"' \
    /data/home/.gemini/config/plugins/home-assistant/plugin.json \
    > /tmp/plugin.json
  chmod 0644 /tmp/plugin.json
  mv /tmp/plugin.json \
    /data/home/.gemini/config/plugins/home-assistant/plugin.json
SCRIPT

STAGE_FAILURE_OUTPUT=$(run_script <<'SCRIPT'
  set -Eeuo pipefail
  cp /usr/local/libexec/antigravity-real /tmp/antigravity-real.original
  cat > /usr/local/libexec/antigravity-real <<'WRAPPER'
#!/usr/bin/env bash
if [[ "${1:-}" == plugin && "${2:-}" == validate \
  && "${3:-}" == *'/.home-assistant.stage-'* ]]; then
  exit 71
fi
exec /tmp/antigravity-real.original "$@"
WRAPPER
  chmod 0755 /usr/local/libexec/antigravity-real
  printf '%s\n' '2.0.0-stagefailure' \
    > /usr/local/share/antigravity-ha/app-version
  exec /usr/bin/env -i \
    AGY_CLI_DISABLE_AUTO_UPDATE=true \
    HOME=/data/home \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    /usr/bin/node \
    /usr/local/share/antigravity-ha/managed-plugin-update.mjs
SCRIPT
) || fail 'stage validation failure did not recover the previous plugin'
assert_json "${STAGE_FAILURE_OUTPUT}" '
  .updated == false
  and .degraded == true
  and .recovered == true
  and (.backup_directory | startswith("/data/antigravity-ha/backups/plugin-"))
'
run_script <<'SCRIPT'
  set -Eeuo pipefail
  jq --exit-status '.rollback_sentinel == "preserve-old-plugin"' \
    /data/home/.gemini/config/plugins/home-assistant/plugin.json >/dev/null
  test ! -e /data/antigravity-ha/migration/managed-plugin.json
SCRIPT

if run_script <<'SCRIPT'
  set -Eeuo pipefail
  cp /usr/local/libexec/antigravity-real /tmp/antigravity-real.original
  cat > /usr/local/libexec/antigravity-real <<'WRAPPER'
#!/usr/bin/env bash
target=/data/home/.gemini/config/plugins/home-assistant
if [[ "${1:-}" == plugin && "${2:-}" == validate && "${3:-}" == "${target}" ]] \
  && jq --exit-status \
    '.installed_version == "2.0.0-killrecovery"' \
    "${target}/.antigravity-ha-managed.json" >/dev/null 2>&1; then
  kill -KILL "${PPID}"
  sleep 5
fi
exec /tmp/antigravity-real.original "$@"
WRAPPER
  chmod 0755 /usr/local/libexec/antigravity-real
  printf '%s\n' '2.0.0-killrecovery' \
    > /usr/local/share/antigravity-ha/app-version
  /usr/bin/env -i \
    AGY_CLI_DISABLE_AUTO_UPDATE=true \
    HOME=/data/home \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    /usr/bin/node \
    /usr/local/share/antigravity-ha/managed-plugin-update.mjs
SCRIPT
then
  fail 'kill-point simulation unexpectedly completed'
fi

RECOVERY_OUTPUT=$(run_script <<'SCRIPT'
  set -Eeuo pipefail
  exec /usr/bin/env -i \
    AGY_CLI_DISABLE_AUTO_UPDATE=true \
    HOME=/data/home \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    /usr/bin/node \
    /usr/local/share/antigravity-ha/managed-plugin-update.mjs
SCRIPT
) || fail 'restart did not recover the kill-point transaction'
assert_json "${RECOVERY_OUTPUT}" '
  .updated == false
  and .degraded == false
  and .recovered == true
'
run_script <<'SCRIPT'
  set -Eeuo pipefail
  jq --exit-status '.rollback_sentinel == "preserve-old-plugin"' \
    /data/home/.gemini/config/plugins/home-assistant/plugin.json >/dev/null
  test ! -e /data/antigravity-ha/migration/managed-plugin.json
SCRIPT

POSTCONDITION_OUTPUT=$(run_script <<'SCRIPT'
  set -Eeuo pipefail
  cp /usr/local/libexec/antigravity-real /tmp/antigravity-real.original
  cat > /usr/local/libexec/antigravity-real <<'WRAPPER'
#!/usr/bin/env bash
target=/data/home/.gemini/config/plugins/home-assistant
if [[ "${1:-}" == plugin && "${2:-}" == validate && "${3:-}" == "${target}" ]] \
  && jq --exit-status \
    '.installed_version == "2.0.0-postconditionfailure"' \
    "${target}/.antigravity-ha-managed.json" >/dev/null 2>&1; then
  exit 72
fi
exec /tmp/antigravity-real.original "$@"
WRAPPER
  chmod 0755 /usr/local/libexec/antigravity-real
  printf '%s\n' '2.0.0-postconditionfailure' \
    > /usr/local/share/antigravity-ha/app-version
  exec /usr/bin/env -i \
    AGY_CLI_DISABLE_AUTO_UPDATE=true \
    HOME=/data/home \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    /usr/bin/node \
    /usr/local/share/antigravity-ha/managed-plugin-update.mjs
SCRIPT
) || fail 'postcondition failure did not restore the previous plugin'
assert_json "${POSTCONDITION_OUTPUT}" '
  .updated == false
  and .degraded == true
  and .recovered == true
'
POSTCONDITION_BACKUP=$(jq --raw-output '.backup_directory' \
  <<< "${POSTCONDITION_OUTPUT}")
run_script "${POSTCONDITION_BACKUP}" <<'SCRIPT'
  set -Eeuo pipefail
  backup=$1
  jq --exit-status '.rollback_sentinel == "preserve-old-plugin"' \
    /data/home/.gemini/config/plugins/home-assistant/plugin.json >/dev/null
  test ! -e /data/antigravity-ha/migration/managed-plugin.json
  test "$(stat -c '%a:%U:%G' "${backup}")" = 700:root:root
  test "$(stat -c '%a:%U:%G' "${backup}/manifest.json")" = 600:root:root
  test -d "${backup}/plugin.before"
  jq --exit-status '
    .schema == 1
    and .owner == "antigravity-for-home-assistant"
    and .source_version == "2.0.1"
    and .target_version == "2.0.0-postconditionfailure"
    and .target == "/data/home/.gemini/config/plugins/home-assistant"
    and (.before.tree_sha256 | test("^[0-9a-f]{64}$"))
    and (.candidate.tree_sha256 | test("^[0-9a-f]{64}$"))
    and (.before.entries | all(
      has("path") and has("mode") and has("size") and has("sha256")
    ))
    and (.candidate.entries | all(
      has("path") and has("mode") and has("size") and has("sha256")
    ))
  ' "${backup}/manifest.json" >/dev/null
SCRIPT

printf 'managed plugin transaction smoke: PASS\n'
