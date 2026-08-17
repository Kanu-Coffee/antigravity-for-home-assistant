#!/usr/bin/env bash
# shellcheck disable=SC2016 # Container scripts and jq filters expand remotely.
set -Eeuo pipefail

readonly TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}
case "${TEST_PLATFORM}" in
  linux/amd64)
    readonly EXPECTED_HA_ARCH=amd64
    readonly PUBLIC_V2_DIGEST=sha256:7147fd32b3f117879451481a206cb973484a35b4646ac91907769ff9cda327df
    ;;
  linux/arm64)
    readonly EXPECTED_HA_ARCH=aarch64
    readonly PUBLIC_V2_DIGEST=sha256:e98274a617d25deeacb8db777898718f920604b260931944997b3aa52ef0c3dd
    ;;
  *)
    printf 'unsupported TEST_PLATFORM: %s\n' "${TEST_PLATFORM}" >&2
    exit 64
    ;;
esac
readonly HA_ARCH=${HA_ARCH:-$EXPECTED_HA_ARCH}
[[ ${HA_ARCH} == "${EXPECTED_HA_ARCH}" ]] || exit 64
export TEST_PLATFORM HA_ARCH

SCRIPT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIRECTORY
REPOSITORY_ROOT=$(cd -- "${SCRIPT_DIRECTORY}/.." && pwd -P)
readonly REPOSITORY_ROOT
readonly CANDIDATE_IMAGE=${1:-antigravity-for-home-assistant:test}
readonly PUBLIC_V2_IMAGE="ghcr.io/kanu-coffee/antigravity-for-home-assistant@${PUBLIC_V2_DIGEST}"
readonly PUBLIC_V2_VERSION=2.0.6
readonly PUBLIC_V2_REVISION=8eb03cfa22bac2cc481f9c5ebab4c1a250d92cb2
readonly TEST_ID="antigravity-ha-public-v2-upgrade-${RANDOM}-${RANDOM}-$$"
readonly RESOURCE_LABEL="io.antigravity-ha.test-id=${TEST_ID}"
readonly DATA_VOLUME="${TEST_ID}-data"
readonly CONFIG_VOLUME="${TEST_ID}-config"
readonly CANDIDATE_CONTAINER="${TEST_ID}-candidate"
readonly FIXTURE_USER_ID=4242424242
readonly FIXTURE_CHAT_ID=4242424242
readonly FIXTURE_UPDATE_ID=700
readonly FIXTURE_BOT_TOKEN="123456789:${TEST_ID//-/A}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
readonly OLD_CONVERSATION_ID=telegram-home-conversation-2.0.6
readonly SEALED_PROMPT=PUBLIC_V2_SEALED_PROMPT_DO_NOT_PERSIST
readonly RETIRED_HOME_MARKER=PUBLIC_V2_RETIRED_HOME_MARKER_DO_NOT_COPY
readonly SHARED_HOME_MARKER=PUBLIC_V2_SHARED_HOME_MARKER_PRESERVE

declare -a CREATED_VOLUMES=()
declare -a CREATED_CONTAINERS=()

