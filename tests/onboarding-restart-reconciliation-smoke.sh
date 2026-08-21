#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${1:-antigravity-for-home-assistant:test}
TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}
case "${TEST_PLATFORM}" in
  linux/amd64 | linux/arm64) ;;
  *) printf 'unsupported TEST_PLATFORM: %s\n' "${TEST_PLATFORM}" >&2; exit 64 ;;
esac

readonly TEST_ID="antigravity-ha-onboarding-reconcile-${RANDOM}-$$"
readonly DATA_VOLUME=${TEST_ID}-data
readonly CONFIG_VOLUME=${TEST_ID}-config

fail() {
  printf 'onboarding restart reconciliation smoke: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  docker volume rm --force "${DATA_VOLUME}" "${CONFIG_VOLUME}" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

run_init() {
  local phase=$1 output status
  set +e
  output=$(docker run --rm \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /bin/sh \
    --volume "${DATA_VOLUME}:/data" \
    --volume "${CONFIG_VOLUME}:/config" \
    "${IMAGE}" -ceu '
      phase=$1
      mkdir -p /run/s6/container_environment
      /usr/local/bin/antigravity-ha-init

      helper=/usr/local/share/antigravity-ha/onboarding-transaction.mjs
      marker=/run/antigravity-ha/onboarding-active
      case "$phase" in
        bootstrap)
          test "$(node "$helper" status)" = absent
          test "$(node "$helper" restart-status)" = absent
          test "$(stat -Lc "%u:%g:%a:%h:%s" "$marker")" = 0:0:600:1:0
          ;;
        partial)
          test "$(node "$helper" status)" = partial
          test "$(node "$helper" restart-status)" = absent
          test "$(stat -Lc "%u:%g:%a:%h" "$marker")" = 0:0:600:1
          test "$(stat -Lc "%s" "$marker")" -gt 0
          test -d /data/antigravity-ha/migration/native-files.json
          set +e
          /usr/local/libexec/antigravity-native-session-guard \
            restricted --version >/dev/null 2>&1
          guard_status=$?
          /usr/local/bin/antigravity-user-files-update \
            >/dev/null 2>&1
          updater_status=$?
          set -e
          test "$guard_status" -eq 78
          test "$updater_status" -eq 30
          ;;
        reconciled)
          test "$(node "$helper" status)" = absent
          test "$(node "$helper" restart-status)" = absent
          test "$(stat -Lc "%u:%g:%a:%h:%s" "$marker")" = 0:0:600:1:0
          /usr/local/libexec/antigravity-native-session-guard \
            restricted --version >/dev/null
          jq --exit-status ".enableTelemetry == false" \
            /data/home/.gemini/antigravity-cli/settings.json >/dev/null
          jq --exit-status \
            ".consumerOnboardingComplete == true
              and .enterpriseOnboardingComplete == false
              and length == 2" \
            /data/home/.gemini/antigravity-cli/cache/onboarding.json >/dev/null
          test "$(stat -Lc "%u:%g:%a:%h" \
            /data/home/.gemini/antigravity-cli/antigravity-oauth-token)" \
            = 0:0:600:1
          ;;
        *) exit 64 ;;
      esac
    ' sh "${phase}" 2>&1)
  status=$?
  set -e
  if (( status != 0 )); then
    printf '%s\n' "${output}" >&2
    fail "${phase} init returned ${status}"
  fi
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
docker volume create "${DATA_VOLUME}" >/dev/null
docker volume create "${CONFIG_VOLUME}" >/dev/null

printf '%s\n' '{
  "authorized_keys": [],
  "web_terminal_auto_start_antigravity": false,
  "tmux_session_name": "onboarding-reconciliation-smoke",
  "antigravity_tool_permission": "request-review",
  "antigravity_terminal_sandbox": false,
  "antigravity_sensitive_data_access": false,
  "browser_approval_policy": "safe",
  "antigravity_user_files_update_mode": "preserve",
  "home_assistant_browser_auto_auth": false,
  "log_level": "info"
}' | docker run --rm --interactive \
  --platform "${TEST_PLATFORM}" \
  --network none \
  --entrypoint /bin/sh \
  --volume "${DATA_VOLUME}:/data" \
  "${IMAGE}" -ceu 'umask 077; tee /data/options.json >/dev/null'

