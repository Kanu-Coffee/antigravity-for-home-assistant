#!/usr/bin/env bash
set -Eeuo pipefail

readonly TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}
case "${TEST_PLATFORM}" in
  linux/amd64)
    readonly EXPECTED_HA_ARCH=amd64
    readonly PUBLIC_2_1_3_DIGEST=sha256:62437e374c523af3d0a0549abf1874b07ef95c7cab7c7935758faff664d98e3a
    ;;
  linux/arm64)
    readonly EXPECTED_HA_ARCH=aarch64
    readonly PUBLIC_2_1_3_DIGEST=sha256:980cf09746368bbf329a49e060f94dba36f60fd7337141ac57babcc3c9d3cd55
    ;;
  *)
    printf 'unsupported TEST_PLATFORM: %s\n' "${TEST_PLATFORM}" >&2
    exit 64
    ;;
esac
readonly HA_ARCH=${HA_ARCH:-${EXPECTED_HA_ARCH}}
[[ ${HA_ARCH} == "${EXPECTED_HA_ARCH}" ]] || exit 64
export HA_ARCH TEST_PLATFORM

readonly CANDIDATE_IMAGE=${1:-antigravity-for-home-assistant:test}
readonly PUBLIC_2_1_3_IMAGE="ghcr.io/kanu-coffee/antigravity-for-home-assistant@${PUBLIC_2_1_3_DIGEST}"
readonly PUBLIC_2_1_3_REVISION=a8cee9a70b445a9ce66dc2489e3643a9e135bcfa
readonly TEST_ID="antigravity-ha-v3-upgrade-${RANDOM}-${RANDOM}-$$"
readonly DATA_VOLUME="${TEST_ID}-data"
readonly CONFIG_VOLUME="${TEST_ID}-config"
readonly SHARE_VOLUME="${TEST_ID}-share"
readonly MEDIA_VOLUME="${TEST_ID}-media"
readonly FIRST_CONTAINER="${TEST_ID}-first"
readonly SECOND_CONTAINER="${TEST_ID}-second"
readonly LEGACY_MARKER="${TEST_ID}-legacy-must-be-removed"
readonly PRESERVED_MARKER="${TEST_ID}-outside-reset-boundary"
readonly V3_MARKER="${TEST_ID}-v3-must-persist"

cleanup() {
  docker rm -f "${FIRST_CONTAINER}" "${SECOND_CONTAINER}" \
    >/dev/null 2>&1 || true
  docker volume rm -f \
    "${DATA_VOLUME}" "${CONFIG_VOLUME}" "${SHARE_VOLUME}" "${MEDIA_VOLUME}" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf '3.0 upgrade smoke: %s\n' "$*" >&2
  for container in "${FIRST_CONTAINER}" "${SECOND_CONTAINER}"; do
    docker logs "${container}" 2>/dev/null || true
  done
  exit 1
}

run_bounded() {
  timeout --foreground --signal=TERM --kill-after=5s 120s "$@"
}

wait_for_ready() {
  local container=$1
  local attempt
  local logs

  for ((attempt = 0; attempt < 120; attempt += 1)); do
    logs=$(docker logs "${container}" 2>&1 || true)
    if grep -Eq 'Antigravity [0-9]+\.[0-9]+\.[0-9]+ runtime ready' \
      <<< "${logs}"; then
      return 0
    fi
    if [[ $(docker inspect --format '{{.State.Running}}' "${container}" \
      2>/dev/null || true) != true ]]; then
      fail "${container} exited before initialization completed"
    fi
    sleep 1
  done
  fail "${container} did not become ready"
}

start_candidate() {
  local container=$1
  run_bounded docker run --detach \
    --platform "${TEST_PLATFORM}" \
    --name "${container}" \
    --volume "${DATA_VOLUME}:/data" \
    --volume "${CONFIG_VOLUME}:/config" \
    --volume "${SHARE_VOLUME}:/share" \
    --volume "${MEDIA_VOLUME}:/media" \
    "${CANDIDATE_IMAGE}" >/dev/null
  wait_for_ready "${container}"
}

