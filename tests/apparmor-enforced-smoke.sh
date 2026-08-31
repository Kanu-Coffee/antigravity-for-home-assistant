#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${1:-antigravity-for-home-assistant:test}
TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}
case "${TEST_PLATFORM}" in
  linux/amd64) EXPECTED_IMAGE_ARCH=amd64 ;;
  linux/arm64) EXPECTED_IMAGE_ARCH=arm64 ;;
  *) printf 'unsupported TEST_PLATFORM: %s\n' "${TEST_PLATFORM}" >&2; exit 64 ;;
esac

readonly SOURCE_PROFILE=antigravity_home_assistant/apparmor.txt
readonly TEST_ID="antigravity-ha-apparmor-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${RANDOM}-$$"
readonly PROFILE_NAME="antigravity_home_assistant_ci_${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-0}_${RANDOM}_$$"
readonly CONTAINER="${TEST_ID}-app"
readonly DATA_VOLUME="${TEST_ID}-data"
readonly CONFIG_VOLUME="${TEST_ID}-config"
readonly SHARE_VOLUME="${TEST_ID}-share"
readonly MEDIA_VOLUME="${TEST_ID}-media"
readonly TOKEN_VOLUME="${TEST_ID}-token"
readonly SUPERVISOR_TOKEN=apparmor-enforced-smoke-token-do-not-use
WORK_DIR=$(mktemp -d)
readonly WORK_DIR
readonly RENDERED_PROFILE="${WORK_DIR}/apparmor.profile"
PROFILE_LOADED=false

redact() {
  sed "s/${SUPERVISOR_TOKEN}/[REDACTED_HOME_ASSISTANT_TOKEN]/g"
}

profile_names() {
  sed -n -E 's/^[[:space:]]*profile ([^[:space:]]+).*/\1/p' \
    "${RENDERED_PROFILE}"
}

fail() {
  printf 'AppArmor enforced smoke: %s\n' "$*" >&2
  if docker inspect "${CONTAINER}" >/dev/null 2>&1; then
    docker logs "${CONTAINER}" 2>&1 | redact >&2 || true
  fi
  exit 1
}

cleanup() {
  local status=$?
  trap - EXIT
  docker rm --force "${CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm --force \
    "${DATA_VOLUME}" "${CONFIG_VOLUME}" "${SHARE_VOLUME}" \
    "${MEDIA_VOLUME}" "${TOKEN_VOLUME}" >/dev/null 2>&1 || true
  if [[ ${PROFILE_LOADED} == true ]]; then
    sudo -n apparmor_parser --remove --skip-cache "${RENDERED_PROFILE}" \
      >/dev/null 2>&1 || true
  fi
  rm -rf -- "${WORK_DIR}"
  exit "${status}"
}
trap cleanup EXIT

require_enforcement_host() {
  [[ $(uname -s) == Linux ]] \
    || fail 'the required Linux AppArmor host is unavailable'
  [[ -r /sys/module/apparmor/parameters/enabled ]] \
    || fail 'the AppArmor kernel module status is unavailable'
  [[ $(< /sys/module/apparmor/parameters/enabled) == Y ]] \
    || fail 'the AppArmor kernel module is not enabled'
  command -v apparmor_parser >/dev/null 2>&1 \
    || fail 'apparmor_parser is not installed'
  command -v python3 >/dev/null 2>&1 \
    || fail 'python3 is required to render the disposable profile'
  sudo -n true >/dev/null 2>&1 \
    || fail 'passwordless sudo is required to load the kernel AppArmor profile'
  docker info --format '{{json .SecurityOptions}}' \
    | grep -Fq 'name=apparmor' \
    || fail 'Docker does not advertise AppArmor enforcement'
}

render_collision_safe_profile() {
  python3 - "${SOURCE_PROFILE}" "${RENDERED_PROFILE}" "${PROFILE_NAME}" <<'PY'
from pathlib import Path
import re
import sys

source_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
profile_name = sys.argv[3]
source = source_path.read_text(encoding="utf-8")
primary = re.findall(r"^profile ([^ ]+)", source, flags=re.MULTILINE)
if primary != ["antigravity_home_assistant"]:
    raise SystemExit(f"unexpected primary AppArmor declarations: {primary!r}")
declarations = re.findall(
    r"^[ ]*profile ([^ ]+)", source, flags=re.MULTILINE
)
if len(declarations) != 17:
    raise SystemExit(f"unexpected v3 AppArmor profile set: {declarations!r}")
rendered = re.sub(
    r"^profile antigravity_home_assistant(?= )",
    f"profile {profile_name}",
    source,
    count=1,
    flags=re.MULTILINE,
)
output_path.write_text(rendered, encoding="utf-8")
output_path.chmod(0o600)
PY
}

assert_profiles_absent() {
  local name
  while IFS= read -r name; do
    if sudo -n cut -d ' ' -f 1 /sys/kernel/security/apparmor/profiles \
      | grep -Fqx "${name}"; then
      fail "generated profile label already exists: ${name}"
    fi
  done < <(profile_names)
}

load_and_verify_profiles() {
  sudo -n apparmor_parser --replace --skip-cache "${RENDERED_PROFILE}"
  PROFILE_LOADED=true

  local name
  while IFS= read -r name; do
    sudo -n grep -Fqx "${name} (enforce)" \
      /sys/kernel/security/apparmor/profiles \
      || fail "profile was not loaded in enforce mode: ${name}"
  done < <(profile_names)
}