# Establish the same managed settings baseline that a normal App boot creates.
run_init bootstrap

# Stop a committed install immediately after settings (S1). The journal and
# exact settings prefix persist, but no credential payload is copied into the
# recovery directory. An intentionally unsafe updater journal is a tripwire:
# partial init must skip the updater and stay available for authenticated retry.
docker run --rm \
  --platform "${TEST_PLATFORM}" \
  --network none \
  --entrypoint /bin/bash \
  --volume "${DATA_VOLUME}:/data" \
  "${IMAGE}" -p -ceu '
    helper=/usr/local/share/antigravity-ha/onboarding-transaction.mjs
    real=/data/home/.gemini/antigravity-cli
    staged=/run/antigravity-ha/onboarding-home/.gemini/antigravity-cli
    transaction=/data/antigravity-ha/onboarding
    install -d -m 0700 "$staged/cache" \
      /run/antigravity-ha/onboarding-home/tmp "$transaction"
    install -m 0600 "$real/settings.json" "$staged/settings.json"
    jq ".enableTelemetry = false" "$staged/settings.json" \
      > "$staged/settings.json.next"
    chmod 0600 "$staged/settings.json.next"
    mv -fT "$staged/settings.json.next" "$staged/settings.json"
    printf "%s\n" synthetic-oauth-first-attempt \
      > "$staged/antigravity-oauth-token"
    printf "%s\n" \
      "{\"consumerOnboardingComplete\":true,\"enterpriseOnboardingComplete\":false}" \
      > "$staged/cache/onboarding.json"
    chmod 0600 "$staged/antigravity-oauth-token" \
      "$staged/cache/onboarding.json"
    node "$helper" candidate

    mkdir "$real/antigravity-oauth-token.onboarding.tmp"
    set +e
    node "$helper" commit >/dev/null 2>&1
    commit_status=$?
    set -e
    test "$commit_status" -eq 70
    rmdir "$real/antigravity-oauth-token.onboarding.tmp"
    test "$(node "$helper" status)" = partial
    test ! -e "$real/antigravity-oauth-token"
    test ! -e "$real/cache/onboarding.json"
    jq --exit-status ".enableTelemetry == false" \
      "$real/settings.json" >/dev/null
    jq --exit-status \
      ".phase == \"installing\" and .restartRequired == false" \
      "$transaction/retry-required.json" >/dev/null
    test -z "$(find "$transaction" -type f -name "*oauth*" -print -quit)"

    migration=/data/antigravity-ha/migration
    install -d -m 0700 "$migration"
    test ! -e "$migration/native-files.json"
    mkdir "$migration/native-files.json"
  ' || fail 'could not create the deterministic S1 partial prefix'

run_init partial

# Typed privacy finalization recognizes a partial state only when its journal
# proves the same legal prefix. It returns the retained-state status and must
# not rewrite even the marker inode. A fixed temporary-path blocker then proves
# a failed atomic marker replacement cannot truncate or clear that quarantine.
docker run --rm \
  --platform "${TEST_PLATFORM}" \
  --network none \
  --entrypoint /bin/bash \
  --volume "${DATA_VOLUME}:/data" \
  "${IMAGE}" -p -ceu '
    helper=/usr/local/share/antigravity-ha/onboarding-transaction.mjs
    runtime=/run/antigravity-ha
    marker=$runtime/onboarding-active
    install -d -m 0700 "$runtime" "$runtime/onboarding-home" \
      "$runtime/onboarding-workspace"
    for control in native-session.lock user-files-update.lock onboarding-active; do
      install -m 0600 /dev/null "$runtime/$control"
    done
    node "$helper" marker partial
    test "$(node "$helper" status)" = partial
    test "$(node "$helper" restart-status)" = absent
    before_identity=$(stat -Lc "%d:%i:%u:%g:%a:%h:%s" "$marker")
    before_hash=$(sha256sum "$marker")
    set +e
    /usr/local/libexec/antigravity-onboarding-controller \
      --privacy-finalize >/dev/null 2>&1
    finalize_status=$?
    set -e
    test "$finalize_status" -eq 79
    test "$(< "$marker")" = partial
    test "$(stat -Lc "%d:%i:%u:%g:%a:%h:%s" "$marker")" \
      = "$before_identity"
    test "$(sha256sum "$marker")" = "$before_hash"

    mkdir "$runtime/onboarding-active.tmp"
    set +e
    node "$helper" marker clear >/dev/null 2>&1
    marker_status=$?
    set -e
    test "$marker_status" -eq 70
    test "$(< "$marker")" = partial
    test "$(stat -Lc "%d:%i:%u:%g:%a:%h:%s" "$marker")" \
      = "$before_identity"
    test "$(sha256sum "$marker")" = "$before_hash"
    rmdir "$runtime/onboarding-active.tmp"
    set +e
    /usr/local/libexec/antigravity-native-session-guard \
      restricted --version >/dev/null 2>&1
    guard_status=$?
    set -e
    test "$guard_status" -eq 78
  ' || fail 'partial typed-finalizer or atomic marker fault containment failed'