cleanup() {
  local container
  local owner
  local volume
  for container in "${CREATED_CONTAINERS[@]}"; do
    owner=$(timeout --foreground --signal=KILL 30s \
      docker container inspect --format \
      '{{ index .Config.Labels "io.antigravity-ha.test-id" }}' \
      "${container}" 2>/dev/null || true)
    if [[ ${owner} == "${TEST_ID}" ]]; then
      timeout --foreground --signal=KILL 30s \
        docker rm -f "${container}" >/dev/null 2>&1 || true
    fi
  done
  for volume in "${CREATED_VOLUMES[@]}"; do
    owner=$(timeout --foreground --signal=KILL 30s \
      docker volume inspect --format \
      '{{ index .Labels "io.antigravity-ha.test-id" }}' \
      "${volume}" 2>/dev/null || true)
    if [[ ${owner} == "${TEST_ID}" ]]; then
      timeout --foreground --signal=KILL 30s \
        docker volume rm -f "${volume}" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT

sanitize_text() {
  local value=${1-}
  value=${value//"${FIXTURE_BOT_TOKEN}"/[REDACTED_SYNTHETIC_BOT_TOKEN]}
  value=${value//"${SEALED_PROMPT}"/[REDACTED_SYNTHETIC_PROMPT]}
  printf '%s' "${value}"
}

fail() {
  local reason
  reason=$(sanitize_text "$*")
  printf 'public v2 upgrade smoke: %s\n' "${reason}" >&2
  exit 1
}

run_bounded() {
  timeout --foreground --signal=TERM --kill-after=5s 120s "$@"
}

create_volume() {
  local volume=$1
  if run_bounded docker volume inspect "${volume}" >/dev/null 2>&1; then
    fail "refusing to reuse existing test volume: ${volume}"
  fi
  run_bounded docker volume create --label "${RESOURCE_LABEL}" "${volume}" \
    >/dev/null || fail "could not create test volume: ${volume}"
  CREATED_VOLUMES+=("${volume}")
}

resolve_image_id() {
  local reference=$1
  local image_id
  image_id=$(run_bounded docker image inspect --format '{{.Id}}' "${reference}") \
    || fail "image not found: ${reference}"
  [[ ${image_id} =~ ^sha256:[0-9a-f]{64}$ ]] \
    || fail "image does not have an immutable local image id: ${reference}"
  [[ $(run_bounded docker image inspect --format '{{.Os}}/{{.Architecture}}' \
    "${image_id}") == "${TEST_PLATFORM}" ]] \
    || fail "image platform differs from ${TEST_PLATFORM}: ${reference}"
  printf '%s' "${image_id}"
}

image_file() {
  local image_id=$1
  local path=$2
  run_bounded docker run --rm \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /bin/cat \
    "${image_id}" "${path}"
}

volume_file_hash() {
  local image_id=$1
  local path=$2
  run_bounded docker run --rm \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /usr/bin/sha256sum \
    --volume "${DATA_VOLUME}:/data" \
    "${image_id}" "${path}" | awk '{print $1}'
}

volume_json_hash() {
  local image_id=$1
  local path=$2
  local filter=$3
  run_bounded docker run --rm \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --entrypoint /usr/bin/jq \
    --volume "${DATA_VOLUME}:/data" \
    "${image_id}" --compact-output --sort-keys "${filter}" "${path}" \
    | sha256sum | awk '{print $1}'
}

wait_for_ready() {
  local attempt
  local logs
  local running
  for ((attempt = 0; attempt < 120; attempt += 1)); do
    logs=$(run_bounded docker logs "${CANDIDATE_CONTAINER}" 2>&1 || true)
    running=$(run_bounded docker inspect --format '{{.State.Running}}' \
      "${CANDIDATE_CONTAINER}" 2>/dev/null || true)
    if [[ ${running} == true ]] \
      && grep -Fq 'antigravity runtime ready:' <<< "${logs}"; then
      return 0
    fi
    if [[ ${running} != true ]]; then
      sanitize_text "${logs}" >&2
      printf '\n' >&2
      fail 'candidate exited before becoming ready'
    fi
    sleep 1
  done
  sanitize_text "${logs}" >&2
  printf '\n' >&2
  fail 'candidate did not become ready'
}

run_bounded docker pull --platform "${TEST_PLATFORM}" "${PUBLIC_V2_IMAGE}" \
  >/dev/null || fail 'could not pull the immutable public 2.0.6 image'
PUBLIC_V2_IMAGE_ID=$(resolve_image_id "${PUBLIC_V2_IMAGE}")
readonly PUBLIC_V2_IMAGE_ID
CANDIDATE_IMAGE_ID=$(resolve_image_id "${CANDIDATE_IMAGE}")
readonly CANDIDATE_IMAGE_ID

[[ $(image_file "${PUBLIC_V2_IMAGE_ID}" \
  /usr/local/share/antigravity-ha/app-version) == "${PUBLIC_V2_VERSION}" ]] \
  || fail 'public image App version is not 2.0.6'
[[ $(run_bounded docker image inspect --format \
  '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "${PUBLIC_V2_IMAGE_ID}") == "${PUBLIC_V2_REVISION}" ]] \
  || fail 'public image revision is not the published 2.0.6 source'

SOURCE_APP_VERSION=$(sed -n 's/^version: "\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)"$/\1/p' \
  "${REPOSITORY_ROOT}/antigravity_home_assistant/config.yaml")
readonly SOURCE_APP_VERSION
[[ ${SOURCE_APP_VERSION} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail 'source App version is invalid'
[[ $(image_file "${CANDIDATE_IMAGE_ID}" \
  /usr/local/share/antigravity-ha/app-version) == "${SOURCE_APP_VERSION}" ]] \
  || fail 'candidate image version differs from the source App version'

create_volume "${DATA_VOLUME}"
create_volume "${CONFIG_VOLUME}"

run_bounded docker run --rm --interactive \
  --platform "${TEST_PLATFORM}" \
  --network none \
  --env FIXTURE_BOT_TOKEN="${FIXTURE_BOT_TOKEN}" \
  --env FIXTURE_CHAT_ID="${FIXTURE_CHAT_ID}" \
  --env FIXTURE_UPDATE_ID="${FIXTURE_UPDATE_ID}" \
  --env FIXTURE_USER_ID="${FIXTURE_USER_ID}" \
  --env OLD_CONVERSATION_ID="${OLD_CONVERSATION_ID}" \
  --env RETIRED_HOME_MARKER="${RETIRED_HOME_MARKER}" \
  --env SEALED_PROMPT="${SEALED_PROMPT}" \
  --env SHARED_HOME_MARKER="${SHARED_HOME_MARKER}" \
  --entrypoint /bin/bash \
  --volume "${DATA_VOLUME}:/data" \
  --volume "${CONFIG_VOLUME}:/config" \
  "${PUBLIC_V2_IMAGE_ID}" -s <<'PUBLIC_V2_SEED'
set -Eeuo pipefail
umask 077
install -d -m 0700 /run/antigravity-ha /data/antigravity-ha /config
jq --null-input '{
  telegram_enabled: false,
  telegram_bot_token: "",
  telegram_allowed_user_ids: [],
  telegram_allowed_chat_ids: [],
  telegram_access_mode: "autonomous",
  authorized_keys: [],
  web_terminal_auto_start_antigravity: false,
  tmux_session_name: "antigravity-ha-public-v2-upgrade",
  antigravity_tool_permission: "request-review",
  antigravity_terminal_sandbox: true,
  antigravity_sensitive_data_access: false,
  antigravity_user_files_update_mode: "preserve",
  home_assistant_browser_auto_auth: false,
  log_level: "info"
}' > /data/options.json

/usr/local/bin/antigravity-user-files-update >/tmp/public-v2-user-files.json
jq --exit-status '
  .app_version == "2.0.6"
  and .mode == "preserve"
  and (.created | index("settings") != null)
' /tmp/public-v2-user-files.json >/dev/null
jq --exit-status '
  (.permissions.deny | index("read_file(/data)") != null)
  and (.permissions.deny | index("write_file(/data)") != null)
' /data/home/.gemini/antigravity-cli/settings.json >/dev/null

/usr/local/libexec/ha-telegram-home-bootstrap --login
printf '%s\n' "${RETIRED_HOME_MARKER}" \
  > /data/antigravity-ha/telegram-home/.retired-home-marker
printf '%s\n' "${SHARED_HOME_MARKER}" \
  > /data/home/.gemini/antigravity-cli/.shared-home-marker

node --input-type=module <<'NODE'
import {
  consumePairing,
  createPairing,
  isPaired,
} from "/usr/local/share/antigravity-ha/telegram-pairing.mjs";
import {
  loadBridgeState,
  registerSealedUpdateBatch,
  setConversation,
} from "/usr/local/share/antigravity-ha/telegram-state.mjs";

const now = Date.now();
const pairing = createPairing({ ttlMs: 300_000, now });
const authorization = consumePairing(
  pairing.token,
  process.env.FIXTURE_USER_ID,
  process.env.FIXTURE_CHAT_ID,
  { chatType: "private", now: now + 1 },
);
if (!authorization || !isPaired(
  process.env.FIXTURE_USER_ID,
  process.env.FIXTURE_CHAT_ID,
  { chatType: "private" },
)) {
  throw new Error("public 2.0.6 pairing fixture was not created");
}
const updateId = Number(process.env.FIXTURE_UPDATE_ID);
const normalized = {
  updateId,
  kind: "message",
  value: {
    updateId,
    message_id: updateId + 1,
    from: { id: process.env.FIXTURE_USER_ID },
    chat: { id: process.env.FIXTURE_CHAT_ID, type: "private" },
    text: process.env.SEALED_PROMPT,
  },
};
registerSealedUpdateBatch(
  [{ update_id: updateId, normalized }],
  process.env.FIXTURE_BOT_TOKEN,
);
setConversation(
  process.env.FIXTURE_USER_ID,
  process.env.FIXTURE_CHAT_ID,
  process.env.OLD_CONVERSATION_ID,
  { now },
);
const state = loadBridgeState();
if (state.version !== 4 || state.update_offset !== 0 ||
    state.transport_offset !== updateId + 1 ||
    state.update_ledger.length !== 1 || state.sealed_updates.length !== 1 ||
    state.conversations.length !== 1) {
  throw new Error("public 2.0.6 bridge-state fixture is invalid");
}
NODE

jq --arg marker "${SHARED_HOME_MARKER}" '
  .user_upgrade_marker = $marker
  | .permissions.allow += ["user(custom/global)"]
' /data/home/.gemini/antigravity-cli/settings.json \
  > /data/home/.gemini/antigravity-cli/.settings-upgrade-candidate
mv /data/home/.gemini/antigravity-cli/.settings-upgrade-candidate \
  /data/home/.gemini/antigravity-cli/settings.json
chmod 0600 \
  /data/home/.gemini/antigravity-cli/settings.json \
  /data/home/.gemini/antigravity-cli/.shared-home-marker \
  /data/antigravity-ha/telegram-home/.retired-home-marker
PUBLIC_V2_SEED

AUTHORIZATION_HASH_BEFORE=$(volume_file_hash "${PUBLIC_V2_IMAGE_ID}" \
  /data/antigravity-ha/telegram/authorizations.json)
readonly AUTHORIZATION_HASH_BEFORE
RETIRED_SETTINGS_HASH_BEFORE=$(volume_file_hash "${PUBLIC_V2_IMAGE_ID}" \
  /data/antigravity-ha/telegram-home/.gemini/antigravity-cli/settings.json)
readonly RETIRED_SETTINGS_HASH_BEFORE
RETIRED_MARKER_HASH_BEFORE=$(volume_file_hash "${PUBLIC_V2_IMAGE_ID}" \
  /data/antigravity-ha/telegram-home/.retired-home-marker)
readonly RETIRED_MARKER_HASH_BEFORE
SEALED_RECORD_HASH_BEFORE=$(volume_json_hash "${PUBLIC_V2_IMAGE_ID}" \
  /data/antigravity-ha/telegram/bridge-state.json '.sealed_updates[0]')
readonly SEALED_RECORD_HASH_BEFORE

CREATED_CONTAINERS+=("${CANDIDATE_CONTAINER}")
run_bounded docker run --detach \
  --platform "${TEST_PLATFORM}" \
  --network none \
  --label "${RESOURCE_LABEL}" \
  --name "${CANDIDATE_CONTAINER}" \
  --volume "${DATA_VOLUME}:/data" \
  --volume "${CONFIG_VOLUME}:/config" \
  "${CANDIDATE_IMAGE_ID}" >/dev/null \
  || fail 'candidate container could not start with public 2.0.6 data'
wait_for_ready

# This generic container has no Supervisor credential or API. It therefore
# proves only that the legacy channel-policy key is ignored safely by the current
# runtime. The fixed Supervisor self-options deletion has a separate component
# contract and is not simulated here.
run_bounded docker exec "${CANDIDATE_CONTAINER}" jq --exit-status '
  .telegram_access_mode == "autonomous"
' /data/options.json >/dev/null \
  || fail 'candidate rewrote or consumed the legacy Telegram option locally'

[[ $(volume_file_hash "${CANDIDATE_IMAGE_ID}" \
  /data/antigravity-ha/telegram/authorizations.json) \
  == "${AUTHORIZATION_HASH_BEFORE}" ]] \
  || fail 'v2 local pairing authorization bytes changed during upgrade'
[[ $(volume_file_hash "${CANDIDATE_IMAGE_ID}" \
  /data/antigravity-ha/telegram-home/.gemini/antigravity-cli/settings.json) \
  == "${RETIRED_SETTINGS_HASH_BEFORE}" ]] \
  || fail 'retired dedicated-HOME settings changed during upgrade'
[[ $(volume_file_hash "${CANDIDATE_IMAGE_ID}" \
  /data/antigravity-ha/telegram-home/.retired-home-marker) \
  == "${RETIRED_MARKER_HASH_BEFORE}" ]] \
  || fail 'retired dedicated-HOME marker changed during upgrade'

run_bounded docker exec --interactive \
  --env FIXTURE_BOT_TOKEN="${FIXTURE_BOT_TOKEN}" \
  --env FIXTURE_CHAT_ID="${FIXTURE_CHAT_ID}" \
  --env FIXTURE_UPDATE_ID="${FIXTURE_UPDATE_ID}" \
  --env FIXTURE_USER_ID="${FIXTURE_USER_ID}" \
  --env OLD_CONVERSATION_ID="${OLD_CONVERSATION_ID}" \
  --env SEALED_PROMPT="${SEALED_PROMPT}" \
  "${CANDIDATE_CONTAINER}" node --input-type=module <<'CANDIDATE_STATE'
import { readFileSync } from "node:fs";
import {
  isPaired,
  listPairings,
} from "/usr/local/share/antigravity-ha/telegram-pairing.mjs";
import {
  getSession,
  loadBridgeState,
  loadSealedUpdates,
  registerSealedUpdateBatch,
} from "/usr/local/share/antigravity-ha/telegram-state.mjs";

const updateId = Number(process.env.FIXTURE_UPDATE_ID);
const normalized = {
  updateId,
  kind: "message",
  value: {
    updateId,
    message_id: updateId + 1,
    from: { id: process.env.FIXTURE_USER_ID },
    chat: { id: process.env.FIXTURE_CHAT_ID, type: "private" },
    text: process.env.SEALED_PROMPT,
  },
};
registerSealedUpdateBatch(
  [{ update_id: updateId, normalized }],
  process.env.FIXTURE_BOT_TOKEN,
);

const state = loadBridgeState();
const session = getSession(
  process.env.FIXTURE_USER_ID,
  process.env.FIXTURE_CHAT_ID,
);
if (!session || session.generation !== 1 || session.conversation_id !== null) {
  throw new Error("dedicated-HOME conversation id was not reset exactly once");
}
if (state.update_offset !== 0 || state.transport_offset !== updateId + 1 ||
    state.update_ledger.length !== 1 ||
    state.update_ledger[0].update_id !== updateId ||
    state.update_ledger[0].acknowledged !== false ||
    state.sealed_updates.length !== 1 || state.sessions.length !== 1) {
  throw new Error("v4 transport state was not preserved during migration");
}
const updates = loadSealedUpdates(process.env.FIXTURE_BOT_TOKEN);
if (updates.length !== 1 || updates[0].value.text !== process.env.SEALED_PROMPT) {
  throw new Error("v4 sealed update could not be recovered after migration");
}
if (!isPaired(
  process.env.FIXTURE_USER_ID,
  process.env.FIXTURE_CHAT_ID,
  { chatType: "private" },
)) {
  throw new Error("v2 local pairing authorization was not preserved semantically");
}
const pairings = listPairings();
if (pairings.pending.length !== 0 || pairings.authorizations.length !== 1) {
  throw new Error("v2 pairing state changed during upgrade");
}
const raw = readFileSync(
  "/data/antigravity-ha/telegram/bridge-state.json",
  "utf8",
);
if (raw.includes(process.env.OLD_CONVERSATION_ID) ||
    raw.includes(process.env.SEALED_PROMPT)) {
  throw new Error("retired conversation or sealed prompt remained in plaintext");
}
CANDIDATE_STATE

[[ $(volume_json_hash "${CANDIDATE_IMAGE_ID}" \
  /data/antigravity-ha/telegram/bridge-state.json '.sealed_updates[0]') \
  == "${SEALED_RECORD_HASH_BEFORE}" ]] \
  || fail 'v4 sealed update record changed during migration'
[[ $(volume_file_hash "${CANDIDATE_IMAGE_ID}" \
  /data/antigravity-ha/telegram/authorizations.json) \
  == "${AUTHORIZATION_HASH_BEFORE}" ]] \
  || fail 'v2 pairing state changed while checking migration semantics'

run_bounded docker exec "${CANDIDATE_CONTAINER}" jq --exit-status \
  --arg marker "${SHARED_HOME_MARKER}" '
    .user_upgrade_marker == $marker
    and (.permissions.allow | index("user(custom/global)") != null)
    and (.permissions.allow | index("read_file(/config)") != null)
    and (.permissions.allow | index("write_file(/config)") == null)
    and (.permissions.allow | index("read_file(/data/home/.gemini/config)") != null)
    and (.permissions.allow | index("write_file(/data/home/.gemini/config)") == null)
    and (.permissions.allow | index("read_file(/data/home/.gemini/antigravity-cli/agents)") != null)
    and (.permissions.allow | index("write_file(/data/home/.gemini/antigravity-cli/agents)") == null)
    and (.permissions.allow | index("read_file(/data/home/.gemini/antigravity-cli/plugins)") != null)
    and (.permissions.allow | index("write_file(/data/home/.gemini/antigravity-cli/plugins)") == null)
    and (.permissions.allow | index("read_file(/data/home/.gemini/antigravity-cli/settings.json)") != null)
    and (.permissions.allow | index("write_file(/data/home/.gemini/antigravity-cli/settings.json)") == null)
    and (.permissions.allow | index("command(*)") == null)
    and (.permissions.allow | index("mcp(*)") == null)
    and (.permissions.ask | index("command(*)") == null)
    and (.permissions.ask | index("write_file(*)") == null)
    and (.permissions.allow | index("mcp(ha_change/ha_change_propose)") != null)
    and (.permissions.allow
      | index("mcp(ha_read/ha_read_storage_usage)") != null)
    and (.permissions.allow
      | index("mcp(telegram_action/telegram_action_propose)") != null)
    and (.permissions.deny | index("write_file(/data/home/.gemini/antigravity-cli/settings.json)") != null)
    and (.permissions.deny | index("read_file(/data)") == null)
    and (.permissions.deny | index("write_file(/data)") == null)
    and (.permissions.deny | index("read_file(/config/secrets.yaml)") != null)
    and (.permissions.deny | index("write_file(/config/.storage)") != null)
  ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null \
  || fail 'shared global permissions were not migrated from preserve mode'

run_bounded docker exec "${CANDIDATE_CONTAINER}" /bin/bash -ceu '
  grep -Fxq "PUBLIC_V2_SHARED_HOME_MARKER_PRESERVE" \
    /data/home/.gemini/antigravity-cli/.shared-home-marker
  test ! -e /data/home/.gemini/antigravity-cli/.retired-home-marker
  test ! -e /usr/local/bin/ha-telegram-login
  test ! -e /usr/local/libexec/ha-telegram-home-bootstrap
  test ! -e /usr/local/libexec/ha-telegram-worker
  test ! -e /usr/local/lib/antigravity-ha/telegram-plugin.sh
  test ! -e /etc/antigravity/telegram-settings.json
  test ! -e /usr/local/share/antigravity-ha/telegram-workspace
  test ! -e /usr/local/share/antigravity-ha/playwright-telegram-init-page.ts
  test ! -e /usr/local/share/antigravity-ha/plugins/home-assistant/agents/ha-telegram
  test ! -e /data/home/.gemini/config/plugins/home-assistant/agents/ha-telegram
' || fail 'retired Telegram runtime files or agent remain in the candidate'

APPARMOR_SOURCE=${REPOSITORY_ROOT}/antigravity_home_assistant/apparmor.txt
for retired_profile in \
  antigravity_home_assistant-telegram-login \
  antigravity_home_assistant-telegram-worker \
  antigravity_home_assistant-memory-telegram \
  antigravity_home_assistant-playwright-bootstrap-telegram \
  antigravity_home_assistant-browser-telegram; do
  if grep -Fq -- "${retired_profile}" "${APPARMOR_SOURCE}"; then
    fail "retired AppArmor profile remains: ${retired_profile}"
  fi
done
grep -Fq -- \
  'profile antigravity_home_assistant-change-proposal-client' \
  "${APPARMOR_SOURCE}" \
  || fail 'shared change-proposal AppArmor profile is missing'

printf '%s\n' \
  "public v2 upgrade smoke PASS: ${PUBLIC_V2_VERSION} -> ${SOURCE_APP_VERSION} (${TEST_PLATFORM})"
