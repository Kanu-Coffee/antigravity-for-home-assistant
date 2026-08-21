#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${1:-antigravity-for-home-assistant:test}
TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}
case "${TEST_PLATFORM}" in
  linux/amd64 | linux/arm64) ;;
  *) printf 'unsupported TEST_PLATFORM: %s\n' "${TEST_PLATFORM}" >&2; exit 64 ;;
esac

SCRIPT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIRECTORY
readonly STUB=${SCRIPT_DIRECTORY}/fixtures/onboarding-controller-stub.sh
readonly TEST_ID="antigravity-ha-onboarding-controller-${RANDOM}-$$"
VOLUMES=()

fail() {
  printf 'onboarding controller smoke: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if (( ${#VOLUMES[@]} > 0 )); then
    docker volume rm --force "${VOLUMES[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

inspect_case() {
  local case_name=$1
  local data_volume=$2
  local runtime_volume=$3
  local expected_status=$4

  docker run --rm \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /bin/bash \
    --volume "${data_volume}:/data" \
    --volume "${runtime_volume}:/run/antigravity-ha" \
    "${IMAGE}" -p -ceu '
      case_name=$1
      expected_status=$2
      settings=/data/home/.gemini/antigravity-cli/settings.json
      cache=/data/home/.gemini/antigravity-cli/cache
      marker=/run/antigravity-ha/onboarding-active
      staging=/run/antigravity-ha/onboarding-home

      test "$(stat -Lc "%u:%g:%a:%h:%s" "$marker")" = 0:0:600:1:0
      test "$(stat -Lc "%u:%g:%a" "$staging")" = 0:0:700
      test -z "$(find "$staging" -mindepth 1 -print -quit)"
      test ! -e /data/home/.gemini/antigravity-cli/settings.json.onboarding.tmp
      test ! -e /data/home/.gemini/antigravity-cli/antigravity-oauth-token.onboarding.tmp
      test ! -e "$cache/onboarding.json.onboarding.tmp"

      case "$case_name" in
        success)
          jq --exit-status ".enableTelemetry == false" "$settings" >/dev/null
          test "$(stat -Lc "%u:%g:%a:%h" \
            /data/home/.gemini/antigravity-cli/antigravity-oauth-token)" \
            = 0:0:600:1
          jq --exit-status \
            "keys == [\"consumerOnboardingComplete\",\"enterpriseOnboardingComplete\"]
              and .consumerOnboardingComplete == true
              and .enterpriseOnboardingComplete == false" \
            "$cache/onboarding.json" >/dev/null
          ;;
        incomplete | unexpected | timeout)
          cmp -s /etc/antigravity/settings.json "$settings"
          test ! -e /data/home/.gemini/antigravity-cli/antigravity-oauth-token
          test ! -e "$cache/onboarding.json"
          ;;
        *) exit 64 ;;
      esac
      test "$expected_status" -ge 0
    ' bash "${case_name}" "${expected_status}" \
    || fail "${case_name} postconditions failed"
}

finalize_privacy_case() {
  local case_name=$1
  local data_volume=$2
  local runtime_volume=$3
  local status

  docker run --rm \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /bin/bash \
    --volume "${runtime_volume}:/run/antigravity-ha:ro" \
    "${IMAGE}" -p -ceu '
      test "$(cat /run/antigravity-ha/onboarding-active)" = privacy
      test "$(stat -Lc "%u:%g:%a:%h:%s" \
        /run/antigravity-ha/onboarding-active)" = 0:0:600:1:8
    ' || fail "${case_name} did not retain the privacy quarantine"

  set +e
  docker run --rm --tty \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /usr/local/libexec/antigravity-native-session-guard \
    --volume "${data_volume}:/data" \
    --volume "${runtime_volume}:/run/antigravity-ha" \
    "${IMAGE}" restricted >/dev/null 2>&1
  status=$?
  set -e
  (( status == 78 )) \
    || fail "${case_name} privacy quarantine allowed a normal session"

  docker run --rm \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /bin/bash \
    --volume "${data_volume}:/data" \
    --volume "${runtime_volume}:/run/antigravity-ha" \
    "${IMAGE}" -p -ceu \
      '/usr/local/libexec/antigravity-onboarding-controller --privacy-finalize >/dev/null 2>&1' \
    || fail "${case_name} privacy finalization failed"
}