seed_volumes() {
  local volume
  for volume in \
    "${DATA_VOLUME}" "${CONFIG_VOLUME}" "${SHARE_VOLUME}" \
    "${MEDIA_VOLUME}" "${TOKEN_VOLUME}"; do
    docker volume create "${volume}" >/dev/null
  done

  printf '%s\n' \
    '{"remote_control_name":"home-assistant","antigravity_sensitive_data_access":false,"home_assistant_browser_auto_auth":false,"log_level":"info"}' \
    | docker run --rm --interactive \
      --platform "${TEST_PLATFORM}" \
      --entrypoint /bin/sh \
      --volume "${DATA_VOLUME}:/data" \
      "${IMAGE}" \
      -c 'umask 077; cat > /data/options.json'

  printf '%s\n' 'apparmor-denial-canary-no-secret' \
    | docker run --rm --interactive \
      --platform "${TEST_PLATFORM}" \
      --entrypoint /bin/sh \
      --volume "${CONFIG_VOLUME}:/config" \
      "${IMAGE}" \
      -c 'cat > /config/secrets.yaml; chmod 0644 /config/secrets.yaml'

  docker run --rm \
    --platform "${TEST_PLATFORM}" \
    --entrypoint /bin/sh \
    --volume "${TOKEN_VOLUME}:/data" \
    "${IMAGE}" \
    -c 'set -eu
      install -d -m 0700 /data/home/.gemini
      printf "%s\n" remote-token-denial-canary \
        > /data/home/.gemini/jetski-standalone-oauth-token
      chmod 0600 /data/home/.gemini/jetski-standalone-oauth-token'
}

wait_for_log() {
  local pattern=$1
  local attempts=90
  local logs

  while (( attempts > 0 )); do
    logs=$(docker logs "${CONTAINER}" 2>&1 || true)
    if grep -Fq -- "${pattern}" <<< "${logs}"; then
      return 0
    fi
    if [[ $(docker inspect --format '{{.State.Running}}' "${CONTAINER}") != true ]]; then
      printf '%s\n' "${logs}" | redact >&2
      fail "container exited while waiting for: ${pattern}"
    fi
    sleep 1
    (( attempts -= 1 ))
  done
  fail "timed out waiting for: ${pattern}"
}

start_and_verify_app() {
  docker run --detach \
    --platform "${TEST_PLATFORM}" \
    --name "${CONTAINER}" \
    --security-opt "apparmor=${PROFILE_NAME}" \
    --env "SUPERVISOR_TOKEN=${SUPERVISOR_TOKEN}" \
    --volume "${DATA_VOLUME}:/data" \
    --volume "${CONFIG_VOLUME}:/config" \
    --volume "${SHARE_VOLUME}:/share" \
    --volume "${MEDIA_VOLUME}:/media" \
    "${IMAGE}" >/dev/null

  wait_for_log ' runtime ready'
  wait_for_log 'Starting Antigravity Remote Control service'
  wait_for_log 'Antigravity Remote Control is waiting for ha-antigravity-remote-login.'
  wait_for_log 'Starting the isolated Home Assistant read broker'
  wait_for_log 'Starting the authenticated Ingress reverse proxy'
  wait_for_log 'Starting ttyd on the loopback interface'

  local current_profile
  current_profile=$(docker exec "${CONTAINER}" /bin/cat /proc/1/attr/current)
  [[ ${current_profile} == "${PROFILE_NAME} (enforce)" ]] \
    || fail "PID 1 is not confined by the expected profile: ${current_profile}"

  if docker exec "${CONTAINER}" /bin/cat /config/secrets.yaml \
    >/dev/null 2>&1; then
    fail 'the enforced primary profile read the secret denial canary'
  fi
}

verify_remote_token_denial() {
  docker run --rm \
    --platform "${TEST_PLATFORM}" \
    --security-opt apparmor=unconfined \
    --entrypoint /usr/bin/cat \
    --volume "${TOKEN_VOLUME}:/data:ro" \
    "${IMAGE}" \
    /data/home/.gemini/jetski-standalone-oauth-token >/dev/null \
    || fail 'the unconfined Remote token control could not read its fixture'

  local profile
  for profile in \
    antigravity_home_assistant-command \
    antigravity_home_assistant-ha-helper \
    antigravity_home_assistant-read-broker-bootstrap \
    antigravity_home_assistant-file-client \
    antigravity_home_assistant-memory \
    antigravity_home_assistant-browser \
    antigravity_home_assistant-shell; do
    if docker run --rm \
      --platform "${TEST_PLATFORM}" \
      --security-opt "apparmor=${profile}" \
      --entrypoint /usr/bin/cat \
      --volume "${TOKEN_VOLUME}:/data:ro" \
      "${IMAGE}" \
      /data/home/.gemini/jetski-standalone-oauth-token \
      >/dev/null 2>&1; then
      fail "${profile} read the native-only Remote token"
    fi
  done
}

require_enforcement_host
[[ -f ${SOURCE_PROFILE} ]] || fail "missing source policy: ${SOURCE_PROFILE}"
docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
[[ $(docker image inspect --format '{{.Architecture}}' "${IMAGE}") == \
  "${EXPECTED_IMAGE_ARCH}" ]] \
  || fail "image architecture does not match ${TEST_PLATFORM}"

render_collision_safe_profile
assert_profiles_absent
load_and_verify_profiles
seed_volumes
start_and_verify_app
verify_remote_token_denial

printf 'AppArmor v3 enforced smoke passed for %s (%s); real HAOS remains NOT RUN\n' \
  "${IMAGE}" "${TEST_PLATFORM}"
