#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE=${1:-antigravity-for-home-assistant:test}
TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}
case "$TEST_PLATFORM" in
  linux/amd64) EXPECTED_IMAGE_ARCH=amd64 ;;
  linux/arm64) EXPECTED_IMAGE_ARCH=arm64 ;;
  *) printf 'unsupported TEST_PLATFORM: %s\n' "$TEST_PLATFORM" >&2; exit 64 ;;
esac

readonly SOURCE_PROFILE=antigravity_home_assistant/apparmor.txt
readonly TEST_ID="antigravity-ha-apparmor-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${RANDOM}-$$"
readonly PROFILE_NAME="antigravity_home_assistant_ci_${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-0}_${RANDOM}_$$"
readonly FIRST_CONTAINER="${TEST_ID}-cold"
readonly RESTART_CONTAINER="${TEST_ID}-restart"
readonly DATA_VOLUME="${TEST_ID}-data"
readonly CONFIG_VOLUME="${TEST_ID}-config"
readonly HELPER_RUNTIME_VOLUME="${TEST_ID}-helper-runtime"
readonly SUPERVISOR_TOKEN=apparmor-enforced-smoke-token-do-not-use
readonly EXPECTED_ANTIGRAVITY_VERSION=1.1.13
readonly ANTIGRAVITY_AUTH_REQUIRED_MARKER="Error: authentication required. Run 'antigravity-real' to log in, then retry."
WORK_DIR=$(mktemp -d)
readonly WORK_DIR
readonly RENDERED_PROFILE="${WORK_DIR}/apparmor.profile"
readonly SSH_PRIVATE_KEY="${WORK_DIR}/ssh-client-ed25519"
readonly SSH_PUBLIC_KEY="${SSH_PRIVATE_KEY}.pub"
readonly UTMP_FIXTURE="${WORK_DIR}/utmp"
readonly WTMP_FIXTURE="${WORK_DIR}/wtmp"
readonly TTYD_WEBSOCKET_SMOKE="${PWD}/tests/ttyd_websocket_smoke.py"
PROFILE_LOADED=false
AUDIT_START_EPOCH=0
PYTHON3_BIN=

redact_probe_output() {
  sed "s/${SUPERVISOR_TOKEN}/[REDACTED_HOME_ASSISTANT_TOKEN]/g"
}

profile_names() {
  sed -n -E 's/^[[:space:]]*profile ([^[:space:]]+).*/\1/p' \
    "$RENDERED_PROFILE"
}

capture_relevant_audit_denials() {
  local audit_log=$1
  local relevant_log=$2
  local name

  if ! sudo -n journalctl --dmesg --since "@${AUDIT_START_EPOCH}" \
    --no-pager --output=cat 2>/dev/null \
    | tee "$audit_log" >/dev/null; then
    return 1
  fi

  : > "$relevant_log"
  while IFS= read -r name; do
    grep -F 'apparmor="DENIED"' "$audit_log" \
      | grep -F "profile=\"${name}\"" >> "$relevant_log" \
      || true
  done < <(profile_names)
  sort --unique --output="$relevant_log" "$relevant_log"
}

print_failure_audit_denials() {
  local audit_log="${WORK_DIR}/failure-kernel-audit.log"
  local relevant_log="${WORK_DIR}/failure-relevant-denials.log"

  [[ $PROFILE_LOADED == true && $AUDIT_START_EPOCH -gt 0 \
    && -s $RENDERED_PROFILE ]] || return 0

  printf '%s\n' \
    'Relevant AppArmor audit denials captured before profile cleanup:' >&2
  if ! capture_relevant_audit_denials "$audit_log" "$relevant_log"; then
    printf '%s\n' \
      '(kernel journal unavailable while collecting failure diagnostics)' >&2
    return 0
  fi
  if [[ ! -s $relevant_log ]]; then
    printf '%s\n' '(no relevant AppArmor denial records found)' >&2
    return 0
  fi
  redact_probe_output < "$relevant_log" >&2
}

fail() {
  printf 'AppArmor enforced smoke: %s\n' "$*" >&2
  for container in "$FIRST_CONTAINER" "$RESTART_CONTAINER"; do
    if docker inspect "$container" >/dev/null 2>&1; then
      docker logs "$container" 2>&1 \
        | sed "s/${SUPERVISOR_TOKEN}/[REDACTED_HOME_ASSISTANT_TOKEN]/g" \
        || true
    fi
  done
  print_failure_audit_denials || true
  exit 1
}

