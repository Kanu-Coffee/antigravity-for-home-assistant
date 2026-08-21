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
readonly STUB=${SCRIPT_DIRECTORY}/fixtures/onboarding-tmux-controller-stub.sh
readonly TEST_ID="antigravity-ha-onboarding-tmux-${RANDOM}-$$"
readonly CONTAINER=${TEST_ID}-container
readonly DATA_VOLUME=${TEST_ID}-data

fail() {
  printf 'onboarding tmux privacy smoke: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  docker rm --force "${CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm --force "${DATA_VOLUME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
[[ -x ${STUB} ]] || fail "controller stub is not executable: ${STUB}"
docker volume create "${DATA_VOLUME}" >/dev/null
docker run --detach \
  --name "${CONTAINER}" \
  --platform "${TEST_PLATFORM}" \
  --network none \
  --entrypoint /bin/bash \
  --volume "${DATA_VOLUME}:/data" \
  --volume "${STUB}:/usr/local/libexec/antigravity-onboarding-controller:ro" \
  "${IMAGE}" -p -ceu '
    install -d -m 0700 /config /data/home /data/tmux/tmux-0
    install -d -m 0700 /run/antigravity-ha
    install -m 0600 /dev/null /run/antigravity-ha/onboarding-active
    printf "%s\n" \
      "{\"web_terminal_auto_start_antigravity\":false}" \
      > /run/antigravity-ha/ha-feedback-options.json
    chmod 0600 /run/antigravity-ha/ha-feedback-options.json
    exec /bin/sleep infinity
  ' >/dev/null

docker exec "${CONTAINER}" /bin/bash -p -ceu '
  socket=/data/tmux/tmux-0/default

  assert_text_absent() {
    local needle=$1 content=$2
    if grep -Fq -- "$needle" <<< "$content"; then return 1; fi
  }

  wait_for_text() {
    local target=$1 expected=$2 snapshot
    for _ in $(seq 1 100); do
      snapshot=$(tmux -S "$socket" capture-pane -p -S - -t "$target")
      if grep -Fq -- "$expected" <<< "$snapshot"; then return 0; fi
      sleep 0.05
    done
    return 1
  }

  wait_for_status() {
    local path=$1
    for _ in $(seq 1 100); do
      if [[ -s $path ]]; then return 0; fi
      sleep 0.05
    done
    return 1
  }

  create_two_panes() {
    local session=$1 shell_mode=${2:-direct}
    local -a pane_command
    case "$shell_mode" in
      direct) pane_command=(/bin/bash --noprofile --norc) ;;
      web-chain) pane_command=(/usr/local/bin/tmux-session-shell) ;;
      *) return 64 ;;
    esac
    tmux -S "$socket" new-session -d -x 120 -y 14 \
      -s "$session" "${pane_command[@]}"
    TARGET_PANE=$(tmux -S "$socket" display-message -p \
      -t "$session:0.0" "#{pane_id}")
    NEIGHBOR_PANE=$(tmux -S "$socket" split-window -d -P \
      -F "#{pane_id}" -t "$TARGET_PANE" \
      "${pane_command[@]}")
    export TARGET_PANE NEIGHBOR_PANE
  }

  create_two_panes privacy-success web-chain
  target_tty=$(tmux -S "$socket" display-message -p \
    -t "$TARGET_PANE" "#{pane_tty}")
  neighbor_tty=$(tmux -S "$socket" display-message -p \
    -t "$NEIGHBOR_PANE" "#{pane_tty}")
  test "$TARGET_PANE" != "$NEIGHBOR_PANE"
  test "$target_tty" != "$neighbor_tty"
  tmux -S "$socket" send-keys -t "$TARGET_PANE" \
    "printf \"%s\\n\" \"\$TMUX_PANE\" > /data/web-chain-target-pane; tty > /data/web-chain-target-tty" Enter
  tmux -S "$socket" send-keys -t "$NEIGHBOR_PANE" \
    "printf \"%s\\n\" \"\$TMUX_PANE\" > /data/web-chain-neighbor-pane; tty > /data/web-chain-neighbor-tty" Enter
  wait_for_status /data/web-chain-target-pane
  wait_for_status /data/web-chain-target-tty
  wait_for_status /data/web-chain-neighbor-pane
  wait_for_status /data/web-chain-neighbor-tty
  test "$(< /data/web-chain-target-pane)" = "$TARGET_PANE"
  test "$(< /data/web-chain-neighbor-pane)" = "$NEIGHBOR_PANE"
  test "$(< /data/web-chain-target-tty)" = "$target_tty"
  test "$(< /data/web-chain-neighbor-tty)" = "$neighbor_tty"
  printf "%s\n" success > /data/onboarding-tmux-controller-mode
  chmod 0600 /data/onboarding-tmux-controller-mode
  tmux -S "$socket" send-keys -t "$TARGET_PANE" \
    "printf \"TARGET-PRELOGIN-HISTORY-CANARY\\n\"" Enter
  tmux -S "$socket" send-keys -t "$NEIGHBOR_PANE" \
    "printf \"NEIGHBOR-HISTORY-CANARY:preserve-success\\n\"" Enter
  wait_for_text "$TARGET_PANE" TARGET-PRELOGIN-HISTORY-CANARY
  wait_for_text "$NEIGHBOR_PANE" NEIGHBOR-HISTORY-CANARY:preserve-success

  tmux -S "$socket" send-keys -t "$TARGET_PANE" \
    "set +e; /usr/local/bin/ha-antigravity-login; login_status=\$?; printf \"%s\\n\" \"\$login_status\" > /data/tmux-login-success.status; printf \"TARGET-POSTLOGIN-MARKER\\n\"" Enter
  wait_for_status /data/tmux-login-success.status
  test "$(< /data/tmux-login-success.status)" = 0
  wait_for_text "$TARGET_PANE" TARGET-POSTLOGIN-MARKER
  test "$(stat -Lc "%u:%g:%a:%h:%s" \
    /run/antigravity-ha/onboarding-active)" = 0:0:600:1:0
  test "$(< /data/onboarding-tmux-privacy-finalized)" = finalized

  target_history=$(tmux -S "$socket" capture-pane -p -S - -t "$TARGET_PANE")
  neighbor_history=$(tmux -S "$socket" capture-pane -p -S - -t "$NEIGHBOR_PANE")
  assert_text_absent TARGET-PRELOGIN-HISTORY-CANARY "$target_history"
  assert_text_absent TARGET-OAUTH-URL-CANARY "$target_history"
  assert_text_absent TARGET-OAUTH-CODE-CANARY "$target_history"
  grep -Fq TARGET-POSTLOGIN-MARKER <<< "$target_history"
  grep -Fq NEIGHBOR-HISTORY-CANARY:preserve-success <<< "$neighbor_history"

  # Each tmux command reconnects to the fixed server socket. A second fresh
  # connection must see the same cleared server-side target history while the
  # adjacent pane remains untouched.
  reconnect_target=$(tmux -S "$socket" capture-pane -p -S - -t "$TARGET_PANE")
  reconnect_neighbor=$(tmux -S "$socket" capture-pane -p -S - -t "$NEIGHBOR_PANE")
  assert_text_absent TARGET-OAUTH-URL-CANARY "$reconnect_target"
  assert_text_absent TARGET-OAUTH-CODE-CANARY "$reconnect_target"
  grep -Fq NEIGHBOR-HISTORY-CANARY:preserve-success <<< "$reconnect_neighbor"

  # Attach through a fresh pseudo-terminal client, as a Web reconnect does,
  # then disconnect it. The rendered server state must still omit both target
  # OAuth canaries and retain the adjacent pane canary.
  TERM=xterm-256color script -qefc \
    "tmux -S $socket attach-session -t privacy-success" \
    /data/tmux-privacy-reconnect.typescript >/dev/null 2>&1 &
  reconnect_pid=$!
  reconnect_attached=false
  for _ in $(seq 1 100); do
    if tmux -S "$socket" list-clients -F "#{client_session}" \
      | grep -Fxq privacy-success; then
      reconnect_attached=true
      break
    fi
    sleep 0.05
  done
  if [[ $reconnect_attached != true ]]; then
    kill -KILL "$reconnect_pid" 2>/dev/null || true
    wait "$reconnect_pid" 2>/dev/null || true
    exit 1
  fi
  tmux -S "$socket" detach-client -s privacy-success
  wait "$reconnect_pid"
  if grep -Fq TARGET-OAUTH-URL-CANARY \
    /data/tmux-privacy-reconnect.typescript; then exit 1; fi
  if grep -Fq TARGET-OAUTH-CODE-CANARY \
    /data/tmux-privacy-reconnect.typescript; then exit 1; fi
  grep -Fq NEIGHBOR-HISTORY-CANARY:preserve-success \
    /data/tmux-privacy-reconnect.typescript
  tmux -S "$socket" kill-session -t privacy-success

  create_two_panes privacy-mismatch
  rm -f /data/onboarding-tmux-privacy-finalized
  : > /run/antigravity-ha/onboarding-active
  printf "%s\n" forged-mismatch > /data/onboarding-tmux-controller-mode
  chmod 0600 /data/onboarding-tmux-controller-mode
  tmux -S "$socket" send-keys -t "$TARGET_PANE" \
    "printf \"TARGET-MISMATCH-PRELOGIN-CANARY\\n\"" Enter
  tmux -S "$socket" send-keys -t "$NEIGHBOR_PANE" \
    "printf \"NEIGHBOR-HISTORY-CANARY:preserve-mismatch\\n\"" Enter
  wait_for_text "$TARGET_PANE" TARGET-MISMATCH-PRELOGIN-CANARY
  wait_for_text "$NEIGHBOR_PANE" NEIGHBOR-HISTORY-CANARY:preserve-mismatch

  # The command runs in TARGET_PANE but claims the adjacent pane id. The
  # wrapper must not clear either claimed neighbor history or report success.
  tmux -S "$socket" send-keys -t "$TARGET_PANE" \
    "set +e; TMUX_PANE=\"$NEIGHBOR_PANE\" /usr/local/bin/ha-antigravity-login; login_status=\$?; printf \"%s\\n\" \"\$login_status\" > /data/tmux-login-mismatch.status; printf \"MISMATCH-POSTLOGIN-MARKER\\n\"" Enter
  wait_for_status /data/tmux-login-mismatch.status
  test "$(< /data/tmux-login-mismatch.status)" = 80
  wait_for_text "$TARGET_PANE" MISMATCH-POSTLOGIN-MARKER

  mismatch_target=$(tmux -S "$socket" capture-pane -p -S - -t "$TARGET_PANE")
  mismatch_neighbor=$(tmux -S "$socket" capture-pane -p -S - -t "$NEIGHBOR_PANE")
  grep -Fq \
    "shared Web pane history could not be verified as cleared" \
    <<< "$mismatch_target"
  grep -Fq \
    "Protected onboarding state is unknown because Web pane privacy cleanup was not verified" \
    <<< "$mismatch_target"
  grep -Fq NEIGHBOR-HISTORY-CANARY:preserve-mismatch <<< "$mismatch_neighbor"
  assert_text_absent FORGED-OAUTH-URL-CANARY "$mismatch_neighbor"
  assert_text_absent FORGED-OAUTH-CODE-CANARY "$mismatch_neighbor"
  test "$(< /run/antigravity-ha/onboarding-active)" = privacy
  test ! -e /data/onboarding-tmux-privacy-finalized
  set +e
  /usr/local/libexec/antigravity-native-session-guard \
    restricted --version >/dev/null 2>&1
  mismatch_guard_status=$?
  set -e
  test "$mismatch_guard_status" -eq 78
  test "$(tmux -S "$socket" list-panes -t privacy-mismatch -F "#{pane_id}" | wc -l)" -eq 2
  tmux -S "$socket" kill-session -t privacy-mismatch

  create_two_panes privacy-sigkill
  rm -f /data/onboarding-tmux-privacy-finalized \
    /data/onboarding-tmux-wrapper.pid \
    /data/onboarding-tmux-controller.pid \
    /data/tmux-login-sigkill.status
  : > /run/antigravity-ha/onboarding-active
  printf "%s\n" sigkill > /data/onboarding-tmux-controller-mode
  chmod 0600 /data/onboarding-tmux-controller-mode
  tmux -S "$socket" send-keys -t "$NEIGHBOR_PANE" \
    "printf \"NEIGHBOR-HISTORY-CANARY:preserve-sigkill\\n\"" Enter
  wait_for_text "$NEIGHBOR_PANE" NEIGHBOR-HISTORY-CANARY:preserve-sigkill
  tmux -S "$socket" send-keys -t "$TARGET_PANE" \
    "set +e; /usr/local/bin/ha-antigravity-login; login_status=\$?; printf \"%s\\n\" \"\$login_status\" > /data/tmux-login-sigkill.status; printf \"SIGKILL-POSTLOGIN-MARKER\\n\"" Enter
  wait_for_status /data/onboarding-tmux-wrapper.pid
  wait_for_status /data/onboarding-tmux-controller.pid
  test "$(< /run/antigravity-ha/onboarding-active)" = privacy
  wrapper_pid=$(< /data/onboarding-tmux-wrapper.pid)
  controller_pid=$(< /data/onboarding-tmux-controller.pid)
  kill -KILL "$wrapper_pid"
  kill -KILL "$controller_pid" 2>/dev/null || true
  wait_for_status /data/tmux-login-sigkill.status
  wait_for_text "$TARGET_PANE" SIGKILL-POSTLOGIN-MARKER
  test "$(< /run/antigravity-ha/onboarding-active)" = privacy
  test ! -e /data/onboarding-tmux-privacy-finalized
  set +e
  /usr/local/libexec/antigravity-native-session-guard \
    restricted --version >/dev/null 2>&1
  sigkill_guard_status=$?
  set -e
  test "$sigkill_guard_status" -eq 78
  sigkill_neighbor=$(tmux -S "$socket" capture-pane -p -S - -t "$NEIGHBOR_PANE")
  grep -Fq NEIGHBOR-HISTORY-CANARY:preserve-sigkill <<< "$sigkill_neighbor"
  tmux -S "$socket" kill-server
' || fail 'real two-pane cleanup or forged-mismatch quarantine failed'

printf '%s\n' \
  'onboarding tmux privacy smoke: PASS (two-phase target clear/finalize, neighbor preservation, forged mismatch and SIGKILL quarantine; real HAOS remains NOT RUN)'
