#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${1:-antigravity-for-home-assistant:test}
TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}
case "${TEST_PLATFORM}" in
  linux/amd64 | linux/arm64) ;;
  *) printf 'unsupported TEST_PLATFORM: %s\n' "${TEST_PLATFORM}" >&2; exit 64 ;;
esac

readonly TEST_ID="antigravity-ha-onboarding-transaction-${RANDOM}-$$"
VOLUMES=()

fail() {
  printf 'onboarding transaction smoke: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if (( ${#VOLUMES[@]} > 0 )); then
    docker volume rm --force "${VOLUMES[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

run_prefix_case() {
  local prefix=$1
  local data_volume=${TEST_ID}-${prefix}-data
  local runtime_volume=${TEST_ID}-${prefix}-runtime
  VOLUMES+=("${data_volume}" "${runtime_volume}")
  docker volume create "${data_volume}" >/dev/null
  docker volume create "${runtime_volume}" >/dev/null

  docker run --rm \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /bin/bash \
    --volume "${data_volume}:/data" \
    --volume "${runtime_volume}:/run/antigravity-ha" \
    "${IMAGE}" -p -ceu '
      prefix=$1
      helper=/usr/local/share/antigravity-ha/onboarding-transaction.mjs
      real=/data/home/.gemini/antigravity-cli
      staged=/run/antigravity-ha/onboarding-home/.gemini/antigravity-cli
      transaction=/data/antigravity-ha/onboarding
      install -d -m 0700 "$real/cache" "$staged/cache" \
        /run/antigravity-ha/onboarding-home/tmp "$transaction"
      install -m 0600 /etc/antigravity/settings.json "$real/settings.json"
      install -m 0600 /etc/antigravity/settings.json "$staged/settings.json"
      jq ".enableTelemetry = false" "$staged/settings.json" \
        > "$staged/settings.json.next"
      chmod 0600 "$staged/settings.json.next"
      mv -fT "$staged/settings.json.next" "$staged/settings.json"
      printf "%s\n" synthetic-opaque-oauth > "$staged/antigravity-oauth-token"
      printf "%s\n" \
        "{\"consumerOnboardingComplete\":true,\"enterpriseOnboardingComplete\":false}" \
        > "$staged/cache/onboarding.json"
      chmod 0600 "$staged/antigravity-oauth-token" "$staged/cache/onboarding.json"
      node "$helper" candidate

      case "$prefix" in
        s0) blocker="$real/settings.json.onboarding.tmp" ;;
        s1) blocker="$real/antigravity-oauth-token.onboarding.tmp" ;;
        s2) blocker="$real/cache/onboarding.json.onboarding.tmp" ;;
        *) exit 64 ;;
      esac
      mkdir "$blocker"
      set +e
      node "$helper" commit >/dev/null 2>&1
      commit_status=$?
      set -e
      test "$commit_status" -eq 70
      rmdir "$blocker"
      test "$(node "$helper" status)" = partial
      jq --exit-status ".phase == \"installing\"
        and .restartRequired == false" "$transaction/retry-required.json" >/dev/null

      case "$prefix" in
        s0)
          cmp -s /etc/antigravity/settings.json "$real/settings.json"
          test ! -e "$real/antigravity-oauth-token"
          test ! -e "$real/cache/onboarding.json"
          ;;
        s1)
          jq --exit-status ".enableTelemetry == false" "$real/settings.json" >/dev/null
          test ! -e "$real/antigravity-oauth-token"
          test ! -e "$real/cache/onboarding.json"
          ;;
        s2)
          jq --exit-status ".enableTelemetry == false" "$real/settings.json" >/dev/null
          test -s "$real/antigravity-oauth-token"
          test ! -e "$real/cache/onboarding.json"
          ;;
      esac

      # A retry stages from the exact legal prefix. Replacing the no-secret
      # journal atomically rebases that prefix; no OAuth bytes are copied under
      # the transaction directory.
      install -m 0600 "$real/settings.json" "$staged/settings.json"
      jq ".enableTelemetry = false" "$staged/settings.json" \
        > "$staged/settings.json.next"
      chmod 0600 "$staged/settings.json.next"
      mv -fT "$staged/settings.json.next" "$staged/settings.json"
      printf "%s\n" synthetic-retry-oauth > "$staged/antigravity-oauth-token"
      chmod 0600 "$staged/antigravity-oauth-token"
      node "$helper" candidate
      node "$helper" commit
      test "$(node "$helper" status)" = complete-restart
      jq --exit-status ".phase == \"committed\"
        and .restartRequired == true" "$transaction/retry-required.json" >/dev/null
      test -z "$(find "$transaction" -type f -name "*oauth*" -print -quit)"

      # Simulate a kill after the restart marker fsync but before journal
      # unlink. finalize must be idempotent and remove the journal only after
      # the durable marker exists.
      printf "restart\n" > "$transaction/restart-required"
      chmod 0600 "$transaction/restart-required"
      test "$(node "$helper" finalize)" = restart-required
      test "$(node "$helper" status)" = absent
      test "$(node "$helper" restart-status)" = required
      test ! -e "$transaction/retry-required.json"
      node "$helper" clear-restart
      test "$(node "$helper" restart-status)" = absent
    ' bash "${prefix}" \
    || fail "${prefix} legal-prefix/rebase recovery failed"
}