cleanup() {
  local status=$?
  trap - EXIT
  docker rm --force "$FIRST_CONTAINER" "$RESTART_CONTAINER" \
    >/dev/null 2>&1 || true
  docker volume rm --force "$DATA_VOLUME" "$CONFIG_VOLUME" \
    "$HELPER_RUNTIME_VOLUME" \
    >/dev/null 2>&1 || true
  if [[ $PROFILE_LOADED == true ]]; then
    sudo -n apparmor_parser --remove --skip-cache "$RENDERED_PROFILE" \
      >/dev/null 2>&1 || true
  fi
  rm -rf -- "$WORK_DIR"
  exit "$status"
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
  command -v ssh-keygen >/dev/null 2>&1 \
    || fail 'ssh-keygen is required to create the disposable SSH fixture'
  command -v nsenter >/dev/null 2>&1 \
    || fail 'nsenter is required to reach the confined ttyd loopback endpoint'
  PYTHON3_BIN=$(command -v python3 2>/dev/null || true)
  [[ -n $PYTHON3_BIN && -x $PYTHON3_BIN ]] \
    || fail 'python3 is required to run the ttyd WebSocket probe'
  readonly PYTHON3_BIN
  [[ -f $TTYD_WEBSOCKET_SMOKE ]] \
    || fail "missing ttyd WebSocket probe: ${TTYD_WEBSOCKET_SMOKE}"
  sudo -n true >/dev/null 2>&1 \
    || fail 'passwordless sudo is required to load the kernel AppArmor profile'
  docker info --format '{{json .SecurityOptions}}' \
    | grep -Fq 'name=apparmor' \
    || fail 'Docker does not advertise AppArmor enforcement'
}

generate_disposable_ssh_key() {
  umask 077
  ssh-keygen -q -t ed25519 -N '' \
    -C apparmor-enforced-smoke \
    -f "$SSH_PRIVATE_KEY"
  [[ -s $SSH_PRIVATE_KEY && -s $SSH_PUBLIC_KEY ]] \
    || fail 'failed to create the disposable SSH key pair'
}

render_collision_safe_profile() {
  python3 - "$SOURCE_PROFILE" "$RENDERED_PROFILE" "$PROFILE_NAME" <<'PY'
from pathlib import Path
import re
import sys

source_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
profile_name = sys.argv[3]
source = source_path.read_text(encoding="utf-8")

# Supervisor recognizes and adjusts exactly one column-zero primary profile.
primary = re.findall(r"^profile ([^ ]+)", source, flags=re.MULTILINE)
if primary != ["antigravity_home_assistant"]:
    raise SystemExit(f"unexpected primary AppArmor declarations: {primary!r}")

# Mirror Supervisor's adjust_profile implementation: replace only the sole
# column-zero primary declaration. Directed secondary names and Px targets stay
# canonical, so the runtime exercises the same transition labels as HAOS.
rendered = re.sub(
    r"^profile antigravity_home_assistant(?= )",
    f"profile {profile_name}",
    source,
    count=1,
    flags=re.MULTILINE,
)
# Preserve the production permission decision while making the existing secret
# denial auditable in this disposable test profile. Its exact audit record is a
# positive control proving that the host kernel journal is actually observable.
primary, separator, secondary = rendered.partition("\n\n  profile ")
plain_canary = "  deny /config/secrets.yaml rwklm,\n"
audit_canary = "  audit deny /config/secrets.yaml rwklm,\n"
if separator == "" or primary.count(plain_canary) != 1:
    raise SystemExit("primary AppArmor denial canary rule drifted")
primary = primary.replace(plain_canary, audit_canary, 1)
rendered = primary + separator + secondary
declarations = re.findall(
    r"^[ ]*profile ([^ ]+)", rendered, flags=re.MULTILINE
)
if len(declarations) != 23 or declarations[0] != profile_name:
    raise SystemExit(f"unexpected rendered profile set: {declarations!r}")
output_path.write_text(rendered, encoding="utf-8")
output_path.chmod(0o600)
PY
}