run_bounded docker image inspect "${CANDIDATE_IMAGE}" >/dev/null \
  || fail "candidate image not found: ${CANDIDATE_IMAGE}"
run_bounded docker pull --platform "${TEST_PLATFORM}" \
  "${PUBLIC_2_1_3_IMAGE}" >/dev/null \
  || fail 'could not pull the immutable public 2.1.3 image'

[[ $(run_bounded docker run --rm --platform "${TEST_PLATFORM}" \
  --entrypoint /bin/cat "${PUBLIC_2_1_3_IMAGE}" \
  /usr/local/share/antigravity-ha/app-version) == 2.1.3 ]] \
  || fail 'the pinned public upgrade source is not App 2.1.3'
[[ $(run_bounded docker image inspect --format \
  '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "${PUBLIC_2_1_3_IMAGE}") == "${PUBLIC_2_1_3_REVISION}" ]] \
  || fail 'the public 2.1.3 image revision is unexpected'

run_bounded docker volume create "${DATA_VOLUME}" >/dev/null
run_bounded docker volume create "${CONFIG_VOLUME}" >/dev/null
run_bounded docker volume create "${SHARE_VOLUME}" >/dev/null
run_bounded docker volume create "${MEDIA_VOLUME}" >/dev/null

# Seed every historical App-owned root using the exact public 2.1.3 image as
# the fixture environment. The candidate must remove these roots once while
# leaving Supervisor-owned options and mapped Home Assistant configuration.
run_bounded docker run --rm --interactive \
  --platform "${TEST_PLATFORM}" \
  --env LEGACY_MARKER="${LEGACY_MARKER}" \
  --env PRESERVED_MARKER="${PRESERVED_MARKER}" \
  --entrypoint /bin/bash \
  --volume "${DATA_VOLUME}:/data" \
  --volume "${CONFIG_VOLUME}:/config" \
  --volume "${SHARE_VOLUME}:/share" \
  --volume "${MEDIA_VOLUME}:/media" \
  "${PUBLIC_2_1_3_IMAGE}" -s <<'SEED'
set -Eeuo pipefail
umask 077
for directory in \
  home antigravity antigravity-ha antigravity-ha-memory browser-auth \
  github-cli ssh tmux; do
  install -d -m 0700 "/data/${directory}"
  printf '%s\n' "${LEGACY_MARKER}" > "/data/${directory}/legacy-marker"
done
printf '%s\n' "${LEGACY_MARKER}" \
  > /data/home/.legacy-customization
install -d -m 0700 /data/home/.gemini
printf '%s\n' "${LEGACY_MARKER}" \
  > /data/home/.gemini/jetski-standalone-oauth-token
chmod 0600 /data/home/.gemini/jetski-standalone-oauth-token
jq --null-input --arg marker "${PRESERVED_MARKER}" '{
  obsolete_channel_enabled: true,
  obsolete_approval_mode: "retired",
  legacy_marker: $marker
}' > /data/options.json
install -d -m 0755 /config
install -d -m 0755 /share /media
printf '%s\n' "${PRESERVED_MARKER}" > /config/v3-upgrade-preserve-marker
printf '%s\n' "${PRESERVED_MARKER}" > /share/v3-upgrade-preserve-marker
printf '%s\n' "${PRESERVED_MARKER}" > /media/v3-upgrade-preserve-marker
SEED

start_candidate "${FIRST_CONTAINER}"

docker exec "${FIRST_CONTAINER}" jq --exit-status \
  --arg marker "${PRESERVED_MARKER}" '.legacy_marker == $marker' \
  /data/options.json >/dev/null \
  || fail 'Supervisor-owned options.json was deleted or rewritten locally'
[[ $(docker exec "${FIRST_CONTAINER}" cat \
  /config/v3-upgrade-preserve-marker) == "${PRESERVED_MARKER}" ]] \
  || fail '/config was not preserved by the 3.0 reset'
[[ $(docker exec "${FIRST_CONTAINER}" cat \
  /share/v3-upgrade-preserve-marker) == "${PRESERVED_MARKER}" ]] \
  || fail '/share was not preserved by the 3.0 reset'
[[ $(docker exec "${FIRST_CONTAINER}" cat \
  /media/v3-upgrade-preserve-marker) == "${PRESERVED_MARKER}" ]] \
  || fail '/media was not preserved by the 3.0 reset'
docker exec "${FIRST_CONTAINER}" test ! -e /data/ssh \
  || fail 'a retired App-owned root was recreated'
docker exec "${FIRST_CONTAINER}" test ! -e \
  /data/home/.legacy-customization \
  || fail 'legacy Antigravity HOME survived the 3.0 reset'
docker exec "${FIRST_CONTAINER}" test ! -e \
  /data/home/.gemini/jetski-standalone-oauth-token \
  || fail 'legacy Antigravity Remote authentication survived the 3.0 reset'
[[ -z $(docker exec "${FIRST_CONTAINER}" find /data -xdev \
  -name legacy-marker -print -quit) ]] \
  || fail 'at least one legacy App-owned root survived the 3.0 reset'
docker exec "${FIRST_CONTAINER}" /bin/bash -ceu '
  for root in /data /config /share /media; do
    if grep --recursive --binary-files=text --fixed-strings --quiet \
      -- "$1" "$root"; then
      exit 1
    fi
  done
' -- "${LEGACY_MARKER}" \
  || fail 'the 3.0 reset created a persistent backup of retired App data'
docker exec "${FIRST_CONTAINER}" jq --exit-status '
  .schema == "antigravity-ha-v3-factory-reset/v1"
  and .completed == true
' /data/.antigravity-ha-v3-reset-complete.json >/dev/null \
  || fail 'the one-time reset completion marker is invalid'
[[ $(docker exec "${FIRST_CONTAINER}" stat -c '%a:%U:%G' \
  /data/.antigravity-ha-v3-reset-complete.json) == 600:root:root ]] \
  || fail 'the reset completion marker metadata is unsafe'
docker exec "${FIRST_CONTAINER}" test ! -e \
  /data/.antigravity-ha-v3-options-complete.json \
  || fail 'option reset was falsely marked complete without Supervisor'
docker exec "${FIRST_CONTAINER}" jq --exit-status '
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
  || fail 'the runtime did not ignore unreset 2.x options'

docker exec "${FIRST_CONTAINER}" /bin/bash -ceu '
  printf "%s\n" "$1" > /data/home/.v3-persistence-marker
  printf "%s\n" "$1" > /config/v3-restart-marker
' -- "${V3_MARKER}"
docker rm -f "${FIRST_CONTAINER}" >/dev/null
start_candidate "${SECOND_CONTAINER}"

[[ $(docker exec "${SECOND_CONTAINER}" cat \
  /data/home/.v3-persistence-marker) == "${V3_MARKER}" ]] \
  || fail 'the completed reset repeated on the next App start'
[[ $(docker exec "${SECOND_CONTAINER}" cat \
  /config/v3-restart-marker) == "${V3_MARKER}" ]] \
  || fail '/config did not persist across App restart'
[[ $(docker exec "${SECOND_CONTAINER}" cat \
  /share/v3-upgrade-preserve-marker) == "${PRESERVED_MARKER}" ]] \
  || fail '/share did not persist across App restart'
[[ $(docker exec "${SECOND_CONTAINER}" cat \
  /media/v3-upgrade-preserve-marker) == "${PRESERVED_MARKER}" ]] \
  || fail '/media did not persist across App restart'
docker exec "${SECOND_CONTAINER}" test ! -e /data/ssh \
  || fail 'a retired App-owned root returned after restart'

printf '3.0 upgrade smoke passed for %s\n' "${TEST_PLATFORM}"