run_case() {
  local case_name=$1
  local expected_status=$2
  local data_volume=${TEST_ID}-${case_name}-data
  local runtime_volume=${TEST_ID}-${case_name}-runtime
  local output
  local status

  VOLUMES+=("${data_volume}" "${runtime_volume}")
  docker volume create "${data_volume}" >/dev/null
  docker volume create "${runtime_volume}" >/dev/null

  set +e
  output=$(docker run --rm --tty \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /bin/bash \
    --volume "${data_volume}:/data" \
    --volume "${runtime_volume}:/run/antigravity-ha" \
    --volume "${STUB}:/usr/local/libexec/antigravity-real:ro" \
    --env "ONBOARDING_TEST_CASE=${case_name}" \
    "${IMAGE}" -p -ceu '
      install -d -m 0700 \
        /data/antigravity-ha/onboarding \
        /data/home/.gemini/antigravity-cli/cache \
        /run/antigravity-ha \
        /run/antigravity-ha/onboarding-home \
        /run/antigravity-ha/onboarding-workspace
      install -m 0600 /etc/antigravity/settings.json \
        /data/home/.gemini/antigravity-cli/settings.json
      printf "%s\n" "$ONBOARDING_TEST_CASE" \
        > /data/onboarding-controller-case
      chmod 0600 /data/onboarding-controller-case
      for control in native-session.lock user-files-update.lock onboarding-active; do
        install -m 0600 /dev/null "/run/antigravity-ha/${control}"
      done
      for stale in \
        /data/home/.gemini/antigravity-cli/settings.json.onboarding.tmp \
        /data/home/.gemini/antigravity-cli/antigravity-oauth-token.onboarding.tmp \
        /data/home/.gemini/antigravity-cli/cache/onboarding.json.onboarding.tmp; do
        printf "stale\n" > "$stale"
        chmod 0600 "$stale"
      done
      exec /usr/local/libexec/antigravity-onboarding-controller
    ' 2>&1)
  status=$?
  set -e

  if (( status != expected_status )); then
    printf '%s\n' "${output}" >&2
    fail "${case_name} returned ${status}, expected ${expected_status}"
  fi
  case "${case_name}" in
    success)
      grep -Fq 'Validated consumer onboarding files were saved' <<< "${output}" \
        || fail 'the success case omitted its validated-save message'
      grep -Fq 'finish terminal privacy cleanup' <<< "${output}" \
        || fail 'the success case omitted its privacy-cleanup handoff'
      ;;
    incomplete)
      grep -Fq 'Consumer onboarding was not completed' <<< "${output}" \
        || fail 'the incomplete case omitted its failure message'
      ! grep -Fq 'Start a protected normal session with: agy' <<< "${output}" \
        || fail 'the incomplete case recommended a normal session'
      ;;
    unexpected)
      grep -Fq 'failed with status 42' <<< "${output}" \
        || fail 'the unexpected-status case omitted the native status'
      ;;
    timeout)
      grep -Fq 'reached its time limit' <<< "${output}" \
        || fail 'the timeout case omitted its bounded-time message'
      ;;
  esac
  finalize_privacy_case "${case_name}" "${data_volume}" "${runtime_volume}"
  inspect_case "${case_name}" "${data_volume}" "${runtime_volume}" \
    "${expected_status}"
}