assert_profiles_absent() {
  local name
  while IFS= read -r name; do
    if sudo -n cut -d ' ' -f 1 /sys/kernel/security/apparmor/profiles \
      | grep -Fqx "$name"; then
      fail "generated profile label already exists: ${name}"
    fi
  done < <(profile_names)
}

load_and_verify_profiles() {
  sudo -n apparmor_parser --replace --skip-cache "$RENDERED_PROFILE"
  PROFILE_LOADED=true

  local name
  while IFS= read -r name; do
    sudo -n grep -Fqx "${name} (enforce)" \
      /sys/kernel/security/apparmor/profiles \
      || fail "profile was not loaded in enforce mode: ${name}"
  done < <(profile_names)
}

seed_volumes() {
  docker volume create "$DATA_VOLUME" >/dev/null
  docker volume create "$CONFIG_VOLUME" >/dev/null
  docker volume create "$HELPER_RUNTIME_VOLUME" >/dev/null

  python3 - "$SSH_PUBLIC_KEY" <<'PY' \
    | docker run --rm --interactive \
      --platform "$TEST_PLATFORM" \
      --entrypoint /bin/sh \
      --volume "${DATA_VOLUME}:/data" \
      "$IMAGE" \
      -c 'umask 077; cat > /data/options.json'
import json
from pathlib import Path
import sys

public_key = Path(sys.argv[1]).read_text(encoding="utf-8").strip()
options = {
    "telegram_enabled": False,
    "telegram_bot_token": "",
    "telegram_allowed_user_ids": [],
    "telegram_allowed_chat_ids": [],
    "authorized_keys": [public_key],
    "web_terminal_auto_start_antigravity": False,
    "tmux_session_name": "apparmor-enforced-smoke",
    "antigravity_tool_permission": "request-review",
    "antigravity_terminal_sandbox": False,
    "antigravity_sensitive_data_access": False,
    "antigravity_user_files_update_mode": "preserve",
    "home_assistant_browser_auto_auth": False,
    "log_level": "info",
}
sys.stdout.write(json.dumps(options, separators=(",", ":")))
PY

  printf '%s\n' 'apparmor-denial-canary-no-secret' \
    | docker run --rm --interactive \
      --platform "$TEST_PLATFORM" \
      --entrypoint /bin/sh \
      --volume "${CONFIG_VOLUME}:/config" \
      "$IMAGE" \
      -c 'umask 022; cat > /config/secrets.yaml; chmod 0644 /config/secrets.yaml'

  docker run --rm \
    --platform "$TEST_PLATFORM" \
    --entrypoint /bin/cat \
    --volume "${CONFIG_VOLUME}:/config:ro" \
    "$IMAGE" /config/secrets.yaml \
    | grep -Fqx 'apparmor-denial-canary-no-secret' \
    || fail 'the unconfined control could not read the safe denial canary'

  printf '%s' "$SUPERVISOR_TOKEN" \
    | docker run --rm --interactive \
      --platform "$TEST_PLATFORM" \
      --entrypoint /bin/sh \
      --volume "${HELPER_RUNTIME_VOLUME}:/run/antigravity-ha" \
      "$IMAGE" \
      -c 'umask 077; cat > /run/antigravity-ha/supervisor.token; chmod 0600 /run/antigravity-ha/supervisor.token'
}