run_complete_before_finalize_case() {
  local data_volume=${TEST_ID}-s3-data
  local runtime_volume=${TEST_ID}-s3-runtime
  VOLUMES+=("${data_volume}" "${runtime_volume}")
  docker volume create "${data_volume}" >/dev/null
  docker volume create "${runtime_volume}" >/dev/null
  docker run --rm \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /bin/bash \
    --volume "${data_volume}:/data" \
    --volume "${runtime_volume}:/run/antigravity-ha" \
    "${IMAGE}" -p -ceu '
      helper=/usr/local/share/antigravity-ha/onboarding-transaction.mjs
      real=/data/home/.gemini/antigravity-cli
      staged=/run/antigravity-ha/onboarding-home/.gemini/antigravity-cli
      transaction=/data/antigravity-ha/onboarding
      install -d -m 0700 "$real/cache" "$staged/cache" \
        /run/antigravity-ha/onboarding-home/tmp "$transaction"
      install -m 0600 /etc/antigravity/settings.json "$real/settings.json"
      jq ".enableTelemetry = false" /etc/antigravity/settings.json \
        > "$staged/settings.json"
      printf "%s\n" synthetic-opaque-oauth > "$staged/antigravity-oauth-token"
      # Native JSON accepts duplicate keys. The trusted candidate builder must
      # persist one canonical instance of each exact onboarding boolean.
      printf "%s\n" \
        "{\"consumerOnboardingComplete\":false,\"consumerOnboardingComplete\":true,\"enterpriseOnboardingComplete\":false}" \
        > "$staged/cache/onboarding.json"
      chmod 0600 "$staged/settings.json" "$staged/antigravity-oauth-token" \
        "$staged/cache/onboarding.json"
      node "$helper" candidate
      node "$helper" commit
      test "$(node "$helper" status)" = complete
      test "$(grep -o consumerOnboardingComplete \
        "$real/cache/onboarding.json" | wc -l)" -eq 1
      jq --exit-status ".consumerOnboardingComplete == true
        and .enterpriseOnboardingComplete == false
        and length == 2" "$real/cache/onboarding.json" >/dev/null
      jq --exit-status ".phase == \"committed\"
        and .restartRequired == false" "$transaction/retry-required.json" >/dev/null
      test "$(node "$helper" finalize)" = finalized
      test "$(node "$helper" status)" = absent
      test "$(node "$helper" restart-status)" = absent
    ' || fail 's3 complete-before-finalize recovery failed'
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
for prefix in s0 s1 s2; do run_prefix_case "${prefix}"; done
run_complete_before_finalize_case

printf '%s\n' \
  'onboarding transaction smoke: PASS (deterministic S0/S1/S2/S3 crash prefixes; real HAOS remains NOT RUN)'
