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
SCRIPT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
FIXTURE_DIRECTORY="${SCRIPT_DIRECTORY}/fixtures"
PUBLIC_2_0_6_SETTINGS_SHA256=ee34d8fd24909a90f1afafd4303dc5402571cf73105c8983a083a1101b25749c
PUBLIC_2_0_6_STATE_SHA256=78353795eadafcb552e8aeae049741d88fec378265bb133ac60e2950fd72e56c
PUBLIC_2_0_8_SETTINGS_SHA256=e2590f1f1b4a61aec2afabbfbc4df884a3a47423749367dec249acd056bfa108
PUBLIC_2_0_8_STATE_SHA256=ac108d3d3c43158f22f831c7c8e5bf9bd45de63a4cb40cd3ed620b2a6545a4d7
PUBLIC_2_1_0_SETTINGS_SHA256=1d91fa1e64ae864c8ba6345a8237214d746cd18bde0b9297917933ddb23ac8f1
PUBLIC_2_1_0_STATE_SHA256=d613788c6fa63a7c8c20823d012cb31f2abdfe171473f1be976f5d27e43ff7eb
TEST_ID="antigravity-ha-native-files-${RANDOM}-$$"
MAIN_VOLUME="${TEST_ID}-main"
RESET_VOLUME="${TEST_ID}-reset"
CONFLICT_VOLUME="${TEST_ID}-conflict"
PARTIAL_CONFLICT_VOLUME="${TEST_ID}-partial-conflict"
LINK_VOLUME="${TEST_ID}-link"
LEGACY_VOLUME="${TEST_ID}-legacy"
CRASH_VOLUME="${TEST_ID}-crash"
CONTROL_CONFLICT_VOLUME="${TEST_ID}-control-conflict"
PERMISSION_MIGRATION_VOLUME="${TEST_ID}-permission-migration"
PERMISSION_V208_MIGRATION_VOLUME="${TEST_ID}-permission-v208-migration"
PERMISSION_V208_AMBIGUOUS_VOLUME="${TEST_ID}-permission-v208-ambiguous"
PERMISSION_V3_MIGRATION_VOLUME="${TEST_ID}-permission-v3-migration"
PERMISSION_V2018_MIGRATION_VOLUME="${TEST_ID}-permission-v2018-migration"
PERMISSION_V210_MIGRATION_VOLUME="${TEST_ID}-permission-v210-migration"
TELEGRAM_RECONCILE_VOLUME="${TEST_ID}-telegram-reconcile"
TELEGRAM_MALFORMED_REFRESH_VOLUME="${TEST_ID}-telegram-malformed-refresh"
TELEGRAM_MALFORMED_MATRIX_CASES=(
  "allow:non-array"
  "allow:array-non-string"
  "ask:non-array"
  "ask:array-non-string"
  "deny:non-array"
  "deny:array-non-string"
)
TELEGRAM_MALFORMED_MATRIX_VOLUMES=()
for TELEGRAM_MALFORMED_MATRIX_CASE in \
  "${TELEGRAM_MALFORMED_MATRIX_CASES[@]}"; do
  TELEGRAM_MALFORMED_MATRIX_VOLUMES+=(
    "${TEST_ID}-telegram-matrix-${TELEGRAM_MALFORMED_MATRIX_CASE/:/-}"
  )
done
TELEGRAM_OVERSIZE_VOLUME="${TEST_ID}-telegram-oversize"
PERMISSION_UNOWNED_VOLUME="${TEST_ID}-permission-unowned"
PERMISSION_AMBIGUOUS_VOLUME="${TEST_ID}-permission-ambiguous"
PUBLIC_V1_VOLUME="${TEST_ID}-public-v1"
PUBLIC_V1_COMMITTED_VOLUME="${TEST_ID}-public-v1-committed"
PUBLIC_V1_CONFLICT_VOLUME="${TEST_ID}-public-v1-conflict"
RETENTION_VOLUME="${TEST_ID}-retention"
VOLUMES=(
  "${MAIN_VOLUME}"
  "${RESET_VOLUME}"
  "${CONFLICT_VOLUME}"
  "${PARTIAL_CONFLICT_VOLUME}"
  "${LINK_VOLUME}"
  "${LEGACY_VOLUME}"
  "${CRASH_VOLUME}"
  "${CONTROL_CONFLICT_VOLUME}"
  "${PERMISSION_MIGRATION_VOLUME}"
  "${PERMISSION_V208_MIGRATION_VOLUME}"
  "${PERMISSION_V208_AMBIGUOUS_VOLUME}"
  "${PERMISSION_V3_MIGRATION_VOLUME}"
  "${PERMISSION_V2018_MIGRATION_VOLUME}"
  "${PERMISSION_V210_MIGRATION_VOLUME}"
  "${TELEGRAM_RECONCILE_VOLUME}"
  "${TELEGRAM_MALFORMED_REFRESH_VOLUME}"
  "${TELEGRAM_MALFORMED_MATRIX_VOLUMES[@]}"
  "${TELEGRAM_OVERSIZE_VOLUME}"
  "${PERMISSION_UNOWNED_VOLUME}"
  "${PERMISSION_AMBIGUOUS_VOLUME}"
  "${PUBLIC_V1_VOLUME}"
  "${PUBLIC_V1_COMMITTED_VOLUME}"
  "${PUBLIC_V1_CONFLICT_VOLUME}"
  "${RETENTION_VOLUME}"
)
SETTINGS_SECRET="${TEST_ID}-settings-secret"
MCP_SECRET="${TEST_ID}-mcp-secret"
AUTH_SECRET="${TEST_ID}-auth-secret"
LEGACY_SECRET="${TEST_ID}-legacy-secret"
LEGACY_PROVIDER_SECRET="${TEST_ID}-legacy-provider-secret"
LEGACY_BROWSER_SECRET="${TEST_ID}-legacy-browser-secret"
LEGACY_PAIR_SECRET="${TEST_ID}-legacy-pairing-secret"

if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

cleanup() {
  docker volume rm -f "${VOLUMES[@]}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf 'native user-files smoke: %s\n' "$*" >&2
  exit 1
}

run_volume() {
  local volume=$1
  shift
  docker run --rm \
    --interactive \
    --platform "$TEST_PLATFORM" \
    --entrypoint /bin/bash \
    --volume "${volume}:/data" \
    --volume "${FIXTURE_DIRECTORY}:/test-fixtures:ro" \
    "${IMAGE}" "$@"
}

run_script() {
  local volume=$1
  shift
  run_volume "${volume}" -s -- "$@"
}

run_helper() {
  local volume=$1
  run_volume "${volume}" -c '
    set -Eeuo pipefail
    install -d -m 0700 /run/antigravity-ha
    exec /usr/local/bin/antigravity-user-files-update
  '
}

path_hash() {
  local volume=$1
  local path=$2
  run_script "${volume}" "${path}" <<'SCRIPT'
sha256sum "$1" | cut -d " " -f 1
SCRIPT
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

assert_sanitized() {
  local output=$1
  local secret
  for secret in \
    "${SETTINGS_SECRET}" \
    "${MCP_SECRET}" \
    "${AUTH_SECRET}" \
    "${LEGACY_SECRET}" \
    "${LEGACY_PROVIDER_SECRET}" \
    "${LEGACY_BROWSER_SECRET}" \
    "${LEGACY_PAIR_SECRET}"; do
    if grep -Fq -- "${secret}" <<<"${output}"; then
      fail 'user file content appeared in helper output'
    fi
  done
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
[[ $(sha256sum "${FIXTURE_DIRECTORY}/public-2.0.6-preserve-settings.json" | cut -d " " -f 1) == "${PUBLIC_2_0_6_SETTINGS_SHA256}" ]] \
  || fail 'public 2.0.6 preserve settings fixture hash changed'
[[ $(sha256sum "${FIXTURE_DIRECTORY}/public-2.0.6-preserve-state.json" | cut -d " " -f 1) == "${PUBLIC_2_0_6_STATE_SHA256}" ]] \
  || fail 'public 2.0.6 preserve state fixture hash changed'
[[ $(sha256sum "${FIXTURE_DIRECTORY}/public-2.0.8-preserve-settings.json" | cut -d " " -f 1) == "${PUBLIC_2_0_8_SETTINGS_SHA256}" ]] \
  || fail 'public 2.0.8 preserve settings fixture hash changed'
[[ $(sha256sum "${FIXTURE_DIRECTORY}/public-2.0.8-preserve-state.json" | cut -d " " -f 1) == "${PUBLIC_2_0_8_STATE_SHA256}" ]] \
  || fail 'public 2.0.8 preserve state fixture hash changed'
[[ $(sha256sum "${FIXTURE_DIRECTORY}/public-2.1.0-preserve-settings.json" | cut -d " " -f 1) == "${PUBLIC_2_1_0_SETTINGS_SHA256}" ]] \
  || fail 'public 2.1.0 preserve settings fixture hash changed'
[[ $(sha256sum "${FIXTURE_DIRECTORY}/public-2.1.0-preserve-state.json" | cut -d " " -f 1) == "${PUBLIC_2_1_0_STATE_SHA256}" ]] \
  || fail 'public 2.1.0 preserve state fixture hash changed'
for volume in "${VOLUMES[@]}"; do
  docker volume create "${volume}" >/dev/null
done

docker run --rm \
  --platform "$TEST_PLATFORM" \
  --entrypoint /usr/local/libexec/antigravity-real \
  "${IMAGE}" plugin validate \
  /usr/local/share/antigravity-ha/plugins/home-assistant >/dev/null \
  || fail 'image-managed Home Assistant plugin did not validate'

run_script "${MAIN_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity
  jq -n '
    {
      antigravity_tool_permission: "strict",
      antigravity_terminal_sandbox: true,
      browser_approval_policy: "safe",
      antigravity_user_files_update_mode: "preserve"
    }
  ' > /data/options.json
SCRIPT

FIRST_OUTPUT=$(run_helper "${MAIN_VOLUME}") \
  || fail 'first native settings bootstrap failed'
assert_json "${FIRST_OUTPUT}" '
  .mode == "preserve"
  and .requested_mode == "preserve"
  and (.created | sort) == ["mcp", "settings"]
  and .refreshed == []
  and .backup_directory == null
'
assert_sanitized "${FIRST_OUTPUT}"
run_script "${MAIN_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  test "$(stat -c "%a:%U:%G" /data/home/.gemini/antigravity-cli/settings.json)" = 600:root:root
  test "$(stat -c "%a:%U:%G" /data/home/.gemini/config/mcp_config.json)" = 600:root:root
  jq --exit-status '
    (has("toolPermission") | not)
    and (has("enableTerminalSandbox") | not)
    and .allowNonWorkspaceAccess == true
    and .altScreenMode == "never"
    and (.permissions.allow | index("command(*)") == null)
    and (.permissions.allow | index("mcp(*)") == null)
    and (.permissions.allow | index("read_file(*)") == null)
    and (.permissions.allow | index("read_url(*)") != null)
    and (.permissions.ask | index("command(*)") != null)
    and (.permissions.ask | index("write_file(*)") == null)
    and (.permissions.allow | index("mcp(ha_files/ha_files_read_text)") != null)
    and (.permissions.allow | index("mcp(ha_files/ha_files_list)") != null)
    and (.permissions.ask | index("mcp(ha_files/ha_files_write_text)") != null)
    and (.permissions.deny | index("read_file(*)") != null)
    and (.permissions.deny | index("write_file(*)") != null)
    and (.permissions.ask | index("execute_url(*)") != null)
    and (.permissions.deny | index("read_file(/config/secrets.yaml)") != null)
    and (.permissions.allow | index("read_file(/config)") == null)
    and (.permissions.deny | index("read_file(/data/home/.gemini/antigravity-cli/settings.json)") != null)
    and (.permissions.deny | index("write_file(/data/home/.gemini/antigravity-cli/settings.json)") != null)
    and (([
      "read_file(/data/home/.aws)",
      "write_file(/data/home/.aws)",
      "read_file(/data/home/.azure)",
      "write_file(/data/home/.azure)",
      "read_file(/data/home/.config/gcloud)",
      "write_file(/data/home/.config/gcloud)",
      "read_file(/data/home/.kube)",
      "write_file(/data/home/.kube)",
      "read_file(/data/home/.docker/config.json)",
      "write_file(/data/home/.docker/config.json)",
      "read_file(/data/home/.netrc)",
      "write_file(/data/home/.netrc)",
      "read_file(/data/home/.npmrc)",
      "write_file(/data/home/.npmrc)"
    ] - .permissions.deny) | length == 0)
    and (.permissions.allow | length == (unique | length))
    and (.permissions.deny | length == (unique | length))
    and (.permissions.deny | index("read_file(/data)") == null)
    and (.permissions.deny | index("write_file(/data)") == null)
    and (.permissions.allow | index("mcp(playwright/browser_snapshot)") != null)
    and (.permissions.allow | index("mcp(playwright/browser_click)") == null)
    and (.permissions.ask | index("mcp(playwright/browser_click)") == null)
    and (.permissions.allow | index("mcp(ha_change/ha_change_propose)") != null)
    and (.permissions.allow | index("mcp(telegram_action/telegram_action_propose)") != null)
  ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null
  jq --exit-status '.mcpServers == {}' \
    /data/home/.gemini/config/mcp_config.json >/dev/null
  test "$(stat -c "%a:%U:%G" /data/antigravity-ha/migration/native-files-state.json)" = 600:root:root
  jq --exit-status '
    (.managed.settings.keys | index("toolPermission") == null)
    and (.managed.settings.keys | index("enableTerminalSandbox") == null)
    and (.managed.settings.keys | index("permissions") != null)
    and (.managed.settings.permission_rules | index("command(*)") != null)
    and (.managed.settings.permission_rules | index("mcp(*)") == null)
    and (.managed.settings.permission_rules
      | index("mcp(telegram_action/telegram_action_propose)") != null)
    and (.managed.settings.permission_rules
      | index("write_file(/data/home/.gemini/antigravity-cli/settings.json)") != null)
  ' /data/antigravity-ha/migration/native-files-state.json >/dev/null
  settings=/data/home/.gemini/antigravity-cli/settings.json
  first_native_hash=$(sha256sum "${settings}" | cut -d " " -f 1)
  set +e
  printf '%s\n' request-review-first-launch-canary | env -i \
    AGY_CLI_DISABLE_AUTO_UPDATE=true \
    HOME=/data/home \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    TERM=dumb \
    timeout --kill-after=2 8 /usr/local/libexec/antigravity-real \
      --output-format stream-json --print-timeout 2s \
      >/tmp/request-first-native.out 2>/tmp/request-first-native.err
  native_status=$?
  set -e
  test "${native_status}" = 1
  test "$(sha256sum "${settings}" | cut -d " " -f 1)" = \
    "${first_native_hash}"
  test -z "$(find /data/home/.gemini/antigravity-cli -maxdepth 1 \
    -name 'settings.json.*.tmp' -print -quit)"
  AGY_CLI_DISABLE_AUTO_UPDATE=true HOME=/data/home \
    /usr/local/libexec/antigravity-real agent </dev/null >/dev/null
SCRIPT

run_script "${MAIN_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  install -d -m 0700 /run/antigravity-ha
  test "$(stat -c "%a" /usr/local/bin/agy-settings)" = 755
  test "$(stat -c "%a" /usr/local/share/antigravity-ha/antigravity-settings-update.mjs)" = 644

  settings=/data/home/.gemini/antigravity-cli/settings.json
  protected_before=$(jq -c \
    '{permissions,enableTerminalSandbox,allowNonWorkspaceAccess,toolPermission,artifactReviewPolicy}' "${settings}")
  digest=$(/usr/local/bin/agy-settings sha256)
  printf '%s\n' "$(jq -nc --arg digest "${digest}" \
    '{
      expected_sha256: $digest,
      patch: {
        clearScrollbackOnResize: true,
        colorScheme: "tokyo night",
        disableSlashCommands: false,
        modelProvider: "",
        showFeedbackSurvey: true,
        showTips: true
      }
    }')" \
    | /usr/local/bin/agy-settings patch >/tmp/agy-settings-result.json
  jq --exit-status \
    '.status == "updated"
      and (.changed_keys == [
        "clearScrollbackOnResize","colorScheme","disableSlashCommands",
        "modelProvider","showFeedbackSurvey","showTips"
      ])' \
    /tmp/agy-settings-result.json >/dev/null
  test "$(jq -c '{permissions,enableTerminalSandbox,allowNonWorkspaceAccess,toolPermission,artifactReviewPolicy}' \
    "${settings}")" = "${protected_before}"
  jq --exit-status \
    '.colorScheme == "tokyo night"
      and (has("clearScrollbackOnResize") | not)
      and (has("disableSlashCommands") | not)
      and (has("modelProvider") | not)
      and (has("showFeedbackSurvey") | not)
      and (has("showTips") | not)' "${settings}" >/dev/null

  digest=$(/usr/local/bin/agy-settings sha256)
  stale_digest=${digest}
  printf '%s\n' "$(jq -nc --arg digest "${digest}" \
    '{
      expected_sha256: $digest,
      patch: {colorScheme: "tokyo <&>\u2028\u2029"}
    }')" \
    | /usr/local/bin/agy-settings patch >/tmp/agy-settings-scalar.json
  jq --exit-status \
    '.status == "updated" and .changed_keys == ["colorScheme"]' \
    /tmp/agy-settings-scalar.json >/dev/null
  jq --exit-status \
    '.colorScheme == "tokyo <&>\u2028\u2029"' "${settings}" >/dev/null
  grep -Fq '"colorScheme": "tokyo \u003c\u0026\u003e\u2028\u2029"' \
    "${settings}"
  ! grep -Fq '<&>' "${settings}"

  # Public 2.1.0 accepted arbitrary top-level settings through this helper.
  # Deletion-only recovery for one of those stale typed values is safe: it
  # cannot introduce a private-schema transform and must preserve policy.
  jq '.customModelsConfig = {invalid: {nested: true}}' "${settings}" \
    > "${settings}.stale"
  chmod 0600 "${settings}.stale"
  mv "${settings}.stale" "${settings}"
  digest=$(/usr/local/bin/agy-settings sha256)
  printf '%s\n' "$(jq -nc --arg digest "${digest}" \
    '{expected_sha256:$digest,patch:{customModelsConfig:null}}')" \
    | /usr/local/bin/agy-settings patch \
      >/tmp/agy-settings-unknown-null-recovery.json
  jq --exit-status \
    '.status == "updated" and .changed_keys == ["customModelsConfig"]' \
    /tmp/agy-settings-unknown-null-recovery.json >/dev/null
  jq --exit-status 'has("customModelsConfig") | not' "${settings}" >/dev/null
  test "$(jq -c '{permissions,enableTerminalSandbox,allowNonWorkspaceAccess,toolPermission,artifactReviewPolicy}' \
    "${settings}")" = "${protected_before}"

  # Arbitrary objects, arrays and unknown top-level keys cannot be proven
  # byte-stable against the native private settings schema. Reject them before
  # touching the protected file instead of recreating the atomic-rename fault.
  digest=$(/usr/local/bin/agy-settings sha256)
  before_unsupported=$(sha256sum "${settings}" | cut -d " " -f 1)
  set +e
  printf '{"expected_sha256":"%s","patch":{"nativeNumbers":{"unsafe":9007199254740993,"negativeZero":-0,"exponent":1.2300e+06,"overflow":1e400}}}\n' \
    "${digest}" | /usr/local/bin/agy-settings patch \
    >/tmp/agy-settings-unsupported.out 2>/tmp/agy-settings-unsupported.err
  unsupported_status=$?
  set -e
  test "${unsupported_status}" = 65
  grep -Fq 'patch contains an unsupported top-level setting' \
    /tmp/agy-settings-unsupported.err
  test "$(sha256sum "${settings}" | cut -d " " -f 1)" = \
    "${before_unsupported}"
  digest=$(/usr/local/bin/agy-settings sha256)
  set +e
  printf '%s\n' "$(jq -nc --arg digest "${digest}" \
    '{expected_sha256:$digest,patch:{customModelsConfig:[]}}')" \
    | /usr/local/bin/agy-settings patch \
      >/tmp/agy-settings-unsupported-array.out \
      2>/tmp/agy-settings-unsupported-array.err
  unsupported_status=$?
  set -e
  test "${unsupported_status}" = 65
  grep -Fq 'patch contains an unsupported top-level setting' \
    /tmp/agy-settings-unsupported-array.err
  test "$(sha256sum "${settings}" | cut -d " " -f 1)" = \
    "${before_unsupported}"
  for unsupported_patch in \
    '{"colorScheme":{"nested":"no"}}' \
    '{"altScreenMode":"sometimes"}' \
    '{"showTips":"false"}'; do
    digest=$(/usr/local/bin/agy-settings sha256)
    set +e
    printf '%s\n' "$(jq -nc --arg digest "${digest}" \
      --argjson patch "${unsupported_patch}" \
      '{expected_sha256:$digest,patch:$patch}')" \
      | /usr/local/bin/agy-settings patch \
        >/tmp/agy-settings-type.out 2>/tmp/agy-settings-type.err
    unsupported_status=$?
    set -e
    test "${unsupported_status}" = 65
    grep -Fq 'patch contains an unsupported scalar setting value' \
      /tmp/agy-settings-type.err
    test "$(sha256sum "${settings}" | cut -d " " -f 1)" = \
      "${before_unsupported}"
  done
  test "$(jq -c '{permissions,enableTerminalSandbox,allowNonWorkspaceAccess,toolPermission,artifactReviewPolicy}' \
    "${settings}")" = "${protected_before}"
  jq --exit-status '
    keys_unsorted == (keys | sort)
    and (.permissions | keys_unsorted) == ["allow", "deny", "ask"]
    and (has("toolPermission") | not)
    and (has("enableTerminalSandbox") | not)
  ' "${settings}" >/dev/null
  patched_hash=$(sha256sum "${settings}" | cut -d " " -f 1)
  set +e
  printf '%s\n' agy-settings-native-hash-canary | env -i \
    AGY_CLI_DISABLE_AUTO_UPDATE=true \
    HOME=/data/home \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    TERM=dumb \
    timeout --kill-after=2 8 /usr/local/libexec/antigravity-real \
      --output-format stream-json --print-timeout 2s \
      >/tmp/agy-settings-native.out 2>/tmp/agy-settings-native.err
  native_status=$?
  set -e
  test "${native_status}" = 1
  test "$(sha256sum "${settings}" | cut -d " " -f 1)" = "${patched_hash}"
  test -z "$(find /data/home/.gemini/antigravity-cli -maxdepth 1 \
    -name 'settings.json.*.tmp' -print -quit)"
  set +e
  printf '%s\n' agy-settings-native-special-character-canary | env -i \
    AGY_CLI_DISABLE_AUTO_UPDATE=true \
    HOME=/data/home \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    TERM=dumb \
    timeout --kill-after=2 8 /usr/local/libexec/antigravity-real \
      --output-format stream-json --print-timeout 2s \
      >/tmp/agy-settings-native-second.out \
      2>/tmp/agy-settings-native-second.err
  native_status=$?
  set -e
  test "${native_status}" = 1
  test "$(sha256sum "${settings}" | cut -d " " -f 1)" = "${patched_hash}"
  test -z "$(find /data/home/.gemini/antigravity-cli -maxdepth 1 \
    -name 'settings.json.*.tmp' -print -quit)"

  stable_hash=$(sha256sum "${settings}" | cut -d " " -f 1)
  set +e
  printf '%s\n' "$(jq -nc --arg digest "${stale_digest}" \
    '{expected_sha256:$digest,patch:{showTips:false}}')" \
    | /usr/local/bin/agy-settings patch >/tmp/stale.out 2>/tmp/stale.err
  stale_status=$?
  set -e
  test "${stale_status}" = 65
  grep -Fq 'settings.json changed' /tmp/stale.err
  test "$(sha256sum "${settings}" | cut -d " " -f 1)" = "${stable_hash}"

  for protected_patch in \
    '{"permissions":{"allow":[]}}' \
    '{"enableTerminalSandbox":true}' \
    '{"allowNonWorkspaceAccess":true}' \
    '{"toolPermission":"always-proceed"}' \
    '{"artifactReviewPolicy":"never"}'; do
    digest=$(/usr/local/bin/agy-settings sha256)
    set +e
    printf '%s\n' "$(jq -nc --arg digest "${digest}" --argjson patch "${protected_patch}" \
      '{expected_sha256:$digest,patch:$patch}')" \
      | /usr/local/bin/agy-settings patch >/tmp/protected.out 2>/tmp/protected.err
    protected_status=$?
    set -e
    test "${protected_status}" = 65
    grep -Fq 'is App-managed' /tmp/protected.err
    test "$(sha256sum "${settings}" | cut -d " " -f 1)" = "${stable_hash}"
  done

  chmod 0644 "${settings}"
  set +e
  /usr/local/bin/agy-settings sha256 >/tmp/mode.out 2>/tmp/mode.err
  mode_status=$?
  set -e
  test "${mode_status}" = 65
  chmod 0600 "${settings}"

  mv "${settings}" "${settings}.real"
  ln -s "${settings}.real" "${settings}"
  set +e
  /usr/local/bin/agy-settings sha256 >/tmp/link.out 2>/tmp/link.err
  link_status=$?
  set -e
  test "${link_status}" = 65
  unlink "${settings}"
  mv "${settings}.real" "${settings}"

  exec 8>/run/antigravity-ha/user-files-update.lock
  /usr/bin/flock --exclusive --nonblock 8
  set +e
  /usr/local/bin/agy-settings sha256 >/tmp/lock.out 2>/tmp/lock.err
  lock_status=$?
  set -e
  test "${lock_status}" = 75
  grep -Fq 'another settings update is active' /tmp/lock.err