run_helper_credential_boundary_probe() {
  local output

  if ! output=$(docker run --rm \
    --platform "$TEST_PLATFORM" \
    --security-opt apparmor=antigravity_home_assistant-ha-helper \
    --entrypoint /bin/bash \
    --env "EXPECTED_TOKEN=${SUPERVISOR_TOKEN}" \
    --volume "${HELPER_RUNTIME_VOLUME}:/run/antigravity-ha" \
    "$IMAGE" -p -c '
      set -Eeuo pipefail
      token=$(< /run/antigravity-ha/supervisor.token)
      [[ $token == "$EXPECTED_TOKEN" ]]
      if { printf tampered > /run/antigravity-ha/supervisor.token; } 2>/dev/null; then
        exit 97
      fi
      [[ $(< /run/antigravity-ha/supervisor.token) == "$token" ]]
    ' 2>&1); then
    printf '%s\n' "$output" | redact_probe_output >&2
    fail 'the ha-helper Supervisor credential read-only boundary failed'
  fi
  if grep -Fq "$SUPERVISOR_TOKEN" <<< "$output"; then
    fail 'the ha-helper credential boundary probe exposed the fake token'
  fi
}

run_ssh_and_accounting_probe() {
  local container=$1
  local output
  local remote_command

  wait_for_log "$container" 'Enabled public-key SSH with 1 authorized key(s)'
  wait_for_log "$container" 'Starting public-key-only OpenSSH server'
  wait_for_process "$container" \
    'sshd: /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config'

  # Seed real accounting files from outside the profile. The authenticated
  # sshd and tmux session must then update them through their confined paths.
  : > "$UTMP_FIXTURE"
  : > "$WTMP_FIXTURE"
  chmod 0664 "$UTMP_FIXTURE" "$WTMP_FIXTURE"
  docker cp "$UTMP_FIXTURE" "${container}:/run/utmp" >/dev/null
  docker cp "$WTMP_FIXTURE" "${container}:/var/log/wtmp" >/dev/null
  docker cp "$SSH_PRIVATE_KEY" \
    "${container}:/tmp/apparmor-enforced-ssh-key" >/dev/null
  docker exec "$container" /bin/chown 0:0 \
    /tmp/apparmor-enforced-ssh-key
  docker exec "$container" /bin/chmod 0600 \
    /tmp/apparmor-enforced-ssh-key

  remote_command="printf '%s\\n' APPARMOR_SSH_AUTHENTICATED; cat /proc/self/attr/current; test -s /run/utmp; test -s /var/log/wtmp; printf '%s\\n' APPARMOR_ACCOUNTING_FILES_ACTIVE; tmux -L apparmor-enforced-accounting new-session -s accounting-probe \"printf '%s\\n' APPARMOR_TMUX_ACCOUNTING; sleep 1\""
  if ! output=$(docker exec --env TERM=xterm "$container" \
    /usr/bin/timeout 30 /usr/bin/ssh \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      -o GlobalKnownHostsFile=/dev/null \
      -o IdentitiesOnly=yes \
      -o LogLevel=ERROR \
      -o RequestTTY=force \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -i /tmp/apparmor-enforced-ssh-key \
      root@127.0.0.1 "$remote_command" 2>&1); then
    printf '%s\n' "$output" | redact_probe_output >&2
    fail 'the confined loopback SSH/tmux accounting probe failed'
  fi
  for marker in \
    APPARMOR_SSH_AUTHENTICATED \
    'antigravity_home_assistant-shell (enforce)' \
    APPARMOR_ACCOUNTING_FILES_ACTIVE \
    APPARMOR_TMUX_ACCOUNTING; do
    grep -Fq "$marker" <<< "$output" \
      || fail "the loopback SSH/tmux probe omitted: ${marker}"
  done
}

run_ttyd_websocket_probe() {
  local container=$1
  local container_pid
  local output

  container_pid=$(docker inspect --format '{{.State.Pid}}' "$container")
  [[ $container_pid =~ ^[1-9][0-9]*$ ]] \
    || fail "could not resolve the running container PID for ${container}"

  # ttyd intentionally listens only on the App's loopback interface. Enter
  # only the container network namespace: keep the host mount/process spaces
  # and run the repository's dependency-free client without publishing a port.
  if ! output=$(sudo -n nsenter --target "$container_pid" --net -- \
    "$PYTHON3_BIN" "$TTYD_WEBSOCKET_SMOKE" \
      ws://127.0.0.1:7682/ws 2>&1); then
    printf '%s\n' "$output" | redact_probe_output >&2
    fail 'the confined loopback ttyd WebSocket/PTY probe failed'
  fi
  grep -Fq \
    'reconnect=same resize=96x32 cwd=/config' <<< "$output" \
    || fail 'the ttyd probe did not prove tmux reconnect and resize behavior'
}

run_playwright_probe() {
  local container=$1
  local output

  docker cp tests/playwright_mcp_smoke.mjs \
    "${container}:/tmp/playwright_mcp_smoke.mjs" >/dev/null
  docker exec "$container" /bin/chown 0:0 \
    /tmp/playwright_mcp_smoke.mjs
  docker exec "$container" /bin/chmod 0600 \
    /tmp/playwright_mcp_smoke.mjs

  if ! output=$(docker exec --workdir /config "$container" \
    /usr/bin/node /tmp/playwright_mcp_smoke.mjs \
      /usr/local/bin/ha-playwright-mcp 2>&1); then
    printf '%s\n' "$output" | redact_probe_output >&2
    fail 'the real Playwright MCP probe failed under AppArmor enforcement'
  fi
  grep -Fq '"status":"passed"' <<< "$output" \
    || fail 'the Playwright MCP probe did not emit its passing result'
  if grep -Fq "$SUPERVISOR_TOKEN" <<< "$output"; then
    fail 'the Playwright MCP probe exposed the fake Supervisor token'
  fi
}

run_feedback_probe() {
  local container=$1
  local collect_output
  local report_directory
  local validate_output

  docker cp tests/fixtures/ha_feedback_bug.json \
    "${container}:/tmp/ha_feedback_bug.json" >/dev/null
  docker exec "$container" /bin/chown 0:0 /tmp/ha_feedback_bug.json
  docker exec "$container" /bin/chmod 0600 /tmp/ha_feedback_bug.json

  # Docker applies the container's primary profile to the first exec process.
  # Start with env so its child exec follows the same Px transition used by a
  # real App shell before ha-feedback enters the dedicated helper profile.
  if ! collect_output=$(docker exec "$container" /usr/bin/env \
    /usr/local/bin/ha-feedback collect bug \
      --input /tmp/ha_feedback_bug.json 2>&1); then
    printf '%s\n' "$collect_output" | redact_probe_output >&2
    fail 'the sanitized ha-feedback collection failed under enforcement'
  fi
  if grep -Fq "$SUPERVISOR_TOKEN" <<< "$collect_output"; then
    fail 'ha-feedback collection exposed the fake Supervisor token'
  fi
  report_directory=$(printf '%s' "$collect_output" \
    | docker exec --interactive "$container" /usr/bin/jq --exit-status --raw-output \
      'select(.kind == "bug" and .privacy == "PASS" and .security_issue == false) | .report_directory') \
    || fail 'ha-feedback collection did not return a sanitized bug report'
  [[ $report_directory == /config/antigravity-workspace/feedback/* ]] \
    || fail 'ha-feedback wrote outside its managed report root'

  if ! validate_output=$(docker exec "$container" /usr/bin/env \
    /usr/local/bin/ha-feedback validate "$report_directory" 2>&1); then
    printf '%s\n' "$validate_output" | redact_probe_output >&2
    fail 'the collected ha-feedback report did not validate'
  fi
  printf '%s' "$validate_output" \
    | docker exec --interactive "$container" /usr/bin/jq --exit-status \
      'select(.valid == true and .kind == "bug" and .privacy == "PASS")' \
      >/dev/null \
    || fail 'ha-feedback validation did not return the required PASS result'
  if grep -Fq "$SUPERVISOR_TOKEN" <<< "$validate_output"; then
    fail 'ha-feedback validation exposed the fake Supervisor token'
  fi
}

run_native_cli_probe() {
  local container=$1
  local access_mode=$2
  local marker_metadata
  local stream_stderr="${WORK_DIR}/native-${access_mode}.stderr"
  local stream_status
  local stream_stdout="${WORK_DIR}/native-${access_mode}.stdout"
  local version_output

  case "$access_mode" in
    restricted)
      if docker exec "$container" /usr/bin/test -e \
        /run/antigravity-ha/sensitive-data-access.enabled; then
        fail 'the restricted native CLI probe found an unexpected sensitive-access marker'
      fi
      ;;
    sensitive)
      if ! marker_metadata=$(docker exec "$container" /usr/bin/stat \
        -c '%u:%a:%h' /run/antigravity-ha/sensitive-data-access.enabled \
        2>&1); then
        printf '%s\n' "$marker_metadata" | redact_probe_output >&2
        fail 'the sensitive native CLI probe could not validate its access marker'
      fi
      [[ $marker_metadata == 0:400:1 ]] \
        || fail "the sensitive native CLI marker is unsafe: ${marker_metadata}"
      ;;
    *) fail "unknown native CLI access mode: ${access_mode}" ;;
  esac

  # runc applies the container's primary profile to the first docker-exec
  # command. Start with env so the public launcher itself performs the same
  # shell -> bootstrap -> native-runtime Px chain used by ttyd and Telegram.
  if ! version_output=$(docker exec --workdir /config "$container" \
    /usr/bin/env /usr/local/bin/antigravity --version 2>&1); then
    printf '%s\n' "$version_output" | redact_probe_output >&2
    fail "the ${access_mode} public Antigravity launcher version probe failed"
  fi
  [[ $version_output == "$EXPECTED_ANTIGRAVITY_VERSION" ]] \
    || fail "the ${access_mode} public launcher returned an unexpected version: ${version_output}"

  set +e
  printf '%s\n' 'AppArmor native worker authentication probe' \
    | docker exec --interactive --workdir /config "$container" \
      /usr/bin/env /usr/local/bin/antigravity \
        --output-format stream-json \
        --print-timeout 5s \
        --disable-slash-commands \
        >"$stream_stdout" 2>"$stream_stderr"
  stream_status=${PIPESTATUS[1]}
  set -e
  if (( stream_status == 139 )); then
    redact_probe_output < "$stream_stderr" >&2
    fail "the ${access_mode} blank-auth native worker received SIGSEGV (rc=139)"
  elif (( stream_status != 1 )); then
    redact_probe_output < "$stream_stderr" >&2
    redact_probe_output < "$stream_stdout" >&2
    fail "the ${access_mode} blank-auth native worker did not return rc=1 without a signal (rc=${stream_status})"
  fi
  [[ $(< "$stream_stderr") == "$ANTIGRAVITY_AUTH_REQUIRED_MARKER" ]] \
    || fail "the ${access_mode} blank-auth native worker stderr did not equal its authentication marker"
  [[ $(wc -l < "$stream_stdout") == 1 ]] \
    || fail "the ${access_mode} blank-auth native worker did not emit one stream result"
  docker exec --interactive "$container" /usr/bin/jq --exit-status \
      'select(
        .event == "result"
        and .result.conversation_id == ""
        and .result.status == "ERROR"
        and .result.response == ""
        and .result.error == "authentication failed or timed out"
        and .result.num_turns == 0
      )' < "$stream_stdout" >/dev/null \
    || fail "the ${access_mode} blank-auth native worker omitted its exact stream result"
}

run_managed_change_proposal_mcp_probe() {
  local container=$1
  local output

  # Attach the native runtime profile to the real managed MCP entrypoint so
  # its Px transition and complete ESM import graph are exercised by the
  # kernel. The proposal socket is intentionally unnecessary for initialize
  # and tools/list; this probe remains isolated from any Home Assistant change.
  # Docker/runc applies the requested profile to the first exec. Start with
  # env so its child exec follows the runtime profile's Px rule into the real
  # change-proposal-client profile instead of masking that file transition on
  # the container entrypoint itself.
  if ! output=$(printf '%s\n' \
      '{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"apparmor-smoke","version":"1"}}}' \
      '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
      '{"jsonrpc":"2.0","id":"list","method":"tools/list","params":{}}' \
    | docker run --rm --interactive \
      --platform "$TEST_PLATFORM" \
      --security-opt \
        apparmor=antigravity_home_assistant-interactive-runtime-restricted \
      --entrypoint /usr/bin/env \
      --env ANTIGRAVITY_HA_CHANNEL=telegram \
      --env HA_TELEGRAM_USER_ID=10001 \
      --env HA_TELEGRAM_CHAT_ID=-10001 \
      --volume "${DATA_VOLUME}:/data" \
      --volume "${CONFIG_VOLUME}:/config" \
      --workdir /config \
      "$IMAGE" /usr/local/bin/ha-change-proposal-mcp 2>&1); then
    printf '%s\n' "$output" | redact_probe_output >&2
    fail 'the managed Home Assistant change proposal MCP failed under AppArmor enforcement'
  fi
  if ! printf '%s\n' "$output" \
    | docker exec --interactive "$container" /usr/bin/jq \
      --exit-status --slurp '
        length == 2
        and .[0].id == "init"
        and .[0].result.serverInfo.name == "antigravity-ha-change-proposal"
        and .[1].id == "list"
        and ([.[1].result.tools[].name] | index("ha_change_propose")) != null
      ' >/dev/null; then
    printf '%s\n' "$output" | redact_probe_output >&2
    fail 'the managed Home Assistant change proposal MCP returned an invalid handshake'
  fi
  if grep -Fq "$SUPERVISOR_TOKEN" <<< "$output"; then
    fail 'the managed Home Assistant change proposal MCP exposed the fake Supervisor token'
  fi
}

enable_sensitive_data_access_fixture() {
  local output

  if ! output=$(docker run --rm \
    --platform "$TEST_PLATFORM" \
    --entrypoint /bin/bash \
    --volume "${DATA_VOLUME}:/data" \
    "$IMAGE" -p -c '
      set -Eeuo pipefail
      candidate=$(mktemp /data/.options-sensitive.XXXXXX)
      trap '\''[[ ! -e $candidate ]] || unlink -- "$candidate"'\'' EXIT
      jq '\''.antigravity_sensitive_data_access = true'\'' \
        /data/options.json > "$candidate"
      chmod 0600 "$candidate"
      mv -f -- "$candidate" /data/options.json
      trap - EXIT
    ' 2>&1); then
    printf '%s\n' "$output" | redact_probe_output >&2
    fail 'could not enable the sensitive-access fixture for the restart probe'
  fi
}

run_confined_feature_probes() {
  local container=$1
  run_ssh_and_accounting_probe "$container"
  run_playwright_probe "$container"
  run_feedback_probe "$container"
}

wait_for_log() {
  local container=$1
  local pattern=$2
  local expected_count=${3:-1}
  local _
  for _ in $(seq 1 120); do
    if (( $(docker logs "$container" 2>&1 | grep -Fc "$pattern" || true) \
      >= expected_count )); then
      return 0
    fi
    if [[ $(docker inspect --format '{{.State.Running}}' "$container") != true ]]; then
      fail "${container} exited before logging: ${pattern}"
    fi
    sleep 1
  done
  fail "timed out waiting for ${container} log: ${pattern}"
}

wait_for_process() {
  local container=$1
  local pattern=$2
  local _
  for _ in $(seq 1 30); do
    # The primary policy deliberately denies cross-process cmdline reads.
    # Query the Docker daemon's host-side process view instead of weakening it.
    if docker top "$container" -eo pid,args 2>/dev/null \
      | grep -Fq -- "$pattern"; then
      return 0
    fi
    sleep 1
  done
  fail "timed out waiting for ${container} process: ${pattern}"
}

assert_no_startup_fatal() {
  local container=$1
  local logs
  logs=$(docker logs "$container" 2>&1)
  if grep -Eqi \
    's6-mkdir: warning: unable to mkdir|s6-overlay-suexec: fatal|exec: fatal: unable to exec|s6-rc: warning: unable to start service|fatal: stopping the container' \
    <<< "$logs"; then
    fail "${container} logged an S6 or exec startup failure"
  fi
}

assert_enforced_container_ready() {
  local container=$1
  local expected_count=${2:-1}
  local current_profile

  wait_for_log "$container" 'antigravity runtime ready:' "$expected_count"
  wait_for_log "$container" \
    'Starting the isolated Home Assistant change broker' "$expected_count"
  wait_for_log "$container" \
    'Starting the isolated Home Assistant read broker' "$expected_count"
  wait_for_log "$container" \
    'Starting the authenticated Ingress reverse proxy' "$expected_count"
  wait_for_log "$container" 'Starting ttyd on the loopback interface' \
    "$expected_count"

  current_profile=$(docker exec "$container" /bin/cat /proc/1/attr/current)
  [[ $current_profile == "${PROFILE_NAME} (enforce)" ]] \
    || fail "PID 1 is not confined by the expected enforce profile: ${current_profile}"

  wait_for_process "$container" '/package/admin/s6/command/s6-svscan'
  wait_for_process "$container" \
    '/usr/bin/node /usr/local/share/antigravity-ha/ha-change-broker.mjs'
  wait_for_process "$container" \
    '/usr/bin/node /usr/local/share/antigravity-ha/ha-read-broker.mjs'
  wait_for_process "$container" 'bash /usr/bin/bashio ./run ha-memoryd'
  wait_for_process "$container" 'nginx: master process'
  wait_for_process "$container" \
    'ttyd --interface 127.0.0.1 --port 7682'
  wait_for_process "$container" 's6-pause'

  sleep 2
  [[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]] \
    || fail "${container} did not remain running after readiness"
  assert_no_startup_fatal "$container"

  if docker exec "$container" /bin/cat /config/secrets.yaml \
    >/dev/null 2>&1; then
    fail 'the enforced primary profile read the safe denial canary'
  fi
}

start_container() {
  local container=$1
  docker run --detach \
    --platform "$TEST_PLATFORM" \
    --name "$container" \
    --security-opt "apparmor=${PROFILE_NAME}" \
    --env "SUPERVISOR_TOKEN=${SUPERVISOR_TOKEN}" \
    --volume "${DATA_VOLUME}:/data" \
    --volume "${CONFIG_VOLUME}:/config" \
    "$IMAGE" >/dev/null
}

assert_runtime_links() {
  local actual
  actual=$(docker run --rm --platform "$TEST_PLATFORM" \
    --entrypoint /usr/bin/readlink "$IMAGE" -f /usr/bin/bashio)
  [[ $actual == /usr/lib/bashio/bashio ]] \
    || fail "unexpected bashio target: ${actual}"

  actual=$(docker run --rm --platform "$TEST_PLATFORM" \
    --entrypoint /usr/bin/readlink "$IMAGE" -f /command/with-contenv)
  [[ $actual == /package/admin/s6-overlay-3.2.2.0/command/with-contenv ]] \
    || fail "unexpected with-contenv target: ${actual}"
}

assert_relevant_audit_denials() {
  local audit_log="${WORK_DIR}/kernel-audit.log"
  local relevant_log="${WORK_DIR}/relevant-denials.log"
  local canary_seen=false
  local line

  if ! capture_relevant_audit_denials "$audit_log" "$relevant_log"; then
    fail 'kernel journal unavailable; cannot prove the absence of unexpected AppArmor denials'
  fi

  while IFS= read -r line; do
    [[ -n $line ]] || continue
    if [[ $line == *"profile=\"${PROFILE_NAME}\""* \
      && $line == *'name="/config/secrets.yaml"'* ]]; then
      canary_seen=true
      continue
    fi
    printf 'unexpected AppArmor audit denial: %s\n' "$line" >&2
    fail 'kernel audit contains a non-canary denial for the enforced profile set'
  done < "$relevant_log"

  [[ $canary_seen == true ]] \
    || fail 'kernel audit did not capture the AppArmor denial positive control'
}

require_enforcement_host
[[ -f $SOURCE_PROFILE ]] || fail "missing source policy: ${SOURCE_PROFILE}"
docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
[[ $(docker image inspect --format '{{.Architecture}}' "$IMAGE") == \
  "$EXPECTED_IMAGE_ARCH" ]] \
  || fail "image architecture does not match ${TEST_PLATFORM}"
assert_runtime_links

render_collision_safe_profile
assert_profiles_absent
AUDIT_START_EPOCH=$(date --utc +%s)
load_and_verify_profiles
generate_disposable_ssh_key
seed_volumes
run_helper_credential_boundary_probe

start_container "$FIRST_CONTAINER"
assert_enforced_container_ready "$FIRST_CONTAINER"
run_native_cli_probe "$FIRST_CONTAINER" restricted
run_managed_change_proposal_mcp_probe "$FIRST_CONTAINER"
run_ttyd_websocket_probe "$FIRST_CONTAINER"
run_confined_feature_probes "$FIRST_CONTAINER"

enable_sensitive_data_access_fixture
docker restart "$FIRST_CONTAINER" >/dev/null
assert_enforced_container_ready "$FIRST_CONTAINER" 2
run_native_cli_probe "$FIRST_CONTAINER" sensitive
docker rm --force "$FIRST_CONTAINER" >/dev/null

# Recreate the container with the same persistent data/config. This exercises a
# genuine fresh /run and S6 cold start rather than only restarting PID 1.
start_container "$RESTART_CONTAINER"
assert_enforced_container_ready "$RESTART_CONTAINER"
assert_relevant_audit_denials

printf 'AppArmor enforced smoke passed for %s (%s); real HAOS remains NOT RUN\n' \
  "$IMAGE" "$TEST_PLATFORM"