# A fresh, synthetic retry rebases the legal partial prefix. Finalization must
# publish the durable restart marker before removing its no-secret journal.
docker run --rm \
  --platform "${TEST_PLATFORM}" \
  --network none \
  --entrypoint /bin/bash \
  --volume "${DATA_VOLUME}:/data" \
  "${IMAGE}" -p -ceu '
    helper=/usr/local/share/antigravity-ha/onboarding-transaction.mjs
    real=/data/home/.gemini/antigravity-cli
    staged=/run/antigravity-ha/onboarding-home/.gemini/antigravity-cli
    transaction=/data/antigravity-ha/onboarding
    rmdir /data/antigravity-ha/migration/native-files.json
    install -d -m 0700 "$staged/cache" \
      /run/antigravity-ha/onboarding-home/tmp
    install -m 0600 "$real/settings.json" "$staged/settings.json"
    jq ".enableTelemetry = false" "$staged/settings.json" \
      > "$staged/settings.json.next"
    chmod 0600 "$staged/settings.json.next"
    mv -fT "$staged/settings.json.next" "$staged/settings.json"
    printf "%s\n" synthetic-oauth-retry \
      > "$staged/antigravity-oauth-token"
    printf "%s\n" \
      "{\"consumerOnboardingComplete\":true,\"enterpriseOnboardingComplete\":false}" \
      > "$staged/cache/onboarding.json"
    chmod 0600 "$staged/antigravity-oauth-token" \
      "$staged/cache/onboarding.json"
    node "$helper" candidate
    node "$helper" commit
    test "$(node "$helper" status)" = complete-restart
    test "$(node "$helper" finalize)" = restart-required
    test "$(node "$helper" status)" = absent
    test "$(node "$helper" restart-status)" = required
    test ! -e "$transaction/retry-required.json"
    test "$(find "$transaction" -maxdepth 1 -type f -printf "%f\n")" \
      = restart-required
  ' || fail 'partial retry did not reach a durable restart requirement'

# The restart runtime marker is valid only beside the durable restart-required
# file and an absent journal. Its typed finalizer result is retained, not a
# privacy success, and the normal native guard remains closed.
docker run --rm \
  --platform "${TEST_PLATFORM}" \
  --network none \
  --entrypoint /bin/bash \
  --volume "${DATA_VOLUME}:/data" \
  "${IMAGE}" -p -ceu '
    helper=/usr/local/share/antigravity-ha/onboarding-transaction.mjs
    runtime=/run/antigravity-ha
    marker=$runtime/onboarding-active
    install -d -m 0700 "$runtime" "$runtime/onboarding-home" \
      "$runtime/onboarding-workspace"
    for control in native-session.lock user-files-update.lock onboarding-active; do
      install -m 0600 /dev/null "$runtime/$control"
    done
    node "$helper" marker restart
    test "$(node "$helper" status)" = absent
    test "$(node "$helper" restart-status)" = required
    before_identity=$(stat -Lc "%d:%i:%u:%g:%a:%h:%s" "$marker")
    before_hash=$(sha256sum "$marker")
    set +e
    /usr/local/libexec/antigravity-onboarding-controller \
      --privacy-finalize >/dev/null 2>&1
    finalize_status=$?
    set -e
    test "$finalize_status" -eq 79
    test "$(< "$marker")" = restart
    test "$(stat -Lc "%d:%i:%u:%g:%a:%h:%s" "$marker")" \
      = "$before_identity"
    test "$(sha256sum "$marker")" = "$before_hash"
    set +e
    /usr/local/libexec/antigravity-native-session-guard \
      restricted --version >/dev/null 2>&1
    guard_status=$?
    set -e
    test "$guard_status" -eq 78
  ' || fail 'restart typed-finalizer did not retain its paired state'