SCRIPT

run_script "${MAIN_VOLUME}" \
  "${SETTINGS_SECRET}" "${MCP_SECRET}" "${AUTH_SECRET}" "${LEGACY_SECRET}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  jq --arg marker "$1" '
    .user_marker = $marker
    | .toolPermission = "always-proceed"
    | .permissions.allow += ["user(custom/read)"]
    | .permissions.ask += ["mcp(playwright/browser_snapshot)"]
    | .permissions.user_bucket = ["user(custom/permission)"]
  ' \
    /data/home/.gemini/antigravity-cli/settings.json > /tmp/settings.json
  mv /tmp/settings.json /data/home/.gemini/antigravity-cli/settings.json
  jq --arg marker "$2" '
    .user_marker = $marker
    | .mcpServers.user_server = {
        command: "/usr/local/bin/user-owned-mcp",
        args: ["--private"]
      }
  ' \
    /data/home/.gemini/config/mcp_config.json > /tmp/mcp.json
  mv /tmp/mcp.json /data/home/.gemini/config/mcp_config.json
  printf '{"token":"%s"}\n' "$3" > /data/antigravity/auth.json
  printf '# %s\n' "$4" > /data/antigravity/config.toml
  chmod 0600 /data/home/.gemini/antigravity-cli/settings.json \
    /data/home/.gemini/config/mcp_config.json \
    /data/antigravity/auth.json /data/antigravity/config.toml
SCRIPT

SETTINGS_HASH=$(path_hash "${MAIN_VOLUME}" /data/home/.gemini/antigravity-cli/settings.json)
MCP_HASH=$(path_hash "${MAIN_VOLUME}" /data/home/.gemini/config/mcp_config.json)
AUTH_HASH=$(path_hash "${MAIN_VOLUME}" /data/antigravity/auth.json)
LEGACY_HASH=$(path_hash "${MAIN_VOLUME}" /data/antigravity/config.toml)

PRESERVE_OUTPUT=$(run_helper "${MAIN_VOLUME}") \
  || fail 'native preserve rerun failed'