run_quarantine_case() {
  local data_volume=${TEST_ID}-quarantine-data
  local runtime_volume=${TEST_ID}-quarantine-runtime
  local output
  local status

  VOLUMES+=("${data_volume}" "${runtime_volume}")
  docker volume create "${data_volume}" >/dev/null
  docker volume create "${runtime_volume}" >/dev/null

  set +e
  output=$(docker run --rm --tty \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /bin/bash \
    --volume "${data_volume}:/data" \
    --volume "${runtime_volume}:/run/antigravity-ha" \
    --volume "${STUB}:/usr/local/libexec/antigravity-real:ro" \
    --env ONBOARDING_TEST_CASE=quarantine \
    "${IMAGE}" -p -ceu '
      install -d -m 0700 \
        /data/antigravity-ha/onboarding \
        /data/home/.gemini/antigravity-cli/cache \
        /run/antigravity-ha \
        /run/antigravity-ha/onboarding-home \
        /run/antigravity-ha/onboarding-workspace
      install -m 0600 /etc/antigravity/settings.json \
        /data/home/.gemini/antigravity-cli/settings.json
      printf "%s\n" "$ONBOARDING_TEST_CASE" \
        > /data/onboarding-controller-case
      chmod 0600 /data/onboarding-controller-case
      for control in native-session.lock user-files-update.lock onboarding-active; do
        install -m 0600 /dev/null "/run/antigravity-ha/${control}"
      done
      exec /usr/local/libexec/antigravity-onboarding-controller
    ' 2>&1)
  status=$?
  set -e
  (( status == 70 )) || {
    printf '%s\n' "${output}" >&2
    fail "quarantine returned ${status}, expected 70"
  }
  grep -Fq 'changed settings outside the telemetry choice' <<< "${output}" \
    || fail 'the quarantine case omitted its invariant failure'

  docker run --rm \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /bin/bash \
    --volume "${data_volume}:/data" \
    --volume "${runtime_volume}:/run/antigravity-ha" \
    "${IMAGE}" -p -ceu '
      cmp -s /etc/antigravity/settings.json \
        /data/home/.gemini/antigravity-cli/settings.json
      test "$(stat -Lc "%u:%g:%a:%h" \
        /run/antigravity-ha/onboarding-active)" = 0:0:600:1
      test "$(stat -Lc "%s" /run/antigravity-ha/onboarding-active)" -gt 0
      test -n "$(find /run/antigravity-ha/onboarding-home -mindepth 1 -print -quit)"
    ' || fail 'the invariant failure did not leave a fail-closed quarantine'

  set +e
  docker run --rm \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /usr/local/libexec/antigravity-native-session-guard \
    --volume "${data_volume}:/data" \
    --volume "${runtime_volume}:/run/antigravity-ha" \
    "${IMAGE}" restricted >/dev/null 2>&1
  status=$?
  set -e
  (( status == 78 )) \
    || fail 'the normal native guard did not reject the active quarantine'
}

run_upgrade_baseline_case() {
  local case_name=$1
  local expected_status=$2
  local data_volume=${TEST_ID}-${case_name}-data
  local runtime_volume=${TEST_ID}-${case_name}-runtime
  local output status
  VOLUMES+=("${data_volume}" "${runtime_volume}")
  docker volume create "${data_volume}" >/dev/null
  docker volume create "${runtime_volume}" >/dev/null

  set +e
  output=$(docker run --rm --tty \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /bin/bash \
    --volume "${data_volume}:/data" \
    --volume "${runtime_volume}:/run/antigravity-ha" \
    --volume "${STUB}:/usr/local/libexec/antigravity-real:ro" \
    --env "ONBOARDING_TEST_CASE=${case_name}" \
    "${IMAGE}" -p -ceu '
      case_name=$1
      cli=/data/home/.gemini/antigravity-cli
      install -d -m 0700 /data/antigravity-ha/onboarding "$cli/cache" \
        /run/antigravity-ha \
        /run/antigravity-ha/onboarding-home \
        /run/antigravity-ha/onboarding-workspace
      install -m 0600 /etc/antigravity/settings.json "$cli/settings.json"
      printf "%s\n" "$case_name" > /data/onboarding-controller-case
      chmod 0600 /data/onboarding-controller-case
      for control in native-session.lock user-files-update.lock onboarding-active; do
        install -m 0600 /dev/null "/run/antigravity-ha/${control}"
      done
      case "$case_name" in
        upgrade-oauth)
          printf "%s\n" existing-opaque-oauth > "$cli/antigravity-oauth-token"
          chmod 0600 "$cli/antigravity-oauth-token"
          ;;
        upgrade-complete)
          printf "%s\n" existing-opaque-oauth > "$cli/antigravity-oauth-token"
          printf "%s\n" \
            "{\"consumerOnboardingComplete\":true,\"enterpriseOnboardingComplete\":false}" \
            > "$cli/cache/onboarding.json"
          chmod 0600 "$cli/antigravity-oauth-token" "$cli/cache/onboarding.json"
          ;;
        marker-without-oauth)
          printf "%s\n" \
            "{\"consumerOnboardingComplete\":true,\"enterpriseOnboardingComplete\":false}" \
            > "$cli/cache/onboarding.json"
          chmod 0600 "$cli/cache/onboarding.json"
          ;;
        enterprise)
          printf "%s\n" existing-opaque-oauth > "$cli/antigravity-oauth-token"
          printf "%s\n" \
            "{\"consumerOnboardingComplete\":false,\"enterpriseOnboardingComplete\":true}" \
            > "$cli/cache/onboarding.json"
          chmod 0600 "$cli/antigravity-oauth-token" "$cli/cache/onboarding.json"
          ;;
      esac
      exec /usr/local/libexec/antigravity-onboarding-controller
    ' bash "${case_name}" 2>&1)
  status=$?
  set -e
  if (( status != expected_status )); then
    printf '%s\n' "${output}" >&2
    fail "${case_name} returned ${status}, expected ${expected_status}"
  fi

  if (( expected_status == 0 )); then
    finalize_privacy_case "${case_name}" "${data_volume}" "${runtime_volume}"
  fi

  docker run --rm \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /bin/bash \
    --volume "${data_volume}:/data" \
    --volume "${runtime_volume}:/run/antigravity-ha" \
    "${IMAGE}" -p -ceu '
      case_name=$1
      cli=/data/home/.gemini/antigravity-cli
      case "$case_name" in
        upgrade-oauth | upgrade-complete)
          jq --exit-status ".enableTelemetry == false" "$cli/settings.json" >/dev/null
          grep -Fqx existing-opaque-oauth "$cli/antigravity-oauth-token"
          jq --exit-status ".consumerOnboardingComplete == true
            and .enterpriseOnboardingComplete == false" \
            "$cli/cache/onboarding.json" >/dev/null
          test ! -s /run/antigravity-ha/onboarding-active
          ;;
        marker-without-oauth)
          cmp -s /etc/antigravity/settings.json "$cli/settings.json"
          test ! -e "$cli/antigravity-oauth-token"
          test -s /run/antigravity-ha/onboarding-active
          ;;
        enterprise)
          cmp -s /etc/antigravity/settings.json "$cli/settings.json"
          test ! -s /run/antigravity-ha/onboarding-active
          ;;
      esac
    ' bash "${case_name}" \
    || fail "${case_name} upgrade baseline postconditions failed"
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
[[ -x ${STUB} ]] || fail "executable stub not found: ${STUB}"

run_case success 0
run_case incomplete 76
run_case unexpected 42
run_case timeout 124
run_quarantine_case
run_upgrade_baseline_case upgrade-oauth 0
run_upgrade_baseline_case upgrade-complete 0
run_upgrade_baseline_case marker-without-oauth 70
run_upgrade_baseline_case enterprise 70

printf '%s\n' \
  'onboarding controller smoke: PASS (synthetic native; real HAOS remains NOT RUN)'
