#!/usr/bin/env bash
set -Eeuo pipefail

TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}
case "$TEST_PLATFORM" in
  linux/amd64 | linux/arm64) ;;
  *) printf 'unsupported TEST_PLATFORM: %s\n' "$TEST_PLATFORM" >&2; exit 64 ;;
esac

SCRIPT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIRECTORY
readonly WATCH_FIXTURE="${SCRIPT_DIRECTORY}/fixtures/native-settings-atomic-watch.mjs"
readonly IMAGE=${1:-antigravity-for-home-assistant:test}
readonly TEST_ID="antigravity-ha-native-settings-${RANDOM}-$$"
readonly DENY_VOLUME="${TEST_ID}-deny"
readonly ALLOW_VOLUME="${TEST_ID}-allow"

cleanup() {
  docker volume rm --force "$DENY_VOLUME" "$ALLOW_VOLUME" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf 'native settings atomic rename smoke: %s\n' "$*" >&2
  exit 1
}

run_case() {
  local case_name=$1
  local data_volume=$2

  docker volume create "$data_volume" >/dev/null
  docker run --rm \
    --platform "$TEST_PLATFORM" \
    --network none \
    --read-only \
    --security-opt no-new-privileges \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,mode=1777,size=16m \
    --volume "${data_volume}:/data" \
    --volume "${WATCH_FIXTURE}:/test-fixtures/native-settings-atomic-watch.mjs:ro" \
    --env AGY_CLI_DISABLE_AUTO_UPDATE=true \
    --env "CASE_NAME=${case_name}" \
    --env HOME=/data/home \
    --env LANG=C.UTF-8 \
    --env LC_ALL=C.UTF-8 \
    --env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    --env TERM=xterm-256color \
    --workdir /tmp \
    --entrypoint /bin/bash \
    "$IMAGE" -ceu '
      readonly settings_directory=/data/home/.gemini/antigravity-cli
      readonly settings_path=${settings_directory}/settings.json

      install -d -m 0755 /data/home /data/home/.gemini
      case "$CASE_NAME" in
        deny) install -d -m 1777 "$settings_directory" ;;
        allow) install -d -m 0777 "$settings_directory" ;;
        *) exit 64 ;;
      esac

      run_native_with_watch() {
        local label=$1
        local ready_path="/tmp/${label}.ready"
        local stop_path="/tmp/${label}.stop"
        local events_path="/tmp/${label}.events"
        local watcher_pid
        local native_status
        local _

        /usr/bin/node \
          /test-fixtures/native-settings-atomic-watch.mjs \
          "$settings_directory" "$ready_path" "$stop_path" \
          >"$events_path" &
        watcher_pid=$!
        for _ in $(seq 1 500); do
          [[ -s $ready_path ]] && break
          sleep 0.02
        done
        [[ -s $ready_path ]]

        WATCH_HASH_BEFORE=$(sha256sum "$settings_path" | cut -d " " -f 1)
        set +e
        /usr/bin/timeout --kill-after=2 20 \
          /usr/bin/setpriv \
            --reuid=65534 --regid=65534 --clear-groups \
            /usr/local/libexec/antigravity-real agent \
            </dev/null >/tmp/native.stdout 2>/tmp/native.stderr
        native_status=$?
        set -e
        : >"$stop_path"
        wait "$watcher_pid"
        [[ $native_status -eq 0 ]]
        grep -Fqx WATCHER_DONE "$events_path"
        WATCH_HASH_AFTER=$(sha256sum "$settings_path" | cut -d " " -f 1)
        WATCH_EVENTS_PATH=$events_path
      }

      for telemetry_value in false true; do
        # Both native-stable consent values must survive normalization. The
        # deliberately minified bytes force Antigravity 1.1.13 to use its real
        # same-directory temporary + atomic rename settings writer. This
        # fixture contains no account, OAuth, API, Home Assistant, or Telegram
        # data and does not represent acceptance of the remote Terms.
        TELEMETRY_VALUE="$telemetry_value" /usr/bin/node -e '\''
          const fs = require("node:fs");
          const settings = JSON.parse(
            fs.readFileSync("/etc/antigravity/settings.json", "utf8"),
          );
          settings.enableTelemetry = process.env.TELEMETRY_VALUE === "true";
          fs.writeFileSync(
            "/data/home/.gemini/antigravity-cli/settings.json",
            JSON.stringify(settings),
          );
        '\''
        chown 0:0 "$settings_path"
        chmod 0644 "$settings_path"

        run_native_with_watch "${telemetry_value}-first"
        grep -Eq "^EVENT (change|rename) temporary$" "$WATCH_EVENTS_PATH"
        [[ -z $(find "$settings_directory" -maxdepth 1 \
          -name "settings.json.*.tmp" -print -quit) ]]

        case "$CASE_NAME" in
          deny)
            # A sticky directory with a root-owned destination is a
            # deterministic non-AppArmor stand-in for an exact final-path
            # replacement denial: native can create its temporary but cannot
            # replace settings.json. Destination bytes/owner stay unchanged.
            [[ $WATCH_HASH_BEFORE == "$WATCH_HASH_AFTER" ]]
            ! grep -Fqx "EVENT rename final" "$WATCH_EVENTS_PATH"
            [[ $(stat -c "%u:%g" "$settings_path") == 0:0 ]]

            first_hash=$WATCH_HASH_AFTER
            run_native_with_watch "${telemetry_value}-second"
            grep -Eq "^EVENT (change|rename) temporary$" "$WATCH_EVENTS_PATH"
            ! grep -Fqx "EVENT rename final" "$WATCH_EVENTS_PATH"
            [[ $WATCH_HASH_BEFORE == "$first_hash" ]]
            [[ $WATCH_HASH_AFTER == "$first_hash" ]]
            printf "%s\n" \
              "native-settings case=deny telemetry=${telemetry_value} temporary=yes final-rename=no hash=same restart=repeat"
            ;;
          allow)
            [[ $WATCH_HASH_BEFORE != "$WATCH_HASH_AFTER" ]]
            grep -Fqx "EVENT rename final" "$WATCH_EVENTS_PATH"
            [[ $(stat -c "%u:%g" "$settings_path") == 65534:65534 ]]
            /usr/bin/jq --exit-status \
              --argjson telemetry "$telemetry_value" '\''
                if $telemetry then
                  (has("enableTelemetry") | not)
                  and (keys == [
                    "allowNonWorkspaceAccess",
                    "altScreenMode",
                    "artifactReviewPolicy",
                    "showFeedbackSurvey",
                    "showTips"
                  ])
                else
                  .enableTelemetry == false
                  and (keys == [
                    "allowNonWorkspaceAccess",
                    "altScreenMode",
                    "artifactReviewPolicy",
                    "enableTelemetry",
                    "showFeedbackSurvey",
                    "showTips"
                  ])
                end
              '\'' "$settings_path" >/dev/null

            canonical_hash=$WATCH_HASH_AFTER
            run_native_with_watch "${telemetry_value}-second"
            [[ $WATCH_HASH_BEFORE == "$canonical_hash" ]]
            [[ $WATCH_HASH_AFTER == "$canonical_hash" ]]
            ! grep -Eq "^EVENT (change|rename) (temporary|final)$" \
              "$WATCH_EVENTS_PATH"
            printf "%s\n" \
              "native-settings case=allow telemetry=${telemetry_value} temporary=yes final-rename=yes hash=changed restart=idempotent"
            ;;
        esac
      done
    '
}

docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
[[ -f $WATCH_FIXTURE ]] || fail "watch fixture not found: ${WATCH_FIXTURE}"

run_case deny "$DENY_VOLUME" \
  || fail 'native final-path denial control did not preserve settings bytes'
run_case allow "$ALLOW_VOLUME" \
  || fail 'native allowed atomic rename did not persist canonical settings'

printf '%s\n' 'native settings atomic rename smoke: PASS'