assert_json "${PRESERVE_OUTPUT}" '
  .mode == "preserve"
  and .created == []
  and .permission_migration == "applied"
  and .refreshed == ["settings"]
  and (.backup_directory
    | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
  and (.warnings | any(contains("Legacy")))
  and (.warnings | any(contains("canonicalized settings.json")))
'
assert_sanitized "${PRESERVE_OUTPUT}"
PRESERVE_BACKUP_DIRECTORY=$(jq --raw-output '.backup_directory' \
  <<<"${PRESERVE_OUTPUT}")
[[ $(path_hash "${MAIN_VOLUME}" \
  "${PRESERVE_BACKUP_DIRECTORY}/settings.before") == "${SETTINGS_HASH}" ]]
SETTINGS_HASH_AFTER_PRESERVE=$(path_hash "${MAIN_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
[[ ${SETTINGS_HASH_AFTER_PRESERVE} != "${SETTINGS_HASH}" ]]
[[ $(path_hash "${MAIN_VOLUME}" /data/home/.gemini/config/mcp_config.json) == "${MCP_HASH}" ]]

run_script "${MAIN_VOLUME}" <<'SCRIPT'
  jq '.antigravity_user_files_update_mode = "refresh_managed"' \
    /data/options.json > /tmp/options.json
  chmod 0600 /tmp/options.json
  mv /tmp/options.json /data/options.json
SCRIPT
MANAGED_OUTPUT=$(run_helper "${MAIN_VOLUME}") \
  || fail 'refresh_managed helper run failed'
assert_json "${MANAGED_OUTPUT}" '
  .mode == "refresh_managed"
  and .refreshed == []
  and .backup_directory == null
'
assert_sanitized "${MANAGED_OUTPUT}"
[[ $(path_hash "${MAIN_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${SETTINGS_HASH_AFTER_PRESERVE}" ]]
[[ $(path_hash "${MAIN_VOLUME}" /data/home/.gemini/config/mcp_config.json) == "${MCP_HASH}" ]]
run_script "${MAIN_VOLUME}" "${SETTINGS_SECRET}" \
  "${PRESERVE_BACKUP_DIRECTORY}" <<'SCRIPT'
  set -Eeuo pipefail
  jq --arg marker "$1" --exit-status '
    .user_marker == $marker
    and (has("toolPermission") | not)
    and (.permissions.allow | index("user(custom/read)") != null)
    and (.permissions.allow | index("mcp(playwright/browser_snapshot)") != null)
    and (.permissions.ask | index("mcp(playwright/browser_snapshot)") == null)
    and (.permissions.allow | index("command(*)") == null)
    and (.permissions.allow | index("mcp(*)") == null)
    and (.permissions.allow | index("read_file(*)") == null)
    and (.permissions.allow | index("read_url(*)") != null)
    and (.permissions.ask | index("command(*)") != null)
    and (.permissions.ask | index("write_file(*)") == null)
    and (.permissions.allow | index("mcp(ha_files/ha_files_read_text)") != null)
    and (.permissions.ask | index("mcp(ha_files/ha_files_write_text)") != null)
    and (.permissions.deny | index("read_file(*)") != null)
    and (.permissions.deny | index("write_file(*)") != null)
    and (.permissions.ask | index("execute_url(*)") != null)
    and (.permissions.deny
      | index("write_file(/data/home/.gemini/antigravity-cli/settings.json)") != null)
    and (.permissions.deny
      | index("read_file(/data/home/.gemini/config/mcp_config.json)") != null)
    and (.permissions.deny
      | index("write_file(/data/home/.gemini/config/mcp_config.json)") != null)
    and (.permissions | has("user_bucket") | not)
  ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null
  test -f "$2/settings.before"
  test ! -e "$2/mcp.before"
SCRIPT

run_script "${MAIN_VOLUME}" <<'SCRIPT'
  jq '
    .antigravity_user_files_update_mode = "reset_v2"
    | .antigravity_tool_permission = "request-review"
    | .antigravity_terminal_sandbox = false
    | .browser_approval_policy = "always"
  ' /data/options.json > /tmp/options.json
  chmod 0600 /tmp/options.json
  mv /tmp/options.json /data/options.json
SCRIPT
RESET_OUTPUT=$(run_helper "${MAIN_VOLUME}") \
  || fail 'same-version reset_v2 permission recovery failed'
assert_json "${RESET_OUTPUT}" '
  .mode == "reset_v2"
  and .refreshed == ["settings"]
  and (.backup_directory | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
'
assert_sanitized "${RESET_OUTPUT}"
run_script "${MAIN_VOLUME}" "${SETTINGS_SECRET}" <<'SCRIPT'
  jq --arg marker "$1" --exit-status '
    .user_marker == $marker
    and (has("toolPermission") | not)
    and ((["mcp(ha_files/ha_files_write_text)", "execute_url(*)", "command(*)"]
      - .permissions.ask) | length == 0)
    and (.permissions.deny | index("read_file(*)") != null)
    and (.permissions.deny | index("write_file(*)") != null)
    and (.permissions.allow | index("user(custom/read)") == null)
    and (.permissions | has("user_bucket") | not)
    and (.permissions.allow
      | index("mcp(telegram_action/telegram_action_propose)") != null)
  ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null
SCRIPT
[[ $(path_hash "${MAIN_VOLUME}" /data/home/.gemini/config/mcp_config.json) == "${MCP_HASH}" ]]
[[ $(path_hash "${MAIN_VOLUME}" /data/antigravity/auth.json) == "${AUTH_HASH}" ]]
[[ $(path_hash "${MAIN_VOLUME}" /data/antigravity/config.toml) == "${LEGACY_HASH}" ]]
RESET_IDEMPOTENT_OUTPUT=$(run_helper "${MAIN_VOLUME}") \
  || fail 'same-version reset_v2 idempotency run failed'
assert_json "${RESET_IDEMPOTENT_OUTPUT}" '
  .mode == "reset_v2"
  and .refreshed == []
  and .backup_directory == null
'

run_script "${RESET_VOLUME}" "${SETTINGS_SECRET}" "${MCP_SECRET}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity
  jq -n '{
    antigravity_tool_permission: "strict",
    antigravity_terminal_sandbox: true,
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  install -d -m 0700 /run/antigravity-ha
  /usr/local/bin/antigravity-user-files-update >/dev/null
  jq --arg marker "$1" '
    .user_reset_key = $marker
    | .toolPermission = "always-proceed"
    | .enableTerminalSandbox = true
    | .permissions.deny += ["user(custom/deny)"]
  ' /data/home/.gemini/antigravity-cli/settings.json > /tmp/settings.json
  mv /tmp/settings.json /data/home/.gemini/antigravity-cli/settings.json
  jq --arg marker "$2" '
    .user_reset_key = $marker
    | .mcpServers.user_reset_server = {
        command: "/usr/local/bin/user-reset-mcp",
        args: []
      }
  ' /data/home/.gemini/config/mcp_config.json > /tmp/mcp.json
  mv /tmp/mcp.json /data/home/.gemini/config/mcp_config.json
  jq '
    .antigravity_user_files_update_mode = "reset_v2"
    | .antigravity_tool_permission = "request-review"
    | .antigravity_terminal_sandbox = false
  ' /data/options.json > /tmp/options.json
  mv /tmp/options.json /data/options.json
  chmod 0600 /data/options.json \
    /data/home/.gemini/antigravity-cli/settings.json \
    /data/home/.gemini/config/mcp_config.json
SCRIPT
RESET_SETTINGS_HASH=$(path_hash "${RESET_VOLUME}" /data/home/.gemini/antigravity-cli/settings.json)
RESET_MCP_HASH=$(path_hash "${RESET_VOLUME}" /data/home/.gemini/config/mcp_config.json)
RESET_OUTPUT=$(run_helper "${RESET_VOLUME}") \
  || fail 'ownership-bound reset_v2 helper run failed'
assert_json "${RESET_OUTPUT}" '
  .mode == "reset_v2"
  and .refreshed == ["settings"]
  and (.backup_directory | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
'
assert_sanitized "${RESET_OUTPUT}"
BACKUP_DIRECTORY=$(jq --raw-output '.backup_directory' <<<"${RESET_OUTPUT}")
run_script "${RESET_VOLUME}" "${BACKUP_DIRECTORY}" "${SETTINGS_SECRET}" "${MCP_SECRET}" <<'SCRIPT'
  set -Eeuo pipefail
  backup=$1
  test "$(stat -c "%a:%U:%G" "${backup}")" = 700:root:root
  test "$(stat -c "%a:%U:%G" "${backup}/settings.before")" = 600:root:root
  test ! -e "${backup}/mcp.before"
  jq --arg marker "$2" --exit-status '
    (has("toolPermission") | not)
    and (has("enableTerminalSandbox") | not)
    and .user_reset_key == $marker
    and (.permissions.deny | index("user(custom/deny)") == null)
    and (.permissions.allow | index("mcp(playwright/browser_snapshot)") != null)
    and (.permissions.allow | index("mcp(playwright/browser_click)") == null)
    and (.permissions.ask | index("mcp(playwright/browser_click)") == null)
    and (.permissions.allow | index("mcp(telegram_action/telegram_action_propose)") != null)
  ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null
  jq --arg marker "$3" --exit-status '
    .user_reset_key == $marker
    and .mcpServers.user_reset_server.command == "/usr/local/bin/user-reset-mcp"
  ' /data/home/.gemini/config/mcp_config.json >/dev/null
SCRIPT
[[ $(path_hash "${RESET_VOLUME}" "${BACKUP_DIRECTORY}/settings.before") == "${RESET_SETTINGS_HASH}" ]]
[[ $(path_hash "${RESET_VOLUME}" /data/home/.gemini/config/mcp_config.json) == "${RESET_MCP_HASH}" ]]

# The released 2.0.6 preserve output is pinned byte-for-byte as a public-image
# fixture. Its App ownership record is the authority for this one-shot repair;
# the settings contents alone never grant migration ownership.
run_script "${PERMISSION_MIGRATION_VOLUME}" \
  "${PUBLIC_2_0_6_SETTINGS_SHA256}" "${PUBLIC_2_0_6_STATE_SHA256}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity /data/antigravity-ha/migration \
    /data/home/.gemini/antigravity-cli /data/home/.gemini/config \
    /run/antigravity-ha
  jq -n '{
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: true,
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  install -m 0600 /test-fixtures/public-2.0.6-preserve-settings.json \
    /data/home/.gemini/antigravity-cli/settings.json
  install -m 0600 /test-fixtures/public-2.0.6-preserve-state.json \
    /data/antigravity-ha/migration/native-files-state.json
  install -m 0600 /etc/antigravity/mcp_config.json \
    /data/home/.gemini/config/mcp_config.json
  test "$(sha256sum /data/home/.gemini/antigravity-cli/settings.json \
    | cut -d ' ' -f 1)" = "$1"
  test "$(sha256sum /data/antigravity-ha/migration/native-files-state.json \
    | cut -d ' ' -f 1)" = "$2"
  jq --exit-status '
    (.permissions.allow
      | index("mcp(ha_read/ha_read_storage_usage)") == null)
  ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null
  jq --exit-status '
    (.managed.settings.permission_rules
      | index("mcp(ha_read/ha_read_storage_usage)") == null)
  ' /data/antigravity-ha/migration/native-files-state.json >/dev/null

  jq '
    .toolPermission = "strict"
    | .permissions.allow = ["user(custom/allow)"] + .permissions.allow
    | .permissions.ask += ["user(custom/ask)"]
    | .permissions.deny += ["user(custom/deny)"]
    | .permissions.user_policy = {owner: "user", enabled: true}
    | .user_suffix = "preserve-after-permissions"
  ' /data/home/.gemini/antigravity-cli/settings.json > /tmp/settings.json
  awk '
    /^  "permissions":/ {
      print "  \"user_byte_marker\"  :  \"preserve\\\\u002dexact\","
      print "  \"user_numbers\": {\"unsafe\":9007199254740993,\"negativeZero\":-0,\"exponent\":1.2300e+06,\"overflow\":1e400,\"nested\":[9007199254740993,-0,1.2300e+06,1e400]},"
    }
    { print }
  ' /tmp/settings.json > /data/home/.gemini/antigravity-cli/settings.json
  chmod 0600 /data/home/.gemini/antigravity-cli/settings.json
  cp /data/home/.gemini/antigravity-cli/settings.json \
    /data/antigravity-ha/migration/test-settings-before
  chmod 0600 /data/antigravity-ha/migration/test-settings-before
SCRIPT

PERMISSION_SETTINGS_HASH_BEFORE=$(path_hash \
  "${PERMISSION_MIGRATION_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
PERMISSION_STATE_HASH_BEFORE=$(path_hash \
  "${PERMISSION_MIGRATION_VOLUME}" \
  /data/antigravity-ha/migration/native-files-state.json)
PERMISSION_UNRELATED_HASH_BEFORE=$(run_script \
  "${PERMISSION_MIGRATION_VOLUME}" <<'SCRIPT'
  jq --sort-keys \
    'del(.permissions,.enableTerminalSandbox,.allowNonWorkspaceAccess,.toolPermission)' \
    /data/home/.gemini/antigravity-cli/settings.json \
    | sha256sum | cut -d ' ' -f 1
SCRIPT
)

# Stop immediately after the durable prepared journal is written. The target
# and ownership state must remain untouched, then the next normal invocation
# must roll back the prepared transaction and apply a fresh atomic migration.
run_script "${PERMISSION_MIGRATION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  awk '
    { print }
    !injected && /await writePrivateJson\(activeJournalPath, journal\);/ {
      print "    process.kill(process.pid, \"SIGKILL\");"
      injected = 1
    }
  ' /usr/local/share/antigravity-ha/user-files-update.mjs \
    > /tmp/user-files-permission-crash.mjs
  cp /usr/local/share/antigravity-ha/telegram-permission-policy.mjs /tmp/
  set +e
  node /tmp/user-files-permission-crash.mjs >/tmp/crash-output 2>&1
  status=$?
  set -e
  test "$status" -eq 137
  jq --exit-status '
    .phase == "prepared"
    and .scopes == ["settings"]
  ' /data/antigravity-ha/migration/native-files.json >/dev/null
  transaction=$(jq --raw-output '.transaction' \
    /data/antigravity-ha/migration/native-files.json)
  jq --exit-status '
    .files.settings.existed == true
    and (.files.settings.before_sha256 != .files.settings.candidate_sha256)
    and .state.existed == true
    and (.state.before_sha256 != .state.candidate_sha256)
  ' "/data/antigravity-ha/backups/native-files/${transaction}/metadata.json" \
    >/dev/null
  cmp --silent /data/antigravity-ha/migration/test-settings-before \
    /data/home/.gemini/antigravity-cli/settings.json
SCRIPT
[[ $(path_hash "${PERMISSION_MIGRATION_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${PERMISSION_SETTINGS_HASH_BEFORE}" ]]
[[ $(path_hash "${PERMISSION_MIGRATION_VOLUME}" \
  /data/antigravity-ha/migration/native-files-state.json) == \
  "${PERMISSION_STATE_HASH_BEFORE}" ]]

PERMISSION_MIGRATION_OUTPUT=$(run_helper "${PERMISSION_MIGRATION_VOLUME}") \
  || fail 'public 2.0.6 preserve permission migration failed'
assert_json "${PERMISSION_MIGRATION_OUTPUT}" '
  .mode == "preserve"
  and .permission_migration == "applied"
  and .recovered == true
  and .created == []
  and .refreshed == ["settings"]
  and .warnings == ["antigravity_terminal_sandbox=true is deprecated and was normalized to false because the privileged native sandbox is unsupported; run_command uses the AppArmor command boundary"]
  and (.backup_directory | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
'
PERMISSION_BACKUP_DIRECTORY=$(jq --raw-output '.backup_directory' \
  <<<"${PERMISSION_MIGRATION_OUTPUT}")
[[ $(path_hash "${PERMISSION_MIGRATION_VOLUME}" \
  "${PERMISSION_BACKUP_DIRECTORY}/settings.before") == \
  "${PERMISSION_SETTINGS_HASH_BEFORE}" ]]
PERMISSION_UNRELATED_HASH_AFTER=$(run_script \
  "${PERMISSION_MIGRATION_VOLUME}" <<'SCRIPT'
  jq --sort-keys \
    'del(.permissions,.enableTerminalSandbox,.allowNonWorkspaceAccess,.toolPermission)' \
    /data/home/.gemini/antigravity-cli/settings.json \
    | sha256sum | cut -d ' ' -f 1
SCRIPT
)
[[ "${PERMISSION_UNRELATED_HASH_AFTER}" == \
  "${PERMISSION_UNRELATED_HASH_BEFORE}" ]] \
  || fail 'preserve permission migration changed unrelated settings semantics'
run_script "${PERMISSION_MIGRATION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  jq --exit-status '
    (has("toolPermission") | not)
    and (has("enableTerminalSandbox") | not)
    and keys_unsorted == (keys | sort)
    and (.permissions | keys_unsorted) == ["allow", "deny", "ask"]
    and .user_byte_marker == "preserve\\u002dexact"
    and .user_suffix == "preserve-after-permissions"
    and (.permissions | has("user_policy") | not)
    and (.permissions.allow | index("user(custom/allow)") != null)
    and (.permissions.ask | index("user(custom/ask)") != null)
    and (.permissions.deny | index("user(custom/deny)") != null)
    and .allowNonWorkspaceAccess == true
    and (.permissions.allow | index("read_file(*)") == null)
    and (.permissions.allow | index("read_url(*)") != null)
    and (.permissions.ask | index("write_file(*)") == null)
    and (.permissions.allow | index("mcp(ha_files/ha_files_read_text)") != null)
    and (.permissions.ask | index("mcp(ha_files/ha_files_write_text)") != null)
    and (.permissions.deny | index("read_file(*)") != null)
    and (.permissions.deny | index("write_file(*)") != null)
    and (.permissions.ask | index("execute_url(*)") != null)
    and (.permissions.ask | index("command(*)") != null)
    and (.permissions.deny | index("read_file(/data/home/.gemini/antigravity-cli/settings.json)") != null)
    and (.permissions.allow
      | index("mcp(ha_read/ha_read_storage_usage)") != null)
    and (.permissions.deny | index("write_file(/data/home/.gemini/antigravity-cli/settings.json)") != null)
    and (([
      "read_file(/data/home/.aws)",
      "write_file(/data/home/.aws)",
      "read_file(/data/home/.azure)",
      "write_file(/data/home/.azure)",
      "read_file(/data/home/.config/gcloud)",
      "write_file(/data/home/.config/gcloud)",
      "read_file(/data/home/.kube)",
      "write_file(/data/home/.kube)",
      "read_file(/data/home/.docker/config.json)",
      "write_file(/data/home/.docker/config.json)",
      "read_file(/data/home/.netrc)",
      "write_file(/data/home/.netrc)",
      "read_file(/data/home/.npmrc)",
      "write_file(/data/home/.npmrc)"
    ] - .permissions.deny) | length == 0)
    and (.permissions.allow | length == (unique | length))
    and (.permissions.deny | length == (unique | length))
    and (.permissions.deny | index("read_file(/data)") == null)
    and (.permissions.deny | index("write_file(/data)") == null)
    and (.permissions.deny | index("read_file(/config/secrets.yaml)") != null)
    and (.permissions.deny | index("write_file(/config/.storage)") != null)
  ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null
  settings=/data/home/.gemini/antigravity-cli/settings.json
  grep -Fq '"unsafe": 9007199254740993' "${settings}"
  grep -Fq '"negativeZero": -0' "${settings}"
  grep -Fq '"exponent": 1.2300e+06' "${settings}"
  grep -Fq '"overflow": 1e400' "${settings}"
  test "$(grep -oF '9007199254740993' "${settings}" | wc -l)" = 2
  test "$(grep -oF -- '-0' "${settings}" | wc -l)" = 2
  test "$(grep -oF '1.2300e+06' "${settings}" | wc -l)" = 2
  test "$(grep -oF '1e400' "${settings}" | wc -l)" = 2
  jq --exit-status '
    (.applied.settings | length) == 1
    and (.managed.settings.permission_rules | index("read_file(/data)") == null)
    and (.managed.settings.permission_rules | index("write_file(/data)") == null)
    and (.managed.settings.permission_rules | index("read_file(*)") != null)
    and (.managed.settings.permission_rules
      | index("mcp(ha_read/ha_read_storage_usage)") != null)
  ' /data/antigravity-ha/migration/native-files-state.json >/dev/null
SCRIPT
# A completed non-Telegram migration may contain user-owned rules in the
# standard buckets, but its protected top-level fields are still App-owned.
# Simulate out-of-band drift and prove preserve repairs only those fields while
# keeping the user rules and returning to native-stable bytes.
run_script "${PERMISSION_MIGRATION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  settings=/data/home/.gemini/antigravity-cli/settings.json
  grep -Fq '"allowNonWorkspaceAccess": true' "${settings}"
  grep -Fq '"artifactReviewPolicy": "agent-decides"' "${settings}"
  grep -Fq '"write_file(*)"' "${settings}"
  sed \
    -e 's/"allowNonWorkspaceAccess": true/"allowNonWorkspaceAccess": "invalid"/' \
    -e 's/"artifactReviewPolicy": "agent-decides"/"artifactReviewPolicy": "allow"/' \
    "${settings}" | grep -vF '"write_file(*)"' > /tmp/settings.drift
  chmod 0600 /tmp/settings.drift
  mv /tmp/settings.drift "${settings}"
SCRIPT
PERMISSION_DRIFT_OUTPUT=$(run_helper "${PERMISSION_MIGRATION_VOLUME}") \
  || fail 'preserve did not repair App-owned top-level settings drift'
assert_json "${PERMISSION_DRIFT_OUTPUT}" '
  .permission_migration == "applied"
  and .created == []
  and .refreshed == ["settings"]
  and (.backup_directory
    | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
  and (.warnings | any(contains("canonicalized settings.json")))
'
run_script "${PERMISSION_MIGRATION_VOLUME}" <<'SCRIPT'
  jq --exit-status '
    .allowNonWorkspaceAccess == true
    and .artifactReviewPolicy == "agent-decides"
    and (.permissions.allow | index("user(custom/allow)") != null)
    and (.permissions.ask | index("user(custom/ask)") != null)
    and (.permissions.deny | index("user(custom/deny)") != null)
    and (.permissions.allow | index("command(*)") == null)
    and (.permissions.ask | index("command(*)") != null)
    and (.permissions.deny | index("write_file(*)") != null)
    and (.permissions | has("user_bucket") | not)
  ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null
SCRIPT
PERMISSION_SETTINGS_HASH_AFTER=$(path_hash \
  "${PERMISSION_MIGRATION_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
PERMISSION_STATE_HASH_AFTER=$(path_hash \
  "${PERMISSION_MIGRATION_VOLUME}" \
  /data/antigravity-ha/migration/native-files-state.json)
PERMISSION_BACKUP_COUNT=$(run_script "${PERMISSION_MIGRATION_VOLUME}" <<'SCRIPT'
  find /data/antigravity-ha/backups/native-files -mindepth 1 -maxdepth 1 \
    -type d | wc -l
SCRIPT
)
PERMISSION_IDEMPOTENT_OUTPUT=$(run_helper "${PERMISSION_MIGRATION_VOLUME}") \
  || fail 'public 2.0.6 preserve permission migration was not idempotent'
assert_json "${PERMISSION_IDEMPOTENT_OUTPUT}" '
  .permission_migration == "already_applied"
  and .recovered == false
  and .created == []
  and .refreshed == []
  and .backup_directory == null
  and .warnings == ["antigravity_terminal_sandbox=true is deprecated and was normalized to false because the privileged native sandbox is unsupported; run_command uses the AppArmor command boundary"]
'
[[ $(path_hash "${PERMISSION_MIGRATION_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${PERMISSION_SETTINGS_HASH_AFTER}" ]]
[[ $(path_hash "${PERMISSION_MIGRATION_VOLUME}" \
  /data/antigravity-ha/migration/native-files-state.json) == \
  "${PERMISSION_STATE_HASH_AFTER}" ]]
[[ $(run_script "${PERMISSION_MIGRATION_VOLUME}" <<'SCRIPT'
  find /data/antigravity-ha/backups/native-files -mindepth 1 -maxdepth 1 \
    -type d | wc -l
SCRIPT
) == "${PERMISSION_BACKUP_COUNT}" ]]

# Published 2.0.8 installed the shared native HOME but still placed command,
# mutation MCP, and interactive browser tools in ask. Preserve mode must prove
# that exact App-owned layout, replace only its permissions, and retain both
# the user's selected request-review policy and user-owned rules.
run_script "${PERMISSION_V208_MIGRATION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity /data/antigravity-ha/migration \
    /data/home/.gemini/antigravity-cli /data/home/.gemini/config
  jq -n '{
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: true,
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  jq '
    .permissions.allow += ["user(v208/allow)"]
    | .permissions.ask += ["user(v208/ask)"]
    | .permissions.deny += ["user(v208/deny)"]
  ' /test-fixtures/public-2.0.8-preserve-settings.json \
    > /data/home/.gemini/antigravity-cli/settings.json
  install -m 0600 /test-fixtures/public-2.0.8-preserve-state.json \
    /data/antigravity-ha/migration/native-files-state.json
  install -m 0600 /etc/antigravity/mcp_config.json \
    /data/home/.gemini/config/mcp_config.json
  chmod 0600 /data/home/.gemini/antigravity-cli/settings.json
  jq --exit-status '
    (.permissions.allow
      | index("mcp(ha_read/ha_read_storage_usage)") == null)
  ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null
  jq --exit-status '
    (.managed.settings.permission_rules
      | index("mcp(ha_read/ha_read_storage_usage)") == null)
  ' /data/antigravity-ha/migration/native-files-state.json >/dev/null
SCRIPT
PERMISSION_V208_OUTPUT=$(run_helper "${PERMISSION_V208_MIGRATION_VOLUME}") \
  || fail 'public 2.0.8 preserve permission migration failed'
assert_json "${PERMISSION_V208_OUTPUT}" '
  .mode == "preserve"
  and .permission_migration == "applied"
  and .created == []
  and .refreshed == ["settings"]
  and .warnings == ["antigravity_terminal_sandbox=true is deprecated and was normalized to false because the privileged native sandbox is unsupported; run_command uses the AppArmor command boundary"]
'
run_script "${PERMISSION_V208_MIGRATION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  jq --exit-status '
    (has("toolPermission") | not)
    and (has("enableTerminalSandbox") | not)
    and (.permissions.allow | index("user(v208/allow)") != null)
    and (.permissions.ask | index("user(v208/ask)") != null)
    and (.permissions.deny | index("user(v208/deny)") != null)
    and .allowNonWorkspaceAccess == true
    and (.permissions.allow | index("read_file(*)") == null)
    and (.permissions.allow | index("read_url(*)") != null)
    and (.permissions.allow | index("execute_url(*)") == null)
    and (.permissions.allow | index("command(*)") == null)
    and (.permissions.allow | index("mcp(*)") == null)
    and (.permissions.allow | index("mcp(playwright/browser_click)") == null)
    and (.permissions.ask | index("mcp(home-assistant/*)") == null)
    and (.permissions.ask | index("mcp(playwright/browser_click)") == null)
    and (.permissions.ask | index("write_file(*)") == null)
    and (.permissions.allow | index("mcp(ha_files/ha_files_read_text)") != null)
    and (.permissions.ask | index("mcp(ha_files/ha_files_write_text)") != null)
    and (.permissions.ask | index("read_url(*)") == null)
    and (.permissions.ask | index("execute_url(*)") != null)
    and (.permissions.ask | index("command(*)") != null)
    and (.permissions.allow | index("mcp(ha_change/ha_change_propose)") != null)
    and (.permissions.allow
      | index("mcp(ha_read/ha_read_storage_usage)") != null)
    and (.permissions.allow | index("mcp(telegram_action/telegram_action_propose)") != null)
    and (.permissions.deny | index("command(sudo)") == null)
    and (.permissions.deny | index("command(rm -rf)") == null)
    and (.permissions.deny | index("read_file(/config/secrets.yaml)") != null)
    and (.permissions.deny | index("write_file(/config/.storage)") != null)
    and (.permissions.deny | index("read_file(/run/antigravity-ha/supervisor.token)") != null)
    and (.permissions.deny | index("read_file(/data/home/.ssh)") != null)
    and (.permissions.allow | index("read_file(*)") == null)
    and (.permissions.allow | index("write_file(*)") == null)
    and (.permissions.deny | index("read_file(*)") != null)
    and (.permissions.deny | index("write_file(*)") != null)
    and (.permissions.allow | index("write_file(/data/home/.gemini/antigravity-cli/settings.json)") == null)
    and (.permissions.deny | index("write_file(/data/home/.gemini/antigravity-cli/settings.json)") != null)
    and (([
      "read_file(/data/home/.aws)",
      "write_file(/data/home/.aws)",
      "read_file(/data/home/.azure)",
      "write_file(/data/home/.azure)",
      "read_file(/data/home/.config/gcloud)",
      "write_file(/data/home/.config/gcloud)",
      "read_file(/data/home/.kube)",
      "write_file(/data/home/.kube)",
      "read_file(/data/home/.docker/config.json)",
      "write_file(/data/home/.docker/config.json)",
      "read_file(/data/home/.netrc)",
      "write_file(/data/home/.netrc)",
      "read_file(/data/home/.npmrc)",
      "write_file(/data/home/.npmrc)"
    ] - .permissions.deny) | length == 0)
    and (.permissions.allow | length == (unique | length))
    and (.permissions.deny | length == (unique | length))
  ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null
  jq --exit-status '
    (.managed.settings.permission_rules | index("command(*)") != null)
    and (.managed.settings.permission_rules | index("mcp(*)") == null)
    and (.managed.settings.permission_rules | index("mcp(home-assistant/*)") == null)
    and (.managed.settings.permission_rules
      | index("mcp(ha_read/ha_read_storage_usage)") != null)
    and (.managed.settings.permission_rules
      | index("mcp(telegram_action/telegram_action_propose)") != null)
  ' /data/antigravity-ha/migration/native-files-state.json >/dev/null
SCRIPT
PERMISSION_V208_IDEMPOTENT=$(run_helper "${PERMISSION_V208_MIGRATION_VOLUME}") \
  || fail 'public 2.0.8 preserve permission migration was not idempotent'
assert_json "${PERMISSION_V208_IDEMPOTENT}" '
  .permission_migration == "already_applied"
  and .created == []
  and .refreshed == []
  and .backup_directory == null
  and .warnings == ["antigravity_terminal_sandbox=true is deprecated and was normalized to false because the privileged native sandbox is unsupported; run_command uses the AppArmor command boundary"]
'

# A user may deliberately move an App-owned 2.0.8 rule to a stronger bucket.
# Preserve that explicit deny while retiring the remainder of the old layout.
run_script "${PERMISSION_V208_AMBIGUOUS_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity /data/antigravity-ha/migration \
    /data/home/.gemini/antigravity-cli /data/home/.gemini/config
  jq -n '{
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: true,
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  jq '
    .permissions.ask |= map(select(. != "command(*)"))
    | .permissions.deny += ["command(*)"]
    | .permissions.allow |= map(select(
        . != "write_file(/data/home/.gemini/antigravity-cli/settings.json)"
      ))
    | .permissions.ask += [
        "write_file(/data/home/.gemini/antigravity-cli/settings.json)"
      ]
  ' /test-fixtures/public-2.0.8-preserve-settings.json \
    > /data/home/.gemini/antigravity-cli/settings.json
  install -m 0600 /test-fixtures/public-2.0.8-preserve-state.json \
    /data/antigravity-ha/migration/native-files-state.json
  install -m 0600 /etc/antigravity/mcp_config.json \
    /data/home/.gemini/config/mcp_config.json
  chmod 0600 /data/home/.gemini/antigravity-cli/settings.json
SCRIPT
PERMISSION_V208_AMBIGUOUS_OUTPUT=$(run_helper \
  "${PERMISSION_V208_AMBIGUOUS_VOLUME}") \
  || fail 'public 2.0.8 explicit deny was not preserved during migration'
assert_json "${PERMISSION_V208_AMBIGUOUS_OUTPUT}" '
  .permission_migration == "applied"
  and .created == []
  and .refreshed == ["settings"]
  and (.backup_directory | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
'
run_script "${PERMISSION_V208_AMBIGUOUS_VOLUME}" <<'SCRIPT'
  jq --exit-status '
    (.permissions.deny | index("command(*)") != null)
    and (.permissions.ask | index("command(*)") == null)
    and (.permissions.allow | index("command(*)") == null)
    and (.permissions.deny
      | index("write_file(/data/home/.gemini/antigravity-cli/settings.json)")
        != null)
    and (.permissions.ask
      | index("write_file(/data/home/.gemini/antigravity-cli/settings.json)")
        == null)
    and (.permissions.allow
      | index("write_file(/data/home/.gemini/antigravity-cli/settings.json)")
        == null)
    and (.permissions.allow | index("mcp(*)") == null)
    and (.permissions.allow
      | index("mcp(telegram_action/telegram_action_propose)") != null)
  ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null
SCRIPT
PERMISSION_V208_OVERRIDE_HASH=$(path_hash \
  "${PERMISSION_V208_AMBIGUOUS_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
PERMISSION_V208_OVERRIDE_IDEMPOTENT=$(run_helper \
  "${PERMISSION_V208_AMBIGUOUS_VOLUME}") \
  || fail 'public 2.0.8 stronger deny was not restart-idempotent'
assert_json "${PERMISSION_V208_OVERRIDE_IDEMPOTENT}" '
  .permission_migration == "already_applied"
  and .created == []
  and .refreshed == []
  and .backup_directory == null
'
[[ $(path_hash "${PERMISSION_V208_AMBIGUOUS_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${PERMISSION_V208_OVERRIDE_HASH}" ]]

# Rehearse the exact public 2.1.0 settings and ownership bytes that triggered
# the native 1.1.13 first-launch rewrite. The current App must migrate both
# files transactionally, keep an exact backup, emit native-stable bytes, refresh
# stale ownership even when only state is old, and then become idempotent.
run_script "${PERMISSION_V210_MIGRATION_VOLUME}" \
  "${PUBLIC_2_1_0_SETTINGS_SHA256}" "${PUBLIC_2_1_0_STATE_SHA256}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity /data/antigravity-ha/migration \
    /data/home/.gemini/antigravity-cli /data/home/.gemini/config \
    /run/antigravity-ha
  jq -n '{
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: false,
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  install -m 0600 /test-fixtures/public-2.1.0-preserve-settings.json \
    /data/home/.gemini/antigravity-cli/settings.json
  install -m 0600 /test-fixtures/public-2.1.0-preserve-state.json \
    /data/antigravity-ha/migration/native-files-state.json
  install -m 0600 /etc/antigravity/mcp_config.json \
    /data/home/.gemini/config/mcp_config.json
  test "$(sha256sum /data/home/.gemini/antigravity-cli/settings.json \
    | cut -d ' ' -f 1)" = "$1"
  test "$(sha256sum /data/antigravity-ha/migration/native-files-state.json \
    | cut -d ' ' -f 1)" = "$2"
SCRIPT
PERMISSION_V210_OUTPUT=$(run_helper "${PERMISSION_V210_MIGRATION_VOLUME}") \
  || fail 'public 2.1.0 preserve migration failed'
assert_json "${PERMISSION_V210_OUTPUT}" '
  .permission_migration == "applied"
  and .created == []
  and .refreshed == ["settings"]
  and (.backup_directory
    | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
'
PERMISSION_V210_BACKUP=$(jq --raw-output '.backup_directory' \
  <<<"${PERMISSION_V210_OUTPUT}")
[[ $(path_hash "${PERMISSION_V210_MIGRATION_VOLUME}" \
  "${PERMISSION_V210_BACKUP}/settings.before") == \
  "${PUBLIC_2_1_0_SETTINGS_SHA256}" ]]
[[ $(path_hash "${PERMISSION_V210_MIGRATION_VOLUME}" \
  "${PERMISSION_V210_BACKUP}/state.before") == \
  "${PUBLIC_2_1_0_STATE_SHA256}" ]]
run_script "${PERMISSION_V210_MIGRATION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  settings=/data/home/.gemini/antigravity-cli/settings.json
  state=/data/antigravity-ha/migration/native-files-state.json
  jq --exit-status '
    keys_unsorted == (keys | sort)
    and (has("toolPermission") | not)
    and (has("enableTerminalSandbox") | not)
    and (.permissions | keys_unsorted) == ["allow", "deny", "ask"]
    and .altScreenMode == "never"
    and .showFeedbackSurvey == false
    and .showTips == false
  ' "${settings}" >/dev/null
  jq --exit-status '
    (.managed.settings.keys | index("toolPermission") == null)
    and (.managed.settings.keys | index("enableTerminalSandbox") == null)
    and (.managed.settings.keys | index("permissions") != null)
  ' "${state}" >/dev/null
  native_hash=$(sha256sum "${settings}" | cut -d " " -f 1)
  set +e
  printf '%s\n' public-2.1.0-native-stability-canary | env -i \
    AGY_CLI_DISABLE_AUTO_UPDATE=true \
    HOME=/data/home \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    TERM=dumb \
    timeout --kill-after=2 8 /usr/local/libexec/antigravity-real \
      --output-format stream-json --print-timeout 2s \
      >/tmp/public-v210-native.out 2>/tmp/public-v210-native.err
  native_status=$?
  set -e
  test "${native_status}" = 1
  test "$(sha256sum "${settings}" | cut -d " " -f 1)" = "${native_hash}"
  test -z "$(find /data/home/.gemini/antigravity-cli -maxdepth 1 \
    -name 'settings.json.*.tmp' -print -quit)"
SCRIPT
PERMISSION_V210_SETTINGS_AFTER=$(path_hash \
  "${PERMISSION_V210_MIGRATION_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
PERMISSION_V210_STATE_AFTER=$(path_hash \
  "${PERMISSION_V210_MIGRATION_VOLUME}" \
  /data/antigravity-ha/migration/native-files-state.json)
PERMISSION_V210_IDEMPOTENT=$(run_helper \
  "${PERMISSION_V210_MIGRATION_VOLUME}") \
  || fail 'public 2.1.0 preserve migration was not idempotent'
assert_json "${PERMISSION_V210_IDEMPOTENT}" '
  .permission_migration == "already_applied"
  and .refreshed == []
  and .backup_directory == null
'
[[ $(path_hash "${PERMISSION_V210_MIGRATION_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${PERMISSION_V210_SETTINGS_AFTER}" ]]
[[ $(path_hash "${PERMISSION_V210_MIGRATION_VOLUME}" \
  /data/antigravity-ha/migration/native-files-state.json) == \
  "${PERMISSION_V210_STATE_AFTER}" ]]

# An interrupted 2.1.0 repair can leave canonical bytes with the old ownership
# record. Refresh that state-only mismatch instead of repeating it forever.
run_script "${PERMISSION_V210_MIGRATION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  install -m 0600 /test-fixtures/public-2.1.0-preserve-state.json \
    /data/antigravity-ha/migration/native-files-state.json
SCRIPT
PERMISSION_V210_STATE_ONLY=$(run_helper \
  "${PERMISSION_V210_MIGRATION_VOLUME}") \
  || fail 'public 2.1.0 state-only ownership refresh failed'
assert_json "${PERMISSION_V210_STATE_ONLY}" '
  .permission_migration == "applied"
  and .refreshed == ["settings"]
  and (.backup_directory
    | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
'
[[ $(path_hash "${PERMISSION_V210_MIGRATION_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${PERMISSION_V210_SETTINGS_AFTER}" ]]
run_script "${PERMISSION_V210_MIGRATION_VOLUME}" <<'SCRIPT'
  jq --exit-status '
    (.managed.settings.keys | index("toolPermission") == null)
    and (.managed.settings.keys | index("enableTerminalSandbox") == null)
  ' /data/antigravity-ha/migration/native-files-state.json >/dev/null
SCRIPT

# Reconstruct the exact 2.0.9/2.0.10 broad App-owned layout from immutable
# 2.0.8 source lists plus the published v3 sensitive deny set. Preserve mode must
# replace its broad autonomous policy with request-review, and retain
# a user-added stronger command deny.
run_script "${PERMISSION_V3_MIGRATION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity /run/antigravity-ha
  jq -n '{
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: false,
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  /usr/local/bin/antigravity-user-files-update >/dev/null
  jq --slurpfile v208 /test-fixtures/public-2.0.8-preserve-settings.json '
    .toolPermission = "always-proceed"
    | .permissions.allow = (
        [$v208[0].permissions.allow[]
          | select(startswith("read_file(") or startswith("write_file("))
          | select(. != "write_file(/data/home/.gemini/antigravity-cli/settings.json)")]
        + ["read_url(*)", "execute_url(*)", "command(*)", "mcp(*)"]
        + [$v208[0].permissions.allow[]
          | select(startswith("mcp(playwright/"))]
        + [$v208[0].permissions.ask[]
          | select(startswith("mcp(playwright/"))]
      )
    | .permissions.ask = []
    | .permissions.deny = [
        "write_file(/data/home/.gemini/antigravity-cli/settings.json)",
        "read_file(/data/options.json)",
        "write_file(/data/options.json)",
        "read_file(/run/antigravity-ha/supervisor.token)",
        "write_file(/run/antigravity-ha/supervisor.token)",
        "read_file(/run/antigravity-ha/home-assistant-browser.token)",
        "write_file(/run/antigravity-ha/home-assistant-browser.token)",
        "read_file(/config/secrets.yaml)",
        "write_file(/config/secrets.yaml)",
        "read_file(/config/.storage)",
        "write_file(/config/.storage)",
        "read_file(/config/.ssh)",
        "write_file(/config/.ssh)",
        "read_file(/data/home/.ssh)",
        "write_file(/data/home/.ssh)",
        "read_file(/data/home/.aws)",
        "write_file(/data/home/.aws)",
        "read_file(/data/home/.azure)",
        "write_file(/data/home/.azure)",
        "read_file(/data/home/.config/gcloud)",
        "write_file(/data/home/.config/gcloud)",
        "read_file(/data/home/.kube)",
        "write_file(/data/home/.kube)",
        "read_file(/data/home/.docker/config.json)",
        "write_file(/data/home/.docker/config.json)",
        "read_file(/data/home/.netrc)",
        "write_file(/data/home/.netrc)",
        "read_file(/data/home/.npmrc)",
        "write_file(/data/home/.npmrc)",
        "read_file(/root/.ssh)",
        "write_file(/root/.ssh)"
      ]
    | .permissions.deny += ["command(*)", "user(v3/deny)"]
  ' /data/home/.gemini/antigravity-cli/settings.json > /tmp/settings.json
  mv /tmp/settings.json /data/home/.gemini/antigravity-cli/settings.json
  jq --slurpfile settings /data/home/.gemini/antigravity-cli/settings.json '
    .applied.settings = ["2.0.10"]
    | .managed.settings.permission_rules = (
        $settings[0].permissions.allow
        + ($settings[0].permissions.deny | map(select(. != "command(*)" and . != "user(v3/deny)")))
      )
  ' /data/antigravity-ha/migration/native-files-state.json > /tmp/state.json
  mv /tmp/state.json /data/antigravity-ha/migration/native-files-state.json
  chmod 0600 /data/home/.gemini/antigravity-cli/settings.json \
    /data/antigravity-ha/migration/native-files-state.json
SCRIPT
PERMISSION_V3_OUTPUT=$(run_helper "${PERMISSION_V3_MIGRATION_VOLUME}") \
  || fail '2.0.9/2.0.10 broad permission migration failed'
assert_json "${PERMISSION_V3_OUTPUT}" '
  .permission_migration == "applied"
  and .refreshed == ["settings"]
  and (.backup_directory | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
'
run_script "${PERMISSION_V3_MIGRATION_VOLUME}" <<'SCRIPT'
  jq --exit-status '
    (has("toolPermission") | not)
    and (.permissions.allow | index("command(*)") == null)
    and (.permissions.allow | index("mcp(*)") == null)
    and (.permissions.allow | index("read_file(*)") == null)
    and (.permissions.allow | index("read_url(*)") != null)
    and (.permissions.allow | index("execute_url(*)") == null)
    and (.permissions.allow | index("write_file(/config)") == null)
    and (.permissions.ask | index("command(*)") == null)
    and (.permissions.ask | index("write_file(*)") == null)
    and (.permissions.allow | index("mcp(ha_files/ha_files_read_text)") != null)
    and (.permissions.ask | index("mcp(ha_files/ha_files_write_text)") != null)
    and (.permissions.deny | index("read_file(*)") != null)
    and (.permissions.deny | index("write_file(*)") != null)
    and (.permissions.ask | index("execute_url(*)") != null)
    and (.permissions.deny | index("command(*)") != null)
    and (.permissions.deny | index("user(v3/deny)") != null)
    and (.permissions.allow | index("mcp(ha_change/ha_change_propose)") != null)
    and (.permissions.allow
      | index("mcp(telegram_action/telegram_action_propose)") != null)
  ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null
SCRIPT
PERMISSION_V3_OVERRIDE_HASH=$(path_hash \
  "${PERMISSION_V3_MIGRATION_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
PERMISSION_V3_IDEMPOTENT=$(run_helper "${PERMISSION_V3_MIGRATION_VOLUME}") \
  || fail '2.0.9/2.0.10 stronger deny was not restart-idempotent'
assert_json "${PERMISSION_V3_IDEMPOTENT}" '
  .permission_migration == "already_applied"
  and .created == []
  and .refreshed == []
  and .backup_directory == null
'
[[ $(path_hash "${PERMISSION_V3_MIGRATION_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${PERMISSION_V3_OVERRIDE_HASH}" ]]

# Reconstruct the exact 2.0.11-2.0.18 managed permission ownership, then prove
# that preserve mode retires it transactionally. The same fixture also proves
# that an explicit always-proceed option is effective and restart-idempotent.
run_script "${PERMISSION_V2018_MIGRATION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity /run/antigravity-ha
  jq -n '{
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: false,
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  /usr/local/bin/antigravity-user-files-update >/dev/null
  settings=/data/home/.gemini/antigravity-cli/settings.json
  state=/data/antigravity-ha/migration/native-files-state.json
  jq '
    .legacy_2018_marker = "preserved"
    | .allowNonWorkspaceAccess = false
    | .permissions.allow = (
        [.permissions.allow[]
          | select(. != "read_file(*)" and . != "read_url(*)")
          | select(. != "mcp(ha_files/ha_files_list)")
          | select(. != "mcp(ha_files/ha_files_read_text)")
          | select(. != "mcp(ha_read/ha_read_addon_logs)")
          | select(. != "mcp(ha_read/ha_read_host_logs)")
          | select(. != "mcp(ha_read/ha_read_supervisor_logs)")]
        + [
          "read_file(/config)",
          "read_file(/data/home/.gemini/config)",
          "read_file(/data/home/.gemini/antigravity-cli/agents)",
          "read_file(/data/home/.gemini/antigravity-cli/plugins)",
          "read_file(/data/home/.gemini/antigravity-cli/skills)",
          "read_file(/data/home/.gemini/GEMINI.md)",
          "read_file(/data/home/.gemini/antigravity-cli/settings.json)"
        ]
      )
    | .permissions.ask = []
    | .permissions.deny = [
        "write_file(/data/home/.gemini/antigravity-cli/settings.json)",
        "read_file(/data/options.json)",
        "write_file(/data/options.json)",
        "read_file(/run/antigravity-ha/supervisor.token)",
        "write_file(/run/antigravity-ha/supervisor.token)",
        "read_file(/run/antigravity-ha/home-assistant-browser.token)",
        "write_file(/run/antigravity-ha/home-assistant-browser.token)",
        "read_file(/config/secrets.yaml)",
        "write_file(/config/secrets.yaml)",
        "read_file(/config/.storage)",
        "write_file(/config/.storage)",
        "read_file(/config/.ssh)",
        "write_file(/config/.ssh)",
        "read_file(/data/home/.ssh)",
        "write_file(/data/home/.ssh)",
        "read_file(/data/home/.aws)",
        "write_file(/data/home/.aws)",
        "read_file(/data/home/.azure)",
        "write_file(/data/home/.azure)",
        "read_file(/data/home/.config/gcloud)",
        "write_file(/data/home/.config/gcloud)",
        "read_file(/data/home/.kube)",
        "write_file(/data/home/.kube)",
        "read_file(/data/home/.docker/config.json)",
        "write_file(/data/home/.docker/config.json)",
        "read_file(/data/home/.netrc)",
        "write_file(/data/home/.netrc)",
        "read_file(/data/home/.npmrc)",
        "write_file(/data/home/.npmrc)",
        "read_file(/root/.ssh)",
        "write_file(/root/.ssh)",
        "read_file(/data/home/.gemini/config/mcp_config.json)",
        "write_file(/data/home/.gemini/config/mcp_config.json)"
      ]
  ' "${settings}" > "${settings}.next"
  mv "${settings}.next" "${settings}"
  jq --slurpfile settings "${settings}" '
    .applied.settings = ["2.0.18"]
    | .managed.settings.permission_rules = (
        $settings[0].permissions.allow
        + $settings[0].permissions.ask
        + $settings[0].permissions.deny
      )
  ' "${state}" > "${state}.next"
  mv "${state}.next" "${state}"
  chmod 0600 "${settings}" "${state}" /data/options.json
SCRIPT
PERMISSION_V2018_OUTPUT=$(run_helper "${PERMISSION_V2018_MIGRATION_VOLUME}") \
  || fail '2.0.18 request-review permission migration failed'
assert_json "${PERMISSION_V2018_OUTPUT}" '
  .permission_migration == "applied"
  and .refreshed == ["settings"]
  and (.backup_directory
    | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
'
run_script "${PERMISSION_V2018_MIGRATION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  settings=/data/home/.gemini/antigravity-cli/settings.json
  jq --exit-status '
    .legacy_2018_marker == "preserved"
    and (has("toolPermission") | not)
    and .allowNonWorkspaceAccess == true
    and (.permissions.allow | index("read_file(*)") == null)
    and (.permissions.allow | index("read_url(*)") != null)
    and ((["mcp(ha_files/ha_files_write_text)", "execute_url(*)", "command(*)"]
      - .permissions.ask) | length == 0)
    and (.permissions.allow | index("mcp(ha_files/ha_files_read_text)") != null)
    and (.permissions.deny | index("read_file(*)") != null)
    and (.permissions.deny | index("write_file(*)") != null)
    and (.permissions.allow
      | index("mcp(ha_read/ha_read_addon_logs)") != null)
    and (.permissions.allow
      | index("mcp(ha_read/ha_read_host_logs)") != null)
    and (.permissions.allow
      | index("mcp(ha_read/ha_read_supervisor_logs)") != null)
    and (.permissions.deny
      | index("read_file(/data/home/.gemini/antigravity-cli/settings.json)") != null)
  ' "${settings}" >/dev/null
  jq '.antigravity_tool_permission = "always-proceed"' \
    /data/options.json > /data/options.next
  mv /data/options.next /data/options.json
  chmod 0600 /data/options.json
SCRIPT
PERMISSION_ALWAYS_OUTPUT=$(run_helper "${PERMISSION_V2018_MIGRATION_VOLUME}") \
  || fail 'explicit always-proceed mode was not applied'
assert_json "${PERMISSION_ALWAYS_OUTPUT}" '
  .permission_migration == "applied"
  and .refreshed == ["settings"]
'
run_script "${PERMISSION_V2018_MIGRATION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  settings=/data/home/.gemini/antigravity-cli/settings.json
  jq --exit-status '
    .legacy_2018_marker == "preserved"
    and .toolPermission == "always-proceed"
    and .allowNonWorkspaceAccess == true
    and (.permissions | has("ask") | not)
    and (.permissions | keys_unsorted) == ["allow", "deny"]
    and (([
      "read_url(*)",
      "execute_url(*)",
      "command(*)",
      "mcp(*)"
    ] - .permissions.allow) | length == 0)
    and (.permissions.allow | length == 4)
    and (.permissions.allow | index("read_file(*)") == null)
    and (.permissions.allow | index("write_file(*)") == null)
    and (.permissions.deny | index("read_file(*)") != null)
    and (.permissions.deny | index("write_file(*)") != null)
    and (.permissions.deny | index("read_file(/config/secrets.yaml)") != null)
    and (.permissions.deny | index("write_file(/config/.storage)") != null)
    and (.permissions.deny | index("read_file(/proc/self/environ)") != null)
  ' "${settings}" >/dev/null
  jq --exit-status '
    (.managed.settings.keys | index("toolPermission") != null)
    and (.managed.settings.keys | index("enableTerminalSandbox") == null)
  ' /data/antigravity-ha/migration/native-files-state.json >/dev/null
  always_native_hash=$(sha256sum "${settings}" | cut -d " " -f 1)
  set +e
  printf '%s\n' always-proceed-first-launch-canary | env -i \
    AGY_CLI_DISABLE_AUTO_UPDATE=true \
    HOME=/data/home \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    TERM=dumb \
    timeout --kill-after=2 8 /usr/local/libexec/antigravity-real \
      --output-format stream-json --print-timeout 2s \
      >/tmp/always-first-native.out 2>/tmp/always-first-native.err
  native_status=$?
  set -e
  test "${native_status}" = 1
  test "$(sha256sum "${settings}" | cut -d " " -f 1)" = \
    "${always_native_hash}"
  test -z "$(find /data/home/.gemini/antigravity-cli -maxdepth 1 \
    -name 'settings.json.*.tmp' -print -quit)"
  node --input-type=module <<'NODE'
import {
  TELEGRAM_ALWAYS_PROCEED_ALLOW_RULES,
  TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES,
} from "/usr/local/share/antigravity-ha/telegram-permission-policy.mjs";
import {
  loadTelegramPermissionBoundary,
} from "/usr/local/share/antigravity-ha/telegram-bridge.mjs";

const boundary = loadTelegramPermissionBoundary("always-proceed");
if (boundary.toolPermission !== "always-proceed" ||
    boundary.allowCount !== TELEGRAM_ALWAYS_PROCEED_ALLOW_RULES.size ||
    boundary.denyCount !== TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES.size) {
  throw new Error("always-proceed settings did not satisfy the bridge policy");
}
NODE
SCRIPT
PERMISSION_ALWAYS_IDEMPOTENT=$(run_helper \
  "${PERMISSION_V2018_MIGRATION_VOLUME}") \
  || fail 'always-proceed migration was not restart-idempotent'
assert_json "${PERMISSION_ALWAYS_IDEMPOTENT}" '
  .permission_migration == "already_applied"
  and .refreshed == []
  and .backup_directory == null
'
run_script "${PERMISSION_V2018_MIGRATION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  jq '.antigravity_tool_permission = "request-review"' \
    /data/options.json > /data/options.next
  mv /data/options.next /data/options.json
  chmod 0600 /data/options.json
SCRIPT
PERMISSION_REQUEST_RETURN=$(run_helper \
  "${PERMISSION_V2018_MIGRATION_VOLUME}") \
  || fail 'always-proceed to request-review preserve transition failed'
assert_json "${PERMISSION_REQUEST_RETURN}" '
  .permission_migration == "applied"
  and .refreshed == ["settings"]
'
run_script "${PERMISSION_V2018_MIGRATION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  settings=/data/home/.gemini/antigravity-cli/settings.json
  jq --exit-status '
    (has("toolPermission") | not)
    and (has("enableTerminalSandbox") | not)
    and (.permissions | keys_unsorted) == ["allow", "deny", "ask"]
  ' "${settings}" >/dev/null
  jq --exit-status '
    .managed.settings.keys | index("toolPermission") == null
  ' /data/antigravity-ha/migration/native-files-state.json >/dev/null
SCRIPT
PERMISSION_REQUEST_RETURN_IDEMPOTENT=$(run_helper \
  "${PERMISSION_V2018_MIGRATION_VOLUME}") \
  || fail 'request-review return migration was not restart-idempotent'
assert_json "${PERMISSION_REQUEST_RETURN_IDEMPOTENT}" '
  .permission_migration == "already_applied"
  and .refreshed == []
  and .backup_directory == null
'

# Reproduce the live Telegram startup incident without importing any device
# identifiers or credentials. With Telegram enabled, a private root-owned,
# parseable legacy settings file cannot be left in preserve mode when its
# effective policy would make the bridge fail before contacting the Bot API.
# Reconcile the exact managed policy transactionally while preserving
# non-managed top-level settings and the separate user-owned MCP file.
run_script "${TELEGRAM_RECONCILE_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity \
    /data/home/.gemini/antigravity-cli /data/home/.gemini/config
  jq -n '{
    telegram_enabled: true,
    telegram_allowed_user_ids: [],
    telegram_allowed_chat_ids: [],
    antigravity_tool_permission: "strict",
    antigravity_terminal_sandbox: true,
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  jq -n '{
    altScreenMode: "never",
    artifactReviewPolicy: "never",
    allowNonWorkspaceAccess: true,
    enableTerminalSandbox: true,
    showTips: true,
    showFeedbackSurvey: true,
    toolPermission: "strict",
    synthetic_incident_marker: "preserve-non-managed",
    synthetic_incident_ui: {theme: "local-only"},
    permissions: {
      allow: [
        "read_file(/config)",
        "command(*)",
        "user(synthetic/unsafe-allow)"
      ],
      ask: [
        "mcp(playwright/browser_snapshot)",
        "user(synthetic/unsafe-ask)"
      ],
      deny: ["read_file(/config/secrets.yaml)"]
    }
  }' > /data/home/.gemini/antigravity-cli/settings.json
  jq -n '{
    synthetic_mcp_marker: "preserve-byte-exact",
    mcpServers: {
      synthetic_incident: {
        command: "/bin/false",
        args: ["--synthetic-only"]
      }
    }
  }' > /data/home/.gemini/config/mcp_config.json
  chmod 0600 /data/options.json \
    /data/home/.gemini/antigravity-cli/settings.json \
    /data/home/.gemini/config/mcp_config.json
  test ! -e /data/antigravity-ha/migration/native-files-state.json
SCRIPT
TELEGRAM_RECONCILE_SETTINGS_BEFORE=$(path_hash \
  "${TELEGRAM_RECONCILE_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
TELEGRAM_RECONCILE_MCP_BEFORE=$(path_hash \
  "${TELEGRAM_RECONCILE_VOLUME}" \
  /data/home/.gemini/config/mcp_config.json)
TELEGRAM_RECONCILE_OUTPUT=$(run_helper "${TELEGRAM_RECONCILE_VOLUME}") \
  || fail 'Telegram-enabled unowned settings were not reconciled safely'
assert_json "${TELEGRAM_RECONCILE_OUTPUT}" '
  .mode == "preserve"
  and .requested_mode == "preserve"
  and .permission_migration == "telegram_reconciled"
  and .created == []
  and .refreshed == ["settings"]
  and (.backup_directory
    | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
  and (.warnings | any(contains("safe Telegram policy")))
  and (.warnings
    | all(contains("left settings.json unchanged") | not))
'
assert_sanitized "${TELEGRAM_RECONCILE_OUTPUT}"
TELEGRAM_RECONCILE_BACKUP=$(jq --raw-output '.backup_directory' \
  <<<"${TELEGRAM_RECONCILE_OUTPUT}")
[[ $(path_hash "${TELEGRAM_RECONCILE_VOLUME}" \
  "${TELEGRAM_RECONCILE_BACKUP}/settings.before") == \
  "${TELEGRAM_RECONCILE_SETTINGS_BEFORE}" ]]
[[ $(path_hash "${TELEGRAM_RECONCILE_VOLUME}" \
  /data/home/.gemini/config/mcp_config.json) == \
  "${TELEGRAM_RECONCILE_MCP_BEFORE}" ]]
run_script "${TELEGRAM_RECONCILE_VOLUME}" \
  "${TELEGRAM_RECONCILE_BACKUP}" <<'SCRIPT'
  set -Eeuo pipefail
  backup=$1
  settings=/data/home/.gemini/antigravity-cli/settings.json
  state=/data/antigravity-ha/migration/native-files-state.json
  test "$(stat -c "%a:%U:%G" "${settings}")" = 600:root:root
  test "$(stat -c "%a:%U:%G" "${state}")" = 600:root:root
  test "$(stat -c "%a:%U:%G" "${backup}")" = 700:root:root
  test ! -e /data/antigravity-ha/migration/native-files.json
  test ! -e "${backup}/mcp.before"
  test ! -e "${backup}/mcp.image-default"
  cmp --silent "${backup}/settings.image-default" "${settings}"
  cmp --silent "${backup}/state.candidate" "${state}"
  jq --exit-status '
    .synthetic_incident_marker == "preserve-non-managed"
    and .synthetic_incident_ui == {theme: "local-only"}
    and (has("showTips") | not)
    and (has("showFeedbackSurvey") | not)
    and .allowNonWorkspaceAccess == true
    and .artifactReviewPolicy == "agent-decides"
    and (has("toolPermission") | not)
    and (has("enableTerminalSandbox") | not)
    and ((["mcp(ha_files/ha_files_write_text)", "execute_url(*)", "command(*)"]
      - .permissions.ask) | length == 0)
    and (.permissions.allow | length) == ([.permissions.allow[]] | unique | length)
    and (.permissions.deny | length) == ([.permissions.deny[]] | unique | length)
    and (.permissions.allow | index("command(*)") == null)
    and (.permissions.allow | index("read_file(*)") == null)
    and (.permissions.allow | index("read_url(*)") != null)
    and (.permissions.allow | index("mcp(ha_files/ha_files_read_text)") != null)
    and (.permissions.deny | index("read_file(*)") != null)
    and (.permissions.deny | index("write_file(*)") != null)
    and (.permissions.allow | index("user(synthetic/unsafe-allow)") == null)
    and (.permissions.ask | index("user(synthetic/unsafe-ask)") == null)
    and (.permissions.allow
      | index("mcp(ha_change/ha_change_propose)") != null)
    and (.permissions.allow
      | index("mcp(telegram_action/telegram_action_propose)") != null)
    and (.permissions.deny
      | index("write_file(/data/home/.gemini/antigravity-cli/settings.json)") != null)
    and (.permissions.deny
      | index("read_file(/data/home/.gemini/config/mcp_config.json)") != null)
  ' "${settings}" >/dev/null
  jq --exit-status '
    .synthetic_mcp_marker == "preserve-byte-exact"
    and .mcpServers.synthetic_incident.command == "/bin/false"
    and .mcpServers.synthetic_incident.args == ["--synthetic-only"]
  ' /data/home/.gemini/config/mcp_config.json >/dev/null
  jq --exit-status '
    .scopes == ["settings"]
    and .state.existed == false
    and .state.before_sha256 == null
    and (.state.candidate_sha256 | test("^[0-9a-f]{64}$"))
    and .files.settings.existed == true
    and (.files.settings.before_sha256 | test("^[0-9a-f]{64}$"))
    and (.files.settings.candidate_sha256 | test("^[0-9a-f]{64}$"))
    and .files.settings.before_sha256 != .files.settings.candidate_sha256
    and (.files | keys) == ["settings"]
  ' "${backup}/metadata.json" >/dev/null
  jq --exit-status '
    .owner == "antigravity-for-home-assistant"
    and .kind == "native-files-refresh"
    and .scopes == ["settings"]
  ' "${backup}/manifest.json" >/dev/null
  jq --exit-status '
    .owner == "antigravity-for-home-assistant"
    and .kind == "native-files-refresh"
    and .outcome == "committed"
  ' "${backup}/completed.json" >/dev/null
  jq --exit-status '
    (.applied.settings | length) == 1
    and (.managed.settings.keys | sort) == ([
      "allowNonWorkspaceAccess",
      "artifactReviewPolicy",
      "permissions"
    ] | sort)
    and (.managed.settings.permission_rules | index("read_file(*)") != null)
    and (.managed.settings.permission_rules | index("command(*)") != null)
  ' "${state}" >/dev/null
  node --input-type=module <<'NODE'
import {
  loadTelegramPermissionBoundary,
} from "/usr/local/share/antigravity-ha/telegram-bridge.mjs";
import {
  TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES,
  TELEGRAM_SAFE_ALLOW_RULES,
} from "/usr/local/share/antigravity-ha/telegram-permission-policy.mjs";

const boundary = loadTelegramPermissionBoundary("request-review");
if (boundary.toolPermission !== "request-review" ||
    boundary.allowCount !== TELEGRAM_SAFE_ALLOW_RULES.size ||
    boundary.denyCount !== TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES.size) {
  throw new Error("reconciled settings did not satisfy the Telegram policy");
}
NODE
SCRIPT
TELEGRAM_RECONCILE_SETTINGS_AFTER=$(path_hash \
  "${TELEGRAM_RECONCILE_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
TELEGRAM_RECONCILE_STATE_AFTER=$(path_hash \
  "${TELEGRAM_RECONCILE_VOLUME}" \
  /data/antigravity-ha/migration/native-files-state.json)
TELEGRAM_RECONCILE_BACKUP_COUNT=$(run_script \
  "${TELEGRAM_RECONCILE_VOLUME}" <<'SCRIPT'
  find /data/antigravity-ha/backups/native-files -mindepth 1 -maxdepth 1 \
    -type d | wc -l
SCRIPT
)
TELEGRAM_RECONCILE_IDEMPOTENT=$(run_helper \
  "${TELEGRAM_RECONCILE_VOLUME}") \
  || fail 'Telegram permission reconciliation was not restart-idempotent'
assert_json "${TELEGRAM_RECONCILE_IDEMPOTENT}" '
  .mode == "preserve"
  and .permission_migration == "already_applied"
  and .created == []
  and .refreshed == []
  and .backup_directory == null
'
assert_sanitized "${TELEGRAM_RECONCILE_IDEMPOTENT}"
[[ $(path_hash "${TELEGRAM_RECONCILE_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${TELEGRAM_RECONCILE_SETTINGS_AFTER}" ]]
[[ $(path_hash "${TELEGRAM_RECONCILE_VOLUME}" \
  /data/antigravity-ha/migration/native-files-state.json) == \
  "${TELEGRAM_RECONCILE_STATE_AFTER}" ]]
[[ $(path_hash "${TELEGRAM_RECONCILE_VOLUME}" \
  /data/home/.gemini/config/mcp_config.json) == \
  "${TELEGRAM_RECONCILE_MCP_BEFORE}" ]]
[[ $(run_script "${TELEGRAM_RECONCILE_VOLUME}" <<'SCRIPT'
  find /data/antigravity-ha/backups/native-files -mindepth 1 -maxdepth 1 \
    -type d | wc -l
SCRIPT
) == "${TELEGRAM_RECONCILE_BACKUP_COUNT}" ]]

# Telegram-enabled settings use an exact deny bucket. An extra deny such as
# mcp(*) can block every managed read/proposal tool even though all mandatory
# secret denies remain present, so the startup reconciliation must remove it
# transactionally before the Bridge is allowed to contact Telegram.
run_script "${TELEGRAM_RECONCILE_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  settings=/data/home/.gemini/antigravity-cli/settings.json
  jq '.permissions.deny += ["mcp(*)"]' "${settings}" > "${settings}.next"
  mv "${settings}.next" "${settings}"
  chmod 0600 "${settings}"
SCRIPT
TELEGRAM_EXTRA_DENY_OUTPUT=$(run_helper \
  "${TELEGRAM_RECONCILE_VOLUME}") \
  || fail 'Telegram extra deny was not reconciled before Bridge startup'
assert_json "${TELEGRAM_EXTRA_DENY_OUTPUT}" '
  .permission_migration == "telegram_reconciled"
  and .refreshed == ["settings"]
  and (.backup_directory
    | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
  and (.warnings | any(contains("safe Telegram policy")))
'
run_script "${TELEGRAM_RECONCILE_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  settings=/data/home/.gemini/antigravity-cli/settings.json
  jq --exit-status '
    (.permissions.deny | index("mcp(*)") == null)
    and (.permissions.deny | index("read_file(*)") != null)
    and (.permissions.deny | index("write_file(*)") != null)
    and (.permissions.allow
      | index("mcp(ha_change/ha_change_propose)") != null)
    and (.permissions.allow
      | index("mcp(telegram_action/telegram_action_propose)") != null)
  ' "${settings}" >/dev/null
  node --input-type=module <<'NODE'
import {
  loadTelegramPermissionBoundary,
} from "/usr/local/share/antigravity-ha/telegram-bridge.mjs";
loadTelegramPermissionBoundary("request-review");
NODE
SCRIPT
TELEGRAM_EXTRA_DENY_HASH=$(path_hash \
  "${TELEGRAM_RECONCILE_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
TELEGRAM_EXTRA_DENY_IDEMPOTENT=$(run_helper \
  "${TELEGRAM_RECONCILE_VOLUME}") \
  || fail 'Telegram extra deny repair was not restart-idempotent'
assert_json "${TELEGRAM_EXTRA_DENY_IDEMPOTENT}" '
  .permission_migration == "already_applied"
  and .refreshed == []
  and .backup_directory == null
'
[[ $(path_hash "${TELEGRAM_RECONCILE_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${TELEGRAM_EXTRA_DENY_HASH}" ]]

# Disabling Telegram and returning through ordinary preserve must recognize the
# three-key ownership record. Retire unsupported sandbox/tool drift without claiming
# or changing preserved UI/customization keys.
run_script "${TELEGRAM_RECONCILE_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  options=/data/options.json
  settings=/data/home/.gemini/antigravity-cli/settings.json
  jq '.telegram_enabled = false' "${options}" > "${options}.next"
  mv "${options}.next" "${options}"
  chmod 0600 "${options}"
  jq '
    .enableTerminalSandbox = true
    | .toolPermission = "strict"
  ' "${settings}" > "${settings}.drift"
  mv "${settings}.drift" "${settings}"
  chmod 0600 "${settings}"
SCRIPT
TELEGRAM_OFF_DRIFT_OUTPUT=$(run_helper "${TELEGRAM_RECONCILE_VOLUME}") \
  || fail 'Telegram-disabled preserve did not repair boundary drift'
assert_json "${TELEGRAM_OFF_DRIFT_OUTPUT}" '
  .mode == "preserve"
  and .permission_migration == "applied"
  and .refreshed == ["settings"]
  and (.backup_directory
    | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
  and (.warnings | all(contains("ambiguous") | not))
  and (.warnings | all(contains("left settings.json unchanged") | not))
'
run_script "${TELEGRAM_RECONCILE_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  settings=/data/home/.gemini/antigravity-cli/settings.json
  state=/data/antigravity-ha/migration/native-files-state.json
  jq --exit-status '
    (has("enableTerminalSandbox") | not)
    and (has("toolPermission") | not)
    and (has("showTips") | not)
    and (has("showFeedbackSurvey") | not)
  ' "${settings}" >/dev/null
  jq --exit-status '
    (.managed.settings.keys | sort) == ([
      "allowNonWorkspaceAccess",
      "artifactReviewPolicy",
      "permissions"
    ] | sort)
  ' "${state}" >/dev/null
SCRIPT
TELEGRAM_OFF_PRESERVE_OUTPUT=$(run_helper "${TELEGRAM_RECONCILE_VOLUME}") \
  || fail 'Telegram-disabled preserve did not remain idempotent'
assert_json "${TELEGRAM_OFF_PRESERVE_OUTPUT}" '
  .mode == "preserve"
  and .permission_migration == "already_applied"
  and .refreshed == []
  and .backup_directory == null
  and (.warnings | all(contains("ambiguous") | not))
'

# Telegram-only reconciliation must not claim preserved UI/customization keys
# as App-owned. A later Telegram-disabled refresh may update the three recorded
# security keys but must leave those unrelated values and their ownership alone.
run_script "${TELEGRAM_RECONCILE_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  options=/data/options.json
  state=/data/antigravity-ha/migration/native-files-state.json
  jq '.antigravity_user_files_update_mode = "refresh_managed"' \
    "${options}" > "${options}.next"
  mv "${options}.next" "${options}"
  chmod 0600 "${options}"
  jq '.applied.settings = []' "${state}" > "${state}.next"
  mv "${state}.next" "${state}"
  chmod 0600 "${state}"
SCRIPT
TELEGRAM_OFF_REFRESH_OUTPUT=$(run_helper "${TELEGRAM_RECONCILE_VOLUME}") \
  || fail 'Telegram-disabled refresh after reconciliation failed'
assert_json "${TELEGRAM_OFF_REFRESH_OUTPUT}" '
  .mode == "refresh_managed"
  and .permission_migration == "not_applicable"
  and .refreshed == ["settings"]
'
run_script "${TELEGRAM_RECONCILE_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  settings=/data/home/.gemini/antigravity-cli/settings.json
  state=/data/antigravity-ha/migration/native-files-state.json
  jq --exit-status '
    .synthetic_incident_marker == "preserve-non-managed"
    and .synthetic_incident_ui == {theme: "local-only"}
    and .altScreenMode == "never"
    and (has("showTips") | not)
    and (has("showFeedbackSurvey") | not)
  ' "${settings}" >/dev/null
  jq --exit-status '
    (.managed.settings.keys | sort) == ([
      "allowNonWorkspaceAccess",
      "artifactReviewPolicy",
      "permissions"
    ] | sort)
    and (.managed.settings.permission_rules | index("read_file(*)") != null)
    and (.managed.settings.permission_rules | index("command(*)") != null)
  ' "${state}" >/dev/null
SCRIPT

# A current ownership record and canonical contents must not hide later drift.
# Reproduce the older no-permissions layout, non-private metadata, and the
# refresh_managed/unowned warning path in one bounded fixture. Telegram startup
# must repair all of them transactionally without claiming the file was kept.
run_script "${TELEGRAM_RECONCILE_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  settings=/data/home/.gemini/antigravity-cli/settings.json
  options=/data/options.json
  jq '
    del(.permissions)
    | .allowNonWorkspaceAccess = true
    | .artifactReviewPolicy = "never"
    | .enableTerminalSandbox = true
    | .toolPermission = "strict"
  ' "${settings}" > "${settings}.drift"
  mv "${settings}.drift" "${settings}"
  chmod 0644 "${settings}"
  jq '
    .telegram_enabled = true
    | .antigravity_user_files_update_mode = "refresh_managed"
  ' \
    "${options}" > "${options}.next"
  mv "${options}.next" "${options}"
  chmod 0600 "${options}"
  rm /data/antigravity-ha/migration/native-files-state.json
SCRIPT
TELEGRAM_REFRESH_OUTPUT=$(run_helper "${TELEGRAM_RECONCILE_VOLUME}") \
  || fail 'Telegram refresh_managed drift was not reconciled safely'
assert_json "${TELEGRAM_REFRESH_OUTPUT}" '
  .mode == "refresh_managed"
  and .permission_migration == "telegram_reconciled"
  and .refreshed == ["settings"]
  and (.warnings | any(contains("safe Telegram policy")))
  and (.warnings | all(contains("was preserved") | not))
  and (.warnings | all(contains("left settings.json unchanged") | not))
'
assert_sanitized "${TELEGRAM_REFRESH_OUTPUT}"
run_script "${TELEGRAM_RECONCILE_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  settings=/data/home/.gemini/antigravity-cli/settings.json
  test "$(stat -c "%a:%U:%G" "${settings}")" = 600:root:root
  jq --exit-status '
    .allowNonWorkspaceAccess == true
    and .artifactReviewPolicy == "agent-decides"
    and (has("enableTerminalSandbox") | not)
    and (has("toolPermission") | not)
    and (.permissions.allow | index("read_file(*)") == null)
    and (.permissions.allow | index("read_url(*)") != null)
    and ((["mcp(ha_files/ha_files_write_text)", "execute_url(*)", "command(*)"]
      - .permissions.ask) | length == 0)
    and (.permissions.allow | index("mcp(ha_files/ha_files_read_text)") != null)
    and (.permissions.deny | index("read_file(*)") != null)
    and (.permissions.deny | index("write_file(*)") != null)
    and (.permissions.deny | index("read_file(/config/secrets.yaml)") != null)
  ' "${settings}" >/dev/null
SCRIPT

# Reproduce the 2.0.15 -> 2.0.16 refresh ordering failure with synthetic data.
# The previous version owns settings.json, but permissions.ask is parseable JSON
# with the wrong type. Telegram must canonicalize that raw boundary before the
# generic managed merge validates its buckets, then commit one recoverable
# transaction without changing unrelated settings or the separate global MCP.
run_script "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity
  jq -n '{
    telegram_enabled: true,
    telegram_allowed_user_ids: [],
    telegram_allowed_chat_ids: [],
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: false,
    antigravity_user_files_update_mode: "refresh_managed"
  }' > /data/options.json
  chmod 0600 /data/options.json
SCRIPT
TELEGRAM_MALFORMED_BOOTSTRAP=$(run_script \
  "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  9.9.9-telegramold <<'SCRIPT'
  set -Eeuo pipefail
  version=$1
  install -d -m 0700 /run/antigravity-ha
  printf '%s\n' "${version}" \
    > /usr/local/share/antigravity-ha/app-version
  exec /usr/local/bin/antigravity-user-files-update
SCRIPT
) || fail 'Telegram malformed-refresh fixture bootstrap failed'
assert_json "${TELEGRAM_MALFORMED_BOOTSTRAP}" '
  .app_version == "9.9.9-telegramold"
  and (.created | sort) == ["mcp", "settings"]
  and .refreshed == []
  and .backup_directory == null
'
run_script "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  settings=/data/home/.gemini/antigravity-cli/settings.json
  mcp=/data/home/.gemini/config/mcp_config.json
  jq '
    .synthetic_refresh_marker = "preserve-unrelated-setting"
    | .synthetic_refresh_ui = {theme: "local-only"}
    | .permissions.ask = {synthetic_malformed_bucket: true}
  ' "${settings}" > "${settings}.next"
  mv "${settings}.next" "${settings}"
  jq -n '{
    synthetic_mcp_marker: "preserve-byte-exact",
    mcpServers: {
      synthetic_refresh: {
        command: "/bin/false",
        args: ["--synthetic-only"]
      }
    }
  }' > "${mcp}.next"
  mv "${mcp}.next" "${mcp}"
  chmod 0600 "${settings}" "${mcp}"
SCRIPT
TELEGRAM_MALFORMED_SETTINGS_BEFORE=$(path_hash \
  "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
TELEGRAM_MALFORMED_MCP_BEFORE=$(path_hash \
  "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  /data/home/.gemini/config/mcp_config.json)
TELEGRAM_MALFORMED_OUTPUT=$(run_script \
  "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  9.9.9-telegramnew <<'SCRIPT'
  set -Eeuo pipefail
  version=$1
  install -d -m 0700 /run/antigravity-ha
  printf '%s\n' "${version}" \
    > /usr/local/share/antigravity-ha/app-version
  exec /usr/local/bin/antigravity-user-files-update
SCRIPT
) || fail 'Telegram-enabled malformed permission bucket was not reconciled before managed refresh'
assert_json "${TELEGRAM_MALFORMED_OUTPUT}" '
  .app_version == "9.9.9-telegramnew"
  and .mode == "refresh_managed"
  and .permission_migration == "telegram_reconciled"
  and .created == []
  and .refreshed == ["settings"]
  and (.backup_directory
    | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
  and (.warnings | any(contains("safe Telegram policy")))
'
assert_sanitized "${TELEGRAM_MALFORMED_OUTPUT}"
TELEGRAM_MALFORMED_BACKUP=$(jq --raw-output '.backup_directory' \
  <<<"${TELEGRAM_MALFORMED_OUTPUT}")
[[ $(path_hash "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  "${TELEGRAM_MALFORMED_BACKUP}/settings.before") == \
  "${TELEGRAM_MALFORMED_SETTINGS_BEFORE}" ]]
[[ $(path_hash "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  /data/home/.gemini/config/mcp_config.json) == \
  "${TELEGRAM_MALFORMED_MCP_BEFORE}" ]]
run_script "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  "${TELEGRAM_MALFORMED_BACKUP}" <<'SCRIPT'
  set -Eeuo pipefail
  backup=$1
  settings=/data/home/.gemini/antigravity-cli/settings.json
  state=/data/antigravity-ha/migration/native-files-state.json
  test "$(stat -c '%a:%U:%G' "${settings}")" = 600:root:root
  test ! -e "${backup}/mcp.before"
  test ! -e "${backup}/mcp.image-default"
  cmp --silent "${backup}/settings.image-default" "${settings}"
  jq --exit-status '
    .synthetic_refresh_marker == "preserve-unrelated-setting"
    and .synthetic_refresh_ui == {theme: "local-only"}
    and .allowNonWorkspaceAccess == true
    and .artifactReviewPolicy == "agent-decides"
    and (has("toolPermission") | not)
    and (has("enableTerminalSandbox") | not)
    and (.permissions.allow | index("read_file(*)") == null)
    and (.permissions.allow | index("read_url(*)") != null)
    and ((["mcp(ha_files/ha_files_write_text)", "execute_url(*)", "command(*)"]
      - .permissions.ask) | length == 0)
    and (.permissions.allow | index("mcp(ha_files/ha_files_read_text)") != null)
    and (.permissions.deny | index("read_file(*)") != null)
    and (.permissions.deny | index("write_file(*)") != null)
    and (.permissions.deny | index("read_file(/config/secrets.yaml)") != null)
    and (.permissions.allow | length) == ([.permissions.allow[]] | unique | length)
    and (.permissions.deny | length) == ([.permissions.deny[]] | unique | length)
  ' "${settings}" >/dev/null
  jq --exit-status '
    .synthetic_mcp_marker == "preserve-byte-exact"
    and .mcpServers.synthetic_refresh.command == "/bin/false"
    and .mcpServers.synthetic_refresh.args == ["--synthetic-only"]
  ' /data/home/.gemini/config/mcp_config.json >/dev/null
  jq --exit-status '
    .scopes == ["settings"]
    and .state.existed == true
    and (.state.before_sha256 | test("^[0-9a-f]{64}$"))
    and (.state.candidate_sha256 | test("^[0-9a-f]{64}$"))
    and .state.before_sha256 != .state.candidate_sha256
    and .files.settings.existed == true
    and (.files.settings.before_sha256 | test("^[0-9a-f]{64}$"))
    and (.files.settings.candidate_sha256 | test("^[0-9a-f]{64}$"))
    and .files.settings.before_sha256 != .files.settings.candidate_sha256
    and (.files | keys) == ["settings"]
  ' "${backup}/metadata.json" >/dev/null
  jq --exit-status '
    (.applied.settings | index("9.9.9-telegramold")) != null
    and (.applied.settings | index("9.9.9-telegramnew")) != null
    and (.managed.settings.permission_rules | index("read_file(*)") != null)
    and (.managed.settings.permission_rules | index("command(*)") != null)
  ' "${state}" >/dev/null
  node --input-type=module <<'NODE'
import {
  loadTelegramPermissionBoundary,
} from "/usr/local/share/antigravity-ha/telegram-bridge.mjs";
import {
  TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES,
  TELEGRAM_SAFE_ALLOW_RULES,
} from "/usr/local/share/antigravity-ha/telegram-permission-policy.mjs";

const boundary = loadTelegramPermissionBoundary("request-review");
if (boundary.toolPermission !== "request-review" ||
    boundary.allowCount !== TELEGRAM_SAFE_ALLOW_RULES.size ||
    boundary.denyCount !== TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES.size) {
  throw new Error("malformed-refresh settings did not load in the bridge");
}
NODE
SCRIPT
TELEGRAM_MALFORMED_SETTINGS_AFTER=$(path_hash \
  "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
TELEGRAM_MALFORMED_STATE_AFTER=$(path_hash \
  "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  /data/antigravity-ha/migration/native-files-state.json)
TELEGRAM_MALFORMED_BACKUP_COUNT=$(run_script \
  "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" <<'SCRIPT'
  find /data/antigravity-ha/backups/native-files -mindepth 1 -maxdepth 1 \
    -type d | wc -l
SCRIPT
)
TELEGRAM_MALFORMED_IDEMPOTENT=$(run_script \
  "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  9.9.9-telegramnew <<'SCRIPT'
  set -Eeuo pipefail
  version=$1
  install -d -m 0700 /run/antigravity-ha
  printf '%s\n' "${version}" \
    > /usr/local/share/antigravity-ha/app-version
  exec /usr/local/bin/antigravity-user-files-update
SCRIPT
) || fail 'Telegram malformed-refresh repair was not restart-idempotent'
assert_json "${TELEGRAM_MALFORMED_IDEMPOTENT}" '
  .app_version == "9.9.9-telegramnew"
  and .mode == "refresh_managed"
  and .created == []
  and .refreshed == []
  and .backup_directory == null
'
[[ $(path_hash "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${TELEGRAM_MALFORMED_SETTINGS_AFTER}" ]]
[[ $(path_hash "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  /data/antigravity-ha/migration/native-files-state.json) == \
  "${TELEGRAM_MALFORMED_STATE_AFTER}" ]]
[[ $(path_hash "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  /data/home/.gemini/config/mcp_config.json) == \
  "${TELEGRAM_MALFORMED_MCP_BEFORE}" ]]
[[ $(run_script "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" <<'SCRIPT'
  find /data/antigravity-ha/backups/native-files -mindepth 1 -maxdepth 1 \
    -type d | wc -l
SCRIPT
) == "${TELEGRAM_MALFORMED_BACKUP_COUNT}" ]]

# Telegram-off refresh keeps the old fail-closed semantics: the same malformed
# owned bucket is rejected before a transaction or state mutation is possible.
run_script "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  options=/data/options.json
  settings=/data/home/.gemini/antigravity-cli/settings.json
  jq '.telegram_enabled = false' "${options}" > "${options}.next"
  mv "${options}.next" "${options}"
  jq '.permissions.ask = {synthetic_malformed_bucket: true}' \
    "${settings}" > "${settings}.next"
  mv "${settings}.next" "${settings}"
  chmod 0600 "${options}" "${settings}"
SCRIPT
TELEGRAM_OFF_MALFORMED_SETTINGS=$(path_hash \
  "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
if TELEGRAM_OFF_MALFORMED_OUTPUT=$(run_script \
  "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  9.9.9-telegramoff <<'SCRIPT' 2>&1
  set -Eeuo pipefail
  version=$1
  install -d -m 0700 /run/antigravity-ha
  printf '%s\n' "${version}" \
    > /usr/local/share/antigravity-ha/app-version
  exec /usr/local/bin/antigravity-user-files-update
SCRIPT
); then
  fail 'Telegram-disabled managed refresh accepted a malformed permission bucket'
fi
grep -Fq 'Existing settings.json permissions.ask must be a string array' \
  <<<"${TELEGRAM_OFF_MALFORMED_OUTPUT}" \
  || fail 'Telegram-disabled malformed bucket did not report the bounded reason'
assert_sanitized "${TELEGRAM_OFF_MALFORMED_OUTPUT}"
[[ $(path_hash "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${TELEGRAM_OFF_MALFORMED_SETTINGS}" ]]
[[ $(path_hash "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" \
  /data/antigravity-ha/migration/native-files-state.json) == \
  "${TELEGRAM_MALFORMED_STATE_AFTER}" ]]
[[ $(run_script "${TELEGRAM_MALFORMED_REFRESH_VOLUME}" <<'SCRIPT'
  find /data/antigravity-ha/backups/native-files -mindepth 1 -maxdepth 1 \
    -type d | wc -l
SCRIPT
) == "${TELEGRAM_MALFORMED_BACKUP_COUNT}" ]]

# Exercise the complete malformed-bucket contract independently of the primary
# incident fixture. Each owned old-version volume changes exactly one of
# allow/ask/deny to either a non-array or an array containing a non-string.
# Telegram-enabled refresh must repair all six cases without carrying unsafe
# bucket content into the bridge or touching unrelated settings/global MCP.
for TELEGRAM_MATRIX_CASE in "${TELEGRAM_MALFORMED_MATRIX_CASES[@]}"; do
  TELEGRAM_MATRIX_BUCKET=${TELEGRAM_MATRIX_CASE%%:*}
  TELEGRAM_MATRIX_SHAPE=${TELEGRAM_MATRIX_CASE#*:}
  TELEGRAM_MATRIX_VOLUME="${TEST_ID}-telegram-matrix-${TELEGRAM_MATRIX_CASE/:/-}"

  TELEGRAM_MATRIX_BOOTSTRAP=$(run_script \
    "${TELEGRAM_MATRIX_VOLUME}" \
    9.9.9-matrixold <<'SCRIPT'
    set -Eeuo pipefail
    version=$1
    umask 077
    install -d -m 0700 /data/antigravity /run/antigravity-ha
    jq -n '{
      telegram_enabled: true,
      telegram_allowed_user_ids: [],
      telegram_allowed_chat_ids: [],
      antigravity_tool_permission: "request-review",
      antigravity_terminal_sandbox: false,
      antigravity_user_files_update_mode: "refresh_managed"
    }' > /data/options.json
    chmod 0600 /data/options.json
    printf '%s\n' "${version}" \
      > /usr/local/share/antigravity-ha/app-version
    exec /usr/local/bin/antigravity-user-files-update
SCRIPT
  ) || fail "Telegram malformed matrix bootstrap failed: ${TELEGRAM_MATRIX_CASE}"
  assert_json "${TELEGRAM_MATRIX_BOOTSTRAP}" '
    .app_version == "9.9.9-matrixold"
    and (.created | sort) == ["mcp", "settings"]
    and .refreshed == []
    and .backup_directory == null
  '

  TELEGRAM_MATRIX_OUTPUT=$(run_script \
    "${TELEGRAM_MATRIX_VOLUME}" \
    9.9.9-matrixnew \
    "${TELEGRAM_MATRIX_BUCKET}" \
    "${TELEGRAM_MATRIX_SHAPE}" \
    "${TELEGRAM_MATRIX_CASE}" <<'SCRIPT'
    set -Eeuo pipefail
    version=$1
    bucket=$2
    shape=$3
    case_name=$4
    umask 077
    settings=/data/home/.gemini/antigravity-cli/settings.json
    mcp=/data/home/.gemini/config/mcp_config.json
    jq \
      --arg bucket "${bucket}" \
      --arg shape "${shape}" \
      --arg case_name "${case_name}" '
      .synthetic_matrix_marker = $case_name
      | .synthetic_matrix_ui = {
          theme: "local-only",
          nested: {preserve: true}
        }
      | .permissions[$bucket] = (
          if $shape == "non-array" then
            {synthetic_malformed_bucket: true}
          else
            ["synthetic-string", {synthetic_non_string_entry: true}]
          end
        )
    ' "${settings}" > "${settings}.next"
    mv "${settings}.next" "${settings}"
    jq -n --arg case_name "${case_name}" '{
      synthetic_mcp_marker: $case_name,
      mcpServers: {
        synthetic_matrix: {
          command: "/bin/false",
          args: ["--synthetic-only"]
        }
      }
    }' > "${mcp}.next"
    mv "${mcp}.next" "${mcp}"
    chmod 0600 "${settings}" "${mcp}"
    cp "${mcp}" /data/telegram-matrix-mcp.before
    chmod 0600 /data/telegram-matrix-mcp.before
    install -d -m 0700 /run/antigravity-ha
    printf '%s\n' "${version}" \
      > /usr/local/share/antigravity-ha/app-version
    exec /usr/local/bin/antigravity-user-files-update
SCRIPT
  ) || fail "Telegram malformed matrix repair failed: ${TELEGRAM_MATRIX_CASE}"
  assert_json "${TELEGRAM_MATRIX_OUTPUT}" '
    .app_version == "9.9.9-matrixnew"
    and .mode == "refresh_managed"
    and .permission_migration == "telegram_reconciled"
    and .created == []
    and .refreshed == ["settings"]
    and (.backup_directory
      | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
    and (.warnings | any(contains("safe Telegram policy")))
  '
  assert_sanitized "${TELEGRAM_MATRIX_OUTPUT}"
  TELEGRAM_MATRIX_BACKUP=$(jq --raw-output '.backup_directory' \
    <<<"${TELEGRAM_MATRIX_OUTPUT}")

  run_script "${TELEGRAM_MATRIX_VOLUME}" \
    "${TELEGRAM_MATRIX_BUCKET}" \
    "${TELEGRAM_MATRIX_SHAPE}" \
    "${TELEGRAM_MATRIX_CASE}" \
    "${TELEGRAM_MATRIX_BACKUP}" <<'SCRIPT'
    set -Eeuo pipefail
    bucket=$1
    shape=$2
    case_name=$3
    backup=$4
    settings=/data/home/.gemini/antigravity-cli/settings.json
    mcp=/data/home/.gemini/config/mcp_config.json
    state=/data/antigravity-ha/migration/native-files-state.json
    test "$(stat -c '%a:%U:%G' "${settings}")" = 600:root:root
    test ! -e "${backup}/mcp.before"
    test ! -e "${backup}/mcp.image-default"
    cmp --silent "${backup}/settings.image-default" "${settings}"
    cmp --silent /data/telegram-matrix-mcp.before "${mcp}"
    jq --exit-status \
      --arg bucket "${bucket}" \
      --arg shape "${shape}" '
      if $shape == "non-array" then
        (.permissions[$bucket] | type) != "array"
      else
        ((.permissions[$bucket] | type) == "array"
          and (.permissions[$bucket] | any(.[]; type != "string")))
      end
    ' "${backup}/settings.before" >/dev/null
    jq --exit-status --arg case_name "${case_name}" '
      .synthetic_matrix_marker == $case_name
      and .synthetic_matrix_ui == {
        theme: "local-only",
        nested: {preserve: true}
      }
      and .allowNonWorkspaceAccess == true
      and .artifactReviewPolicy == "agent-decides"
      and (has("toolPermission") | not)
      and (has("enableTerminalSandbox") | not)
      and (.permissions.allow | index("read_file(*)") == null)
      and (.permissions.allow | index("read_url(*)") != null)
      and ((["mcp(ha_files/ha_files_write_text)", "execute_url(*)", "command(*)"]
        - .permissions.ask) | length == 0)
      and (.permissions.allow | index("mcp(ha_files/ha_files_read_text)") != null)
      and (.permissions.deny | index("read_file(*)") != null)
      and (.permissions.deny | index("write_file(*)") != null)
      and (.permissions.deny | index("read_file(/config/secrets.yaml)") != null)
      and (.permissions.allow | length)
        == ([.permissions.allow[]] | unique | length)
      and (.permissions.deny | length)
        == ([.permissions.deny[]] | unique | length)
    ' "${settings}" >/dev/null
    jq --exit-status --arg case_name "${case_name}" '
      .synthetic_mcp_marker == $case_name
      and .mcpServers.synthetic_matrix.command == "/bin/false"
      and .mcpServers.synthetic_matrix.args == ["--synthetic-only"]
    ' "${mcp}" >/dev/null
    jq --exit-status '
      (.applied.settings | index("9.9.9-matrixold")) != null
      and (.applied.settings | index("9.9.9-matrixnew")) != null
      and (.managed.settings.permission_rules | index("read_file(*)") != null)
      and (.managed.settings.permission_rules | index("command(*)") != null)
    ' "${state}" >/dev/null
    node --input-type=module <<'NODE'
import {
  loadTelegramPermissionBoundary,
} from "/usr/local/share/antigravity-ha/telegram-bridge.mjs";
import {
  TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES,
  TELEGRAM_SAFE_ALLOW_RULES,
} from "/usr/local/share/antigravity-ha/telegram-permission-policy.mjs";

const boundary = loadTelegramPermissionBoundary("request-review");
if (boundary.toolPermission !== "request-review" ||
    boundary.allowCount !== TELEGRAM_SAFE_ALLOW_RULES.size ||
    boundary.denyCount !== TELEGRAM_REQUIRED_SENSITIVE_DENY_RULES.size) {
  throw new Error("malformed matrix settings did not load in the bridge");
}
NODE
SCRIPT

  TELEGRAM_MATRIX_SETTINGS_AFTER=$(path_hash \
    "${TELEGRAM_MATRIX_VOLUME}" \
    /data/home/.gemini/antigravity-cli/settings.json)
  TELEGRAM_MATRIX_STATE_AFTER=$(path_hash \
    "${TELEGRAM_MATRIX_VOLUME}" \
    /data/antigravity-ha/migration/native-files-state.json)
  TELEGRAM_MATRIX_MCP_AFTER=$(path_hash \
    "${TELEGRAM_MATRIX_VOLUME}" \
    /data/home/.gemini/config/mcp_config.json)
  TELEGRAM_MATRIX_BACKUP_COUNT=$(run_script \
    "${TELEGRAM_MATRIX_VOLUME}" <<'SCRIPT'
    find /data/antigravity-ha/backups/native-files -mindepth 1 -maxdepth 1 \
      -type d | wc -l
SCRIPT
  )
  TELEGRAM_MATRIX_IDEMPOTENT=$(run_script \
    "${TELEGRAM_MATRIX_VOLUME}" \
    9.9.9-matrixnew <<'SCRIPT'
    set -Eeuo pipefail
    version=$1
    install -d -m 0700 /run/antigravity-ha
    printf '%s\n' "${version}" \
      > /usr/local/share/antigravity-ha/app-version
    exec /usr/local/bin/antigravity-user-files-update
SCRIPT
  ) || fail "Telegram malformed matrix repair was not idempotent: ${TELEGRAM_MATRIX_CASE}"
  assert_json "${TELEGRAM_MATRIX_IDEMPOTENT}" '
    .app_version == "9.9.9-matrixnew"
    and .mode == "refresh_managed"
    and .created == []
    and .refreshed == []
    and .backup_directory == null
  '
  assert_sanitized "${TELEGRAM_MATRIX_IDEMPOTENT}"
  [[ $(path_hash "${TELEGRAM_MATRIX_VOLUME}" \
    /data/home/.gemini/antigravity-cli/settings.json) == \
    "${TELEGRAM_MATRIX_SETTINGS_AFTER}" ]]
  [[ $(path_hash "${TELEGRAM_MATRIX_VOLUME}" \
    /data/antigravity-ha/migration/native-files-state.json) == \
    "${TELEGRAM_MATRIX_STATE_AFTER}" ]]
  [[ $(path_hash "${TELEGRAM_MATRIX_VOLUME}" \
    /data/home/.gemini/config/mcp_config.json) == \
    "${TELEGRAM_MATRIX_MCP_AFTER}" ]]
  [[ $(run_script "${TELEGRAM_MATRIX_VOLUME}" <<'SCRIPT'
    find /data/antigravity-ha/backups/native-files -mindepth 1 -maxdepth 1 \
      -type d | wc -l
SCRIPT
  ) == "${TELEGRAM_MATRIX_BACKUP_COUNT}" ]]
done

# A compact, bounded legacy file can expand beyond the bridge limit when an
# unsafe boundary is serialized canonically. Reject it before any transaction
# instead of reporting success and leaving the bridge in a fail-closed hold.
run_script "${TELEGRAM_OVERSIZE_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity \
    /data/home/.gemini/antigravity-cli /data/home/.gemini/config
  jq -n '{
    telegram_enabled: true,
    telegram_allowed_user_ids: [],
    telegram_allowed_chat_ids: [],
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  node --input-type=module <<'NODE'
import { writeFileSync } from "node:fs";

const value = {
  toolPermission: "strict",
  syntheticLargeSetting: Array(50_000).fill("x"),
};
writeFileSync(
  "/data/home/.gemini/antigravity-cli/settings.json",
  JSON.stringify(value),
  { mode: 0o600 },
);
NODE
  printf '{"mcpServers":{}}\n' > /data/home/.gemini/config/mcp_config.json
  chmod 0600 /data/options.json \
    /data/home/.gemini/antigravity-cli/settings.json \
    /data/home/.gemini/config/mcp_config.json
  size=$(stat -c %s /data/home/.gemini/antigravity-cli/settings.json)
  test "${size}" -gt 0
  test "${size}" -le $((256 * 1024))
SCRIPT
TELEGRAM_OVERSIZE_BEFORE=$(path_hash \
  "${TELEGRAM_OVERSIZE_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
set +e
TELEGRAM_OVERSIZE_OUTPUT=$(run_helper "${TELEGRAM_OVERSIZE_VOLUME}" 2>&1)
TELEGRAM_OVERSIZE_STATUS=$?
set -e
[[ ${TELEGRAM_OVERSIZE_STATUS} -eq 20 ]] \
  || fail 'oversized Telegram candidate was not rejected fail-closed'
grep -Fq 'exceeds the Telegram boundary size limit' \
  <<<"${TELEGRAM_OVERSIZE_OUTPUT}" \
  || fail 'oversized Telegram candidate did not report the bounded reason'
[[ $(path_hash "${TELEGRAM_OVERSIZE_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${TELEGRAM_OVERSIZE_BEFORE}" ]]
run_script "${TELEGRAM_OVERSIZE_VOLUME}" <<'SCRIPT'
  test ! -e /data/antigravity-ha/migration/native-files.json
  test ! -e /data/antigravity-ha/migration/native-files-state.json
SCRIPT

# Matching contents without an ownership record are user-owned. Preserve mode
# must report the fail-safe decision and leave every byte untouched.
run_script "${PERMISSION_UNOWNED_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity \
    /data/home/.gemini/antigravity-cli /data/home/.gemini/config
  jq -n '{
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: true,
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  install -m 0600 /test-fixtures/public-2.0.6-preserve-settings.json \
    /data/home/.gemini/antigravity-cli/settings.json
  install -m 0600 /etc/antigravity/mcp_config.json \
    /data/home/.gemini/config/mcp_config.json
SCRIPT
PERMISSION_UNOWNED_HASH=$(path_hash "${PERMISSION_UNOWNED_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
PERMISSION_UNOWNED_OUTPUT=$(run_helper "${PERMISSION_UNOWNED_VOLUME}") \
  || fail 'unowned preserve permission settings did not fail safe'
assert_json "${PERMISSION_UNOWNED_OUTPUT}" '
  .permission_migration == "skipped_unowned"
  and .created == []
  and .refreshed == []
  and .backup_directory == null
  and (.warnings | any(contains("ownership could not be proven")))
'
[[ $(path_hash "${PERMISSION_UNOWNED_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${PERMISSION_UNOWNED_HASH}" ]]
run_script "${PERMISSION_UNOWNED_VOLUME}" <<'SCRIPT'
  test ! -e /data/antigravity-ha/migration/native-files-state.json
  test ! -e /data/antigravity-ha/migration/native-files.json
SCRIPT

# Even with the released ownership record, a managed rule moved to a different
# bucket is ambiguous. It must not be normalized or partially repaired.
run_script "${PERMISSION_AMBIGUOUS_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity /data/antigravity-ha/migration \
    /data/home/.gemini/antigravity-cli /data/home/.gemini/config
  jq -n '{
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: true,
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  jq '
    .permissions.deny |= map(select(. != "read_file(/data)"))
    | .permissions.allow += ["read_file(/data)"]
  ' /test-fixtures/public-2.0.6-preserve-settings.json \
    > /data/home/.gemini/antigravity-cli/settings.json
  install -m 0600 /test-fixtures/public-2.0.6-preserve-state.json \
    /data/antigravity-ha/migration/native-files-state.json
  install -m 0600 /etc/antigravity/mcp_config.json \
    /data/home/.gemini/config/mcp_config.json
  chmod 0600 /data/home/.gemini/antigravity-cli/settings.json
SCRIPT
PERMISSION_AMBIGUOUS_HASH=$(path_hash "${PERMISSION_AMBIGUOUS_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
PERMISSION_AMBIGUOUS_STATE_HASH=$(path_hash \
  "${PERMISSION_AMBIGUOUS_VOLUME}" \
  /data/antigravity-ha/migration/native-files-state.json)
PERMISSION_AMBIGUOUS_OUTPUT=$(run_helper "${PERMISSION_AMBIGUOUS_VOLUME}") \
  || fail 'ambiguous preserve permission settings did not fail safe'
assert_json "${PERMISSION_AMBIGUOUS_OUTPUT}" '
  .permission_migration == "skipped_ambiguous"
  and .created == []
  and .refreshed == []
  and .backup_directory == null
  and (.warnings | any(contains("2.0.6 permission layout was ambiguous")))
'
[[ $(path_hash "${PERMISSION_AMBIGUOUS_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${PERMISSION_AMBIGUOUS_HASH}" ]]
[[ $(path_hash "${PERMISSION_AMBIGUOUS_VOLUME}" \
  /data/antigravity-ha/migration/native-files-state.json) == \
  "${PERMISSION_AMBIGUOUS_STATE_HASH}" ]]
run_script "${PERMISSION_AMBIGUOUS_VOLUME}" <<'SCRIPT'
  test ! -e /data/antigravity-ha/migration/native-files.json
SCRIPT

run_script "${MAIN_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  export HOME=/data/home
  if ! /usr/local/libexec/antigravity-real plugin install \
    /usr/local/share/antigravity-ha/plugins/home-assistant \
    </dev/null >/dev/null; then
    echo 'native user-files smoke: plugin install failed' >&2
    exit 1
  fi
  install -d -m 0700 /data/home/.gemini/config/plugins/user-owned
  printf '{"name":"user-owned"}\n' \
    > /data/home/.gemini/config/plugins/user-owned/plugin.json
  printf '%s\n' 'preserve-user-plugin' \
    > /data/home/.gemini/config/plugins/user-owned/user-marker
  if ! /usr/local/libexec/antigravity-real plugin install \
    /usr/local/share/antigravity-ha/plugins/home-assistant \
    </dev/null >/dev/null; then
    echo 'native user-files smoke: managed plugin refresh failed' >&2
    exit 1
  fi
  grep -Fxq preserve-user-plugin \
    /data/home/.gemini/config/plugins/user-owned/user-marker
  /usr/local/libexec/antigravity-real plugin validate \
    /data/home/.gemini/config/plugins/home-assistant >/dev/null
  test -f /data/home/.gemini/config/plugins/home-assistant/plugin.json
  test ! -e /data/home/.gemini/config/plugins/home-assistant/agents/ha-telegram/agent.md
  jq --exit-status '
    .mcpServers.ha_change.command == "/usr/local/bin/ha-change-proposal-mcp"
    and .mcpServers.ha_change.args == []
    and .mcpServers.ha_memory.command == "/usr/local/bin/ha-memory-mcp"
    and .mcpServers.ha_memory.args == []
    and .mcpServers.ha_read.command == "/usr/local/bin/ha-read-mcp"
    and .mcpServers.ha_files.command == "/usr/local/bin/ha-files-mcp"
    and .mcpServers.ha_files.args == []
    and .mcpServers.ha_files.cwd == "/config"
    and .mcpServers.playwright.command == "/usr/local/bin/ha-playwright-mcp"
    and .mcpServers.playwright.args == []
    and .mcpServers.playwright.cwd == "/config"
  ' /data/home/.gemini/config/plugins/home-assistant/mcp_config.json >/dev/null
SCRIPT

run_script "${LEGACY_VOLUME}" \
  "${LEGACY_PROVIDER_SECRET}" \
  "${LEGACY_BROWSER_SECRET}" \
  "${LEGACY_PAIR_SECRET}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity
  jq -n --arg provider_token "$1" --arg browser_token "$2" '
    {
      antigravity_approval_policy: "never",
      antigravity_sandbox_mode: "danger-full-access",
      browser_approval_policy: "never",
      antigravity_user_files_update_mode: "refresh_all",
      antigravity_token: $provider_token,
      home_assistant_browser_token: $browser_token,
      telegram_allowed_chat_ids: ["123456789"]
    }
  ' > /data/options.json
  printf '["123456789"]\n' \
    > /data/antigravity/telegram_authorized_chats.json
  printf '{"pair_token":"%s","pin_code":"123456"}\n' \
    "$3" \
    > /data/antigravity/telegram_pair_info.json
SCRIPT
LEGACY_OPTIONS_HASH=$(path_hash "${LEGACY_VOLUME}" /data/options.json)
LEGACY_AUTHORIZED_HASH=$(path_hash \
  "${LEGACY_VOLUME}" /data/antigravity/telegram_authorized_chats.json)
LEGACY_PAIR_HASH=$(path_hash \
  "${LEGACY_VOLUME}" /data/antigravity/telegram_pair_info.json)
LEGACY_OUTPUT=$(run_helper "${LEGACY_VOLUME}") \
  || fail 'conservative legacy option migration failed'
assert_json "${LEGACY_OUTPUT}" '
  .mode == "refresh_managed"
  and .requested_mode == "refresh_all"
  and (.warnings | length) >= 7
  and (.warnings | any(contains("antigravity_token")))
  and (.warnings | any(contains("home_assistant_browser_token")))
  and (.warnings | any(contains("v2 user allowlist")))
  and (.warnings | any(contains("Quarantined legacy Telegram")))
'
assert_sanitized "${LEGACY_OUTPUT}"
[[ $(path_hash "${LEGACY_VOLUME}" /data/options.json) == \
  "${LEGACY_OPTIONS_HASH}" ]]
[[ $(path_hash "${LEGACY_VOLUME}" \
  /data/antigravity-ha/quarantine/v1-telegram/telegram_authorized_chats.json) == \
  "${LEGACY_AUTHORIZED_HASH}" ]]
[[ $(path_hash "${LEGACY_VOLUME}" \
  /data/antigravity-ha/quarantine/v1-telegram/telegram_pair_info.json) == \
  "${LEGACY_PAIR_HASH}" ]]
run_script "${LEGACY_VOLUME}" <<'SCRIPT'
  test ! -e /data/antigravity/telegram_authorized_chats.json
  test ! -e /data/antigravity/telegram_pair_info.json
  test "$(stat -c "%a:%U:%G" \
    /data/antigravity-ha/quarantine/v1-telegram/telegram_authorized_chats.json)" \
    = 600:root:root
  test "$(stat -c "%a:%U:%G" \
    /data/antigravity-ha/quarantine/v1-telegram/telegram_pair_info.json)" \
    = 600:root:root
  jq --exit-status '
    (has("toolPermission") | not)
    and (has("enableTerminalSandbox") | not)
    and (.permissions.allow | index("mcp(playwright/browser_snapshot)") != null)
    and (.permissions.allow | index("mcp(playwright/browser_click)") == null)
    and (.permissions.ask | index("mcp(playwright/browser_click)") == null)
  ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null
SCRIPT

run_script "${CONFLICT_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity \
    /data/home/.gemini/antigravity-cli /data/home/.gemini/config
  jq -n '{
    antigravity_user_files_update_mode: "reset_v2",
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: true
  }' > /data/options.json
  printf '{"toolPermission":"strict","user_owned_key":"preserve"}\n' \
    > /data/home/.gemini/antigravity-cli/settings.json
  printf '{"mcpServers":{"user_owned":{"command":"user-mcp"}}}\n' \
    > /data/home/.gemini/config/mcp_config.json
SCRIPT
CONFLICT_MCP_HASH=$(path_hash "${CONFLICT_VOLUME}" /data/home/.gemini/config/mcp_config.json)
CONFLICT_OUTPUT=$(run_helper "${CONFLICT_VOLUME}") \
  || fail 'reset_v2 did not recover settings without App ownership state'
assert_json "${CONFLICT_OUTPUT}" '
  .mode == "reset_v2"
  and .refreshed == ["settings"]
  and (.backup_directory | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
'
assert_sanitized "${CONFLICT_OUTPUT}"
[[ $(path_hash "${CONFLICT_VOLUME}" /data/home/.gemini/config/mcp_config.json) == "${CONFLICT_MCP_HASH}" ]]
run_script "${CONFLICT_VOLUME}" <<'SCRIPT'
  jq --exit-status '
    .user_owned_key == "preserve"
    and (has("toolPermission") | not)
    and ((["mcp(ha_files/ha_files_write_text)", "execute_url(*)", "command(*)"]
      - .permissions.ask) | length == 0)
    and (.permissions.allow
      | index("mcp(telegram_action/telegram_action_propose)") != null)
  ' \
    /data/home/.gemini/antigravity-cli/settings.json >/dev/null
  jq --exit-status '.mcpServers.user_owned.command == "user-mcp"' \
    /data/home/.gemini/config/mcp_config.json >/dev/null
  test -e /data/antigravity-ha/migration/native-files-state.json
SCRIPT

run_script "${PARTIAL_CONFLICT_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity \
    /data/home/.gemini/antigravity-cli /data/home/.gemini/config
  jq -n '{
    antigravity_user_files_update_mode: "reset_v2",
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: true
  }' > /data/options.json
  printf '{"toolPermission":"strict","user_owned_key":"preserve"}\n' \
    > /data/home/.gemini/antigravity-cli/settings.json
SCRIPT
PARTIAL_CONFLICT_OUTPUT=$(run_helper "${PARTIAL_CONFLICT_VOLUME}") \
  || fail 'reset_v2 did not recover unowned settings with a missing MCP peer'
assert_json "${PARTIAL_CONFLICT_OUTPUT}" '
  .mode == "reset_v2"
  and .created == ["mcp"]
  and .refreshed == ["settings"]
  and (.backup_directory | startswith("/data/antigravity-ha/backups/native-files/refresh-"))
'
assert_sanitized "${PARTIAL_CONFLICT_OUTPUT}"
run_script "${PARTIAL_CONFLICT_VOLUME}" <<'SCRIPT'
  jq --exit-status '
    .user_owned_key == "preserve"
    and (has("toolPermission") | not)
    and ((["mcp(ha_files/ha_files_write_text)", "execute_url(*)", "command(*)"]
      - .permissions.ask) | length == 0)
  ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null
  jq --exit-status '.mcpServers == {}' \
    /data/home/.gemini/config/mcp_config.json >/dev/null
  test -e /data/antigravity-ha/migration/native-files-state.json
SCRIPT

# Reproduce the ambiguous hash case that a phase-less journal cannot safely
# distinguish: preserve mode already has a state file, only MCP is missing,
# and the candidate state is byte-for-byte equal to the pre-transaction state.
run_script "${CRASH_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity
  jq -n '{
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: true,
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  install -d -m 0700 /run/antigravity-ha
  /usr/local/bin/antigravity-user-files-update >/dev/null
  state_hash=$(sha256sum \
    /data/antigravity-ha/migration/native-files-state.json | cut -d " " -f 1)
  rm /data/home/.gemini/config/mcp_config.json
  awk '
    { print }
    !injected && /await writePrivateJson\(activeJournalPath, journal\);/ {
      print "    process.kill(process.pid, \"SIGKILL\");"
      injected = 1
    }
  ' /usr/local/share/antigravity-ha/user-files-update.mjs \
    > /tmp/user-files-prepared-crash.mjs
  cp /usr/local/share/antigravity-ha/telegram-permission-policy.mjs /tmp/
  set +e
  node /tmp/user-files-prepared-crash.mjs >/tmp/crash-output 2>&1
  status=$?
  set -e
  test "${status}" -eq 137
  test "$(sha256sum /data/antigravity-ha/migration/native-files-state.json \
    | cut -d " " -f 1)" = "${state_hash}"
  test ! -e /data/home/.gemini/config/mcp_config.json
  jq --exit-status '.phase == "prepared"' \
    /data/antigravity-ha/migration/native-files.json >/dev/null
  transaction=$(jq --raw-output '.transaction' \
    /data/antigravity-ha/migration/native-files.json)
  jq --exit-status '
    .state.existed == true
    and .state.before_sha256 == .state.candidate_sha256
    and .files.mcp.existed == false
  ' "/data/antigravity-ha/backups/native-files/${transaction}/metadata.json" \
    >/dev/null

  # Recreate the exact control layout left by a pre-v2.0 migration helper.
  install -d -m 0700 /data/antigravity/backups/native-files
  mv /data/antigravity-ha/migration/native-files-state.json \
    /data/antigravity/.native-files-update-state.json
  mv /data/antigravity-ha/migration/native-files.json \
    /data/antigravity/.native-files-update-journal.json
  mv "/data/antigravity-ha/backups/native-files/${transaction}" \
    /data/antigravity/backups/native-files/
SCRIPT
CRASH_STATE_HASH=$(path_hash \
  "${CRASH_VOLUME}" /data/antigravity/.native-files-update-state.json)
CRASH_RECOVERY_OUTPUT=$(run_helper "${CRASH_VOLUME}") \
  || fail 'prepared missing-MCP transaction did not recover after SIGKILL'
assert_json "${CRASH_RECOVERY_OUTPUT}" '
  .recovered == true
  and .created == ["mcp"]
  and .refreshed == []
  and .backup_directory == null
  and (.warnings | any(contains("Migrated legacy user-file control state")))
'
[[ $(path_hash "${CRASH_VOLUME}" \
  /data/antigravity-ha/migration/native-files-state.json) == "${CRASH_STATE_HASH}" ]]
run_script "${CRASH_VOLUME}" <<'SCRIPT'
  test -f /data/home/.gemini/config/mcp_config.json
  test ! -e /data/antigravity/.native-files-update-state.json
  test ! -e /data/antigravity/.native-files-update-journal.json
  test ! -e /data/antigravity-ha/migration/native-files.json
  test -d /data/antigravity/backups/native-files
SCRIPT

# A mixed legacy/v2 control state is ambiguous. It must not be auto-merged.
run_script "${CONTROL_CONFLICT_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  jq -n '{
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: true,
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  install -d -m 0700 /run/antigravity-ha
  /usr/local/bin/antigravity-user-files-update >/dev/null
  install -d -m 0700 /data/antigravity
  jq '.applied.settings += ["9.9.9"]' \
    /data/antigravity-ha/migration/native-files-state.json \
    > /data/antigravity/.native-files-update-state.json
  chmod 0600 /data/antigravity/.native-files-update-state.json
SCRIPT
CONTROL_SETTINGS_HASH=$(path_hash \
  "${CONTROL_CONFLICT_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json)
if run_helper "${CONTROL_CONFLICT_VOLUME}" \
  >/tmp/native-control-conflict-output 2>&1; then
  fail 'different legacy and v2 control states were accepted'
fi
[[ $(path_hash "${CONTROL_CONFLICT_VOLUME}" \
  /data/home/.gemini/antigravity-cli/settings.json) == \
  "${CONTROL_SETTINGS_HASH}" ]]
run_script "${CONTROL_CONFLICT_VOLUME}" <<'SCRIPT'
  test -f /data/antigravity/.native-files-update-state.json
  test -f /data/antigravity-ha/migration/native-files-state.json
  test ! -e /data/antigravity/.native-files-update-journal.json
  test ! -e /data/antigravity-ha/migration/native-files.json
  cp /data/antigravity-ha/migration/native-files-state.json \
    /data/antigravity/.native-files-update-state.json
  chmod 0600 /data/antigravity/.native-files-update-state.json
SCRIPT
DUPLICATE_STATE_OUTPUT=$(run_helper "${CONTROL_CONFLICT_VOLUME}") \
  || fail 'byte-identical legacy/v2 state was not recovered idempotently'
assert_json "${DUPLICATE_STATE_OUTPUT}" '
  .created == []
  and .refreshed == []
  and (.warnings | any(contains("Migrated legacy user-file control state")))
'
run_script "${CONTROL_CONFLICT_VOLUME}" <<'SCRIPT'
  test ! -e /data/antigravity/.native-files-update-state.json
  test -f /data/antigravity-ha/migration/native-files-state.json
SCRIPT

# Recover the exact public v1.0.4 control layout before creating native v2
# settings. An uncommitted v1 refresh must restore its verified backup.
run_script "${PUBLIC_V1_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  transaction=refresh-20260812T000000Z-012345abcdef
  install -d -m 0700 /data/antigravity \
    "/data/antigravity/backups/user-files/${transaction}"
  jq -n '{
    antigravity_approval_policy: "on-request",
    antigravity_sandbox_mode: "workspace-write",
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  printf 'approval_policy = "on-request"\n' \
    > "/data/antigravity/backups/user-files/${transaction}/config.before"
  printf 'approval_policy = "never"\n' \
    > "/data/antigravity/backups/user-files/${transaction}/config.image-default"
  cp "/data/antigravity/backups/user-files/${transaction}/config.image-default" \
    /data/antigravity/config.toml
  before_sha=$(sha256sum \
    "/data/antigravity/backups/user-files/${transaction}/config.before" \
    | cut -d ' ' -f 1)
  candidate_sha=$(sha256sum \
    "/data/antigravity/backups/user-files/${transaction}/config.image-default" \
    | cut -d ' ' -f 1)
  jq -n --arg before "$before_sha" --arg candidate "$candidate_sha" '{
    schema: 1,
    app_version: "1.0.4",
    scopes: ["config"],
    files: {
      config: {
        existed: true,
        original_mode: 384,
        before_sha256: $before,
        candidate_sha256: $candidate
      }
    }
  }' > "/data/antigravity/backups/user-files/${transaction}/metadata.json"
  jq -n '{schema: 1, applied: {agents: [], config: []}}' \
    > /data/antigravity/.user-files-update-state.json
  jq -n --arg transaction "$transaction" '{
    schema: 1,
    app_version: "1.0.4",
    scopes: ["config"],
    transaction: $transaction
  }' > /data/antigravity/.user-files-update-journal.json
SCRIPT
PUBLIC_V1_OUTPUT=$(run_helper "${PUBLIC_V1_VOLUME}") \
  || fail 'public v1 pending transaction was not recovered'
assert_json "${PUBLIC_V1_OUTPUT}" '
  .recovered == true
  and (.warnings | any(contains("Recovered a pending public v1")))
'
run_script "${PUBLIC_V1_VOLUME}" <<'SCRIPT'
  transaction=refresh-20260812T000000Z-012345abcdef
  test ! -e /data/antigravity/.user-files-update-journal.json
  test -f /data/antigravity/.user-files-update-state.json
  cmp --silent /data/antigravity/config.toml \
    "/data/antigravity/backups/user-files/${transaction}/config.before"
  test -f /data/home/.gemini/antigravity-cli/settings.json
SCRIPT

# Once the public v1 state records commit, a later user edit is preserved and
# only the stale journal is cleared.
run_script "${PUBLIC_V1_COMMITTED_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity
  jq -n '{
    antigravity_approval_policy: "on-request",
    antigravity_sandbox_mode: "workspace-write",
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  printf '# user edit after committed v1 refresh\n' \
    > /data/antigravity/config.toml
  jq -n '{schema: 1, applied: {agents: [], config: ["1.0.4"]}}' \
    > /data/antigravity/.user-files-update-state.json
  jq -n '{
    schema: 1,
    app_version: "1.0.4",
    scopes: ["config"],
    transaction: "refresh-20260812T000001Z-fedcba543210"
  }' > /data/antigravity/.user-files-update-journal.json
SCRIPT
PUBLIC_V1_COMMITTED_HASH=$(path_hash \
  "${PUBLIC_V1_COMMITTED_VOLUME}" /data/antigravity/config.toml)
run_helper "${PUBLIC_V1_COMMITTED_VOLUME}" >/dev/null \
  || fail 'committed public v1 journal was not cleared safely'
[[ $(path_hash "${PUBLIC_V1_COMMITTED_VOLUME}" \
  /data/antigravity/config.toml) == "${PUBLIC_V1_COMMITTED_HASH}" ]]
run_script "${PUBLIC_V1_COMMITTED_VOLUME}" <<'SCRIPT'
  test ! -e /data/antigravity/.user-files-update-journal.json
  test -f /data/antigravity/.user-files-update-state.json
SCRIPT

# A v1 target that no longer matches either the before or candidate digest is
# ambiguous. Recovery must stop before native v2 files are created.
run_script "${PUBLIC_V1_CONFLICT_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  transaction=refresh-20260812T000002Z-abcdef123456
  install -d -m 0700 /data/antigravity \
    "/data/antigravity/backups/user-files/${transaction}"
  jq -n '{
    antigravity_approval_policy: "on-request",
    antigravity_sandbox_mode: "workspace-write",
    antigravity_user_files_update_mode: "preserve"
  }' > /data/options.json
  printf 'approval_policy = "on-request"\n' \
    > "/data/antigravity/backups/user-files/${transaction}/config.before"
  printf 'approval_policy = "never"\n' \
    > "/data/antigravity/backups/user-files/${transaction}/config.image-default"
  printf '# unexpected concurrent edit\n' > /data/antigravity/config.toml
  before_sha=$(sha256sum \
    "/data/antigravity/backups/user-files/${transaction}/config.before" \
    | cut -d ' ' -f 1)
  candidate_sha=$(sha256sum \
    "/data/antigravity/backups/user-files/${transaction}/config.image-default" \
    | cut -d ' ' -f 1)
  jq -n --arg before "$before_sha" --arg candidate "$candidate_sha" '{
    schema: 1,
    app_version: "1.0.4",
    scopes: ["config"],
    files: {
      config: {
        existed: true,
        original_mode: 384,
        before_sha256: $before,
        candidate_sha256: $candidate
      }
    }
  }' > "/data/antigravity/backups/user-files/${transaction}/metadata.json"
  jq -n '{schema: 1, applied: {agents: [], config: []}}' \
    > /data/antigravity/.user-files-update-state.json
  jq -n --arg transaction "$transaction" '{
    schema: 1,
    app_version: "1.0.4",
    scopes: ["config"],
    transaction: $transaction
  }' > /data/antigravity/.user-files-update-journal.json
SCRIPT
PUBLIC_V1_CONFLICT_HASH=$(path_hash \
  "${PUBLIC_V1_CONFLICT_VOLUME}" /data/antigravity/config.toml)
if run_helper "${PUBLIC_V1_CONFLICT_VOLUME}" \
  >/tmp/public-v1-conflict-output 2>&1; then
  fail 'ambiguous public v1 target was recovered destructively'
fi
[[ $(path_hash "${PUBLIC_V1_CONFLICT_VOLUME}" \
  /data/antigravity/config.toml) == "${PUBLIC_V1_CONFLICT_HASH}" ]]
run_script "${PUBLIC_V1_CONFLICT_VOLUME}" <<'SCRIPT'
  test -f /data/antigravity/.user-files-update-journal.json
  test ! -e /data/home/.gemini/antigravity-cli/settings.json
  test ! -e /data/home/.gemini/config/mcp_config.json
  test ! -e /data/antigravity-ha/migration/native-files-state.json
SCRIPT

run_script "${LINK_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity /data/home/.gemini/antigravity-cli \
    /data/home/.gemini/config
  jq -n '
    {
      antigravity_user_files_update_mode: "reset_v2",
      antigravity_tool_permission: "request-review",
      antigravity_terminal_sandbox: true
    }
  ' > /data/options.json
  printf '{}\n' > /data/home/.gemini/antigravity-cli/real-settings.json
  ln -s real-settings.json /data/home/.gemini/antigravity-cli/settings.json
  printf '{"mcpServers":{},"marker":"preserve"}\n' \
    > /data/home/.gemini/config/mcp_config.json
SCRIPT
LINK_MCP_HASH=$(path_hash "${LINK_VOLUME}" /data/home/.gemini/config/mcp_config.json)
if run_helper "${LINK_VOLUME}" >/tmp/native-link-output 2>&1; then
  fail 'reset_v2 accepted a linked settings target'
fi
[[ $(path_hash "${LINK_VOLUME}" /data/home/.gemini/config/mcp_config.json) == "${LINK_MCP_HASH}" ]]
run_script "${LINK_VOLUME}" <<'SCRIPT'
  test -L /data/home/.gemini/antigravity-cli/settings.json
  test "$(readlink /data/home/.gemini/antigravity-cli/settings.json)" = real-settings.json
  test ! -e /data/antigravity-ha/migration/native-files.json
SCRIPT

# Only completed transactions with an exact App ownership manifest are
# retention candidates. Keep two, finish a crash-interrupted quarantine on the
# next run, and leave unsafe, manifestless, and foreign-owned entries intact.
run_script "${RETENTION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  umask 077
  install -d -m 0700 /data/antigravity
  jq -n '{
    antigravity_tool_permission: "always-proceed",
    antigravity_terminal_sandbox: true,
    antigravity_user_files_update_mode: "reset_v2"
  }' > /data/options.json
SCRIPT
RETENTION_INITIAL=$(run_helper "${RETENTION_VOLUME}") \
  || fail 'initial retention fixture bootstrap failed'
assert_json "${RETENTION_INITIAL}" '
  (.created | sort) == ["mcp", "settings"]
  and .backup_directory == null
'
for RETENTION_VERSION in \
  9.9.9-retention1 \
  9.9.9-retention2 \
  9.9.9-retention3 \
  9.9.9-retention4
do
  RETENTION_OUTPUT=$(run_script "${RETENTION_VOLUME}" \
    "${RETENTION_VERSION}" <<'SCRIPT'
    set -Eeuo pipefail
    version=$1
    printf '%s\n' "${version}" \
      > /usr/local/share/antigravity-ha/app-version
    exec /usr/bin/node \
      /usr/local/share/antigravity-ha/user-files-update.mjs
SCRIPT
  ) || fail "native-file retention refresh failed: ${RETENTION_VERSION}"
  assert_json "${RETENTION_OUTPUT}" \
    ".app_version == \"${RETENTION_VERSION}\" and .refreshed == [\"settings\"]"
done

run_script "${RETENTION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  backup_root=/data/antigravity-ha/backups/native-files
  mapfile -t retained < <(
    for path in "${backup_root}"/refresh-*; do
      if [[ -d ${path} && -f ${path}/manifest.json \
        && -f ${path}/completed.json ]] \
        && jq --exit-status '
          .schema == 1
          and .owner == "antigravity-for-home-assistant"
          and .kind == "native-files-refresh"
        ' "${path}/manifest.json" >/dev/null 2>&1; then
        basename "${path}"
      fi
    done | sort
  )
  test "${#retained[@]}" -eq 2
  for transaction in "${retained[@]}"; do
    path=${backup_root}/${transaction}
    test "$(stat -c '%a:%U:%G' "${path}")" = 700:root:root
    test -z "$(find -P "${path}" -type l -print -quit)"
    jq --exit-status --arg transaction "${transaction}" '
      .transaction == $transaction
      and .state_path == "/data/antigravity-ha/migration/native-files-state.json"
      and .target_root == "/data/home"
      and (.metadata_sha256 | test("^[0-9a-f]{64}$"))
    ' "${path}/manifest.json" >/dev/null
    jq --exit-status --arg transaction "${transaction}" '
      .owner == "antigravity-for-home-assistant"
      and .kind == "native-files-refresh"
      and .transaction == $transaction
      and (.outcome == "committed" or .outcome == "rolled_back")
    ' "${path}/completed.json" >/dev/null
  done

  sentinel=/data/native-files-retention-sentinel
  printf '%s\n' preserve > "${sentinel}"
  unsafe=${backup_root}/refresh-19990101T000000Z-deadbeefcafe
  mkdir -m 0700 "${unsafe}"
  ln -s "${sentinel}" "${unsafe}/original"

  manifestless=${backup_root}/refresh-19990101T000001Z-cafebabefeed
  mkdir -m 0700 "${manifestless}"
  printf '%s\n' preserve > "${manifestless}/metadata.json"

  unowned=${backup_root}/refresh-19990101T000002Z-abcdef123456
  mkdir -m 0700 "${unowned}"
  jq -n '{schema: 1, owner: "someone-else"}' > "${unowned}/manifest.json"

  crash_source=${backup_root}/${retained[0]}
  crash_quarantine=${backup_root}/.${retained[0]}.prune-0123456789ab
  mv "${crash_source}" "${crash_quarantine}"
SCRIPT

RETENTION_RESTART=$(run_helper "${RETENTION_VOLUME}") \
  || fail 'retention restart did not finish a safe quarantine'
assert_json "${RETENTION_RESTART}" '
  .created == []
  and .refreshed == []
  and .backup_directory == null
'
run_script "${RETENTION_VOLUME}" <<'SCRIPT'
  set -Eeuo pipefail
  backup_root=/data/antigravity-ha/backups/native-files
  unsafe=${backup_root}/refresh-19990101T000000Z-deadbeefcafe
  manifestless=${backup_root}/refresh-19990101T000001Z-cafebabefeed
  unowned=${backup_root}/refresh-19990101T000002Z-abcdef123456
  test -L "${unsafe}/original"
  test "$(cat /data/native-files-retention-sentinel)" = preserve
  test "$(cat "${manifestless}/metadata.json")" = preserve
  jq --exit-status '.owner == "someone-else"' \
    "${unowned}/manifest.json" >/dev/null
  test -z "$(find "${backup_root}" -mindepth 1 -maxdepth 1 \
    -type d -name '.refresh-*.prune-*' -print -quit)"
  owned_count=0
  for path in "${backup_root}"/refresh-*; do
    if [[ -f ${path}/manifest.json && -f ${path}/completed.json ]] \
      && jq --exit-status \
        '.owner == "antigravity-for-home-assistant"' \
        "${path}/manifest.json" >/dev/null 2>&1; then
      owned_count=$((owned_count + 1))
    fi
  done
  test "${owned_count}" -le 2
SCRIPT

printf 'native user-files smoke: PASS\n'