# The next real init invokes the actual updater, clears the restart marker only
# after reconciliation, and reopens the normal native-session guard.
run_init reconciled

# Empty is a typed no-op, while privacy is the only state that may atomically
# replace the marker with an empty regular file. Successful replacement must
# change its inode and leave no fixed temporary behind.
docker run --rm \
  --platform "${TEST_PLATFORM}" \
  --network none \
  --entrypoint /bin/bash \
  --volume "${DATA_VOLUME}:/data" \
  "${IMAGE}" -p -ceu '
    runtime=/run/antigravity-ha
    install -d -m 0700 "$runtime" "$runtime/onboarding-home" \
      "$runtime/onboarding-workspace"
    for control in native-session.lock user-files-update.lock onboarding-active; do
      install -m 0600 /dev/null "$runtime/$control"
    done
    helper=/usr/local/share/antigravity-ha/onboarding-transaction.mjs
    marker=$runtime/onboarding-active
    test "$(node "$helper" status)" = absent
    test "$(node "$helper" restart-status)" = absent

    empty_identity=$(stat -Lc "%d:%i:%u:%g:%a:%h:%s" "$marker")
    empty_hash=$(sha256sum "$marker")
    set +e
    /usr/local/libexec/antigravity-onboarding-controller \
      --privacy-finalize >/dev/null 2>&1
    empty_status=$?
    set -e
    test "$empty_status" -eq 77
    test "$(stat -Lc "%d:%i:%u:%g:%a:%h:%s" "$marker")" \
      = "$empty_identity"
    test "$(sha256sum "$marker")" = "$empty_hash"

    node "$helper" marker privacy
    privacy_identity=$(stat -Lc "%d:%i" "$marker")
    privacy_hash=$(sha256sum "$marker")
    test "$(< "$marker")" = privacy
    mkdir "$runtime/onboarding-active.tmp"
    set +e
    /usr/local/libexec/antigravity-onboarding-controller \
      --privacy-finalize >/dev/null 2>&1
    privacy_fault_status=$?
    set -e
    test "$privacy_fault_status" -eq 70
    test "$(< "$marker")" = privacy
    test "$(stat -Lc "%d:%i" "$marker")" = "$privacy_identity"
    test "$(sha256sum "$marker")" = "$privacy_hash"
    set +e
    /usr/local/libexec/antigravity-native-session-guard \
      restricted --version >/dev/null 2>&1
    privacy_guard_status=$?
    set -e
    test "$privacy_guard_status" -eq 78
    rmdir "$runtime/onboarding-active.tmp"
    /usr/local/libexec/antigravity-onboarding-controller \
      --privacy-finalize >/dev/null 2>&1
    test "$(stat -Lc "%u:%g:%a:%h:%s" "$marker")" = 0:0:600:1:0
    test "$(stat -Lc "%d:%i" "$marker")" != "$privacy_identity"
    test ! -e "$runtime/onboarding-active.tmp"
    /usr/local/libexec/antigravity-native-session-guard \
      restricted --version >/dev/null
  ' || fail 'empty/privacy typed-finalizer atomic transition failed'

printf '%s\n' \
  'onboarding restart reconciliation smoke: PASS (full init recovery; typed empty/privacy/partial/restart finalizer; atomic marker fault containment; real HAOS remains NOT RUN)'
