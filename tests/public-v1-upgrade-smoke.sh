#!/usr/bin/env bash
# shellcheck disable=SC2016 # Container scripts and jq filters expand remotely.
set -Eeuo pipefail

readonly TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}
[[ ${TEST_PLATFORM} == linux/amd64 ]] || {
  printf 'public v1.0.4 only supports linux/amd64\n' >&2
  exit 64
}

SCRIPT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIRECTORY
REPOSITORY_ROOT=$(cd -- "${SCRIPT_DIRECTORY}/.." && pwd -P)
readonly REPOSITORY_ROOT
readonly SOURCE_MANIFEST_TOOL=${SOURCE_MANIFEST_TOOL:-${REPOSITORY_ROOT}/.github/scripts/source-rootfs-manifest.py}
readonly SOURCE_ROOTFS_DIRECTORY=${REPOSITORY_ROOT}/antigravity_home_assistant/rootfs
readonly SOURCE_ROOTFS_MANIFEST=${SOURCE_ROOTFS_DIRECTORY}/usr/local/share/antigravity-ha/source-rootfs-manifest.json
readonly V1_IMAGE=${1:-antigravity-for-home-assistant:public-v1.0.4-local}
readonly CANDIDATE_IMAGE=${2:-antigravity-for-home-assistant:v2-candidate-amd64}
PUBLIC_V1_TAG_REVISION=$(git -C "${REPOSITORY_ROOT}" rev-parse 'v1.0.4^{commit}')
readonly PUBLIC_V1_TAG_REVISION
readonly EXPECTED_V1_REVISION=${EXPECTED_V1_REVISION:-${PUBLIC_V1_TAG_REVISION}}
readonly EXPECTED_CANDIDATE_REVISION=${EXPECTED_CANDIDATE_REVISION:-$(git -C "${REPOSITORY_ROOT}" rev-parse HEAD)}
STARTED_AT=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
readonly STARTED_AT
readonly TEST_ID="antigravity-ha-public-v1-upgrade-${RANDOM}-${RANDOM}-${RANDOM}-$$"
readonly RESOURCE_LABEL="io.antigravity-ha.test-id=${TEST_ID}"

readonly MAPPING_MARKER="${TEST_ID}-mapping"
readonly PRESERVE_MARKER="${TEST_ID}-preserve"
readonly MAPPING_CHAT_ID=123456789
readonly PRESERVE_CHAT_ID=987654321
readonly MAPPING_APP_TOKEN="${MAPPING_MARKER}-app-token"
readonly MAPPING_BROWSER_TOKEN="${MAPPING_MARKER}-browser-token"
readonly MAPPING_BOT_TOKEN="${MAPPING_MARKER}-bot-token"
readonly PRESERVE_APP_TOKEN="${PRESERVE_MARKER}-app-token"
readonly PRESERVE_BROWSER_TOKEN="${PRESERVE_MARKER}-browser-token"
readonly PRESERVE_BOT_TOKEN="${PRESERVE_MARKER}-bot-token"

readonly MAPPING_DATA_VOLUME="${TEST_ID}-mapping-data"
readonly MAPPING_CONFIG_VOLUME="${TEST_ID}-mapping-config"
readonly PRESERVE_DATA_VOLUME="${TEST_ID}-preserve-data"
readonly PRESERVE_CONFIG_VOLUME="${TEST_ID}-preserve-config"
readonly MAPPING_V1_CONTAINER="${TEST_ID}-mapping-v1"
readonly MAPPING_V2_CONTAINER="${TEST_ID}-mapping-v2"
readonly PRESERVE_V1_CONTAINER="${TEST_ID}-preserve-v1"
readonly PRESERVE_V2_CONTAINER="${TEST_ID}-preserve-v2"
readonly V1_SOURCE_CONTAINER="${TEST_ID}-v1-source"

declare -a CREATED_CONTAINERS=()
declare -a CREATED_VOLUMES=()
TEMPORARY_DIRECTORY=''
CANDIDATE_VERIFIED_FILES=''
CANDIDATE_APP_VERSION=''
declare -a SENSITIVE_CANARIES=(
  "${MAPPING_MARKER}"
  "${PRESERVE_MARKER}"
  "${MAPPING_CHAT_ID}"
  "${PRESERVE_CHAT_ID}"
)

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
  if [[ -n ${TEMPORARY_DIRECTORY} \
    && ${TEMPORARY_DIRECTORY} == /tmp/antigravity-ha-public-v1-upgrade.* \
    && -d ${TEMPORARY_DIRECTORY} ]]; then
    rm -rf -- "${TEMPORARY_DIRECTORY}"
  fi
}
trap cleanup EXIT

sanitize_text() {
  local value=${1-}
  local canary
  for canary in "${SENSITIVE_CANARIES[@]}"; do
    value=${value//"${canary}"/[REDACTED_TEST_CANARY]}
  done
  printf '%s' "${value}"
}

fail() {
  local reason
  reason=$(sanitize_text "$*")
  printf 'public v1 upgrade smoke: %s\n' "${reason}" >&2
  exit 1
}

run_bounded() {
  timeout --foreground --signal=TERM --kill-after=5s 60s "$@"
}

container_exec() {
  local container=$1
  shift
  run_bounded docker exec "${container}" "$@"
}

image_label() {
  local image_id=$1
  local label=$2
  run_bounded docker image inspect --format \
    "{{ index .Config.Labels \"${label}\" }}" "${image_id}"
}

read_source_app_version() {
  python3 - "${REPOSITORY_ROOT}/antigravity_home_assistant/config.yaml" <<'PYTHON'
import re
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
matches = re.findall(
    r'^version: "([0-9]+\.[0-9]+\.[0-9]+)"$',
    config_path.read_text(encoding="utf-8"),
    flags=re.MULTILINE,
)
if len(matches) != 1:
    raise SystemExit("App config must contain exactly one numeric version")
print(matches[0])
PYTHON
}

resolve_image_id() {
  local reference=$1
  local image_id
  image_id=$(run_bounded docker image inspect --format '{{.Id}}' "${reference}") \
    || fail "image not found: ${reference}"
  [[ ${image_id} =~ ^sha256:[0-9a-f]{64}$ ]] \
    || fail "image does not have an immutable local image ID: ${reference}"
  [[ $(run_bounded docker image inspect --format '{{.Os}}/{{.Architecture}}' \
    "${image_id}") == linux/amd64 ]] \
    || fail "image is not linux/amd64: ${reference}"
  printf '%s' "${image_id}"
}

assert_clean_source_checkout() {
  local status
  status=$(git -C "${REPOSITORY_ROOT}" status --porcelain=v1 \
    --untracked-files=all) || fail 'could not inspect the source worktree'
  [[ -z ${status} ]] \
    || fail 'source worktree is dirty; a commit-bound candidate rehearsal would be ambiguous'
}

assert_candidate_source_checkout() {
  local head_revision
  head_revision=$(git -C "${REPOSITORY_ROOT}" rev-parse HEAD) \
    || fail 'could not resolve the candidate source HEAD'
  [[ ${head_revision} == "${EXPECTED_CANDIDATE_REVISION}" ]] \
    || fail 'EXPECTED_CANDIDATE_REVISION does not match the source HEAD'
  assert_clean_source_checkout
}

assert_public_v1_revision() {
  [[ ${EXPECTED_V1_REVISION} == "${PUBLIC_V1_TAG_REVISION}" ]] \
    || fail 'EXPECTED_V1_REVISION does not resolve to the public v1.0.4 tag'
}

verify_public_v1_source_binding() {
  local image_id=$1
  local expected_revision=$2
  local archive=${TEMPORARY_DIRECTORY}/public-v1-rootfs.tar
  register_container "${V1_SOURCE_CONTAINER}"
  run_bounded docker create \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --label "${RESOURCE_LABEL}" \
    --name "${V1_SOURCE_CONTAINER}" \
    --entrypoint /bin/true \
    "${image_id}" >/dev/null \
    || fail 'could not create the public v1 source-verification container'
  timeout --foreground --signal=TERM --kill-after=10s 300s \
    docker export --output "${archive}" "${V1_SOURCE_CONTAINER}" \
    || fail 'could not export the public v1 image for source verification'
  run_bounded python3 - "${REPOSITORY_ROOT}" "${expected_revision}" \
    "${archive}" <<'PYTHON'
import hashlib
import subprocess
import sys
import tarfile
from pathlib import Path, PurePosixPath

repository = Path(sys.argv[1]).resolve(strict=True)
revision = sys.argv[2]
archive_path = Path(sys.argv[3]).resolve(strict=True)
rootfs_prefix = "antigravity_home_assistant/rootfs/"


def git_output(*arguments: str) -> bytes:
    return subprocess.check_output(
        ["git", "-C", str(repository), *arguments],
        stderr=subprocess.DEVNULL,
    )


def canonical_tar_name(value: str) -> str:
    while value.startswith("./"):
        value = value[2:]
    path = PurePosixPath(value)
    if (
        not value
        or value.startswith("/")
        or "\x00" in value
        or ".." in path.parts
    ):
        raise ValueError("public v1 image export contains an unsafe path")
    return path.as_posix()


records = git_output(
    "ls-tree",
    "-rz",
    "--full-tree",
    revision,
    "--",
    "antigravity_home_assistant/rootfs",
).split(b"\0")
expected: dict[str, bytes] = {}
for record in records:
    if not record:
        continue
    header, raw_path = record.split(b"\t", 1)
    mode, object_type, object_id = header.decode("ascii").split(" ", 2)
    path = raw_path.decode("utf-8")
    if object_type != "blob" or not path.startswith(rootfs_prefix):
        raise ValueError("public v1 tag rootfs contains an unsupported entry")
    destination = path.removeprefix(rootfs_prefix)
    if mode not in {"100644", "100755"}:
        raise ValueError("public v1 tag rootfs contains an unsupported file mode")
    expected[destination] = git_output("cat-file", "blob", object_id)
if len(expected) != 80:
    raise ValueError("public v1.0.4 tag does not contain the expected 80 rootfs files")

for source, destination in (
    (
        "antigravity_home_assistant/playwright/package.json",
        "usr/local/lib/antigravity-ha/playwright/package.json",
    ),
    (
        "antigravity_home_assistant/playwright/package-lock.json",
        "usr/local/lib/antigravity-ha/playwright/package-lock.json",
    ),
):
    expected[destination] = git_output("show", f"{revision}:{source}")

with tarfile.open(archive_path, mode="r:*") as archive:
    members: dict[str, tarfile.TarInfo] = {}
    for member in archive.getmembers():
        name = canonical_tar_name(member.name)
        if name in expected:
            if name in members:
                raise ValueError("public v1 image export contains a duplicate source path")
            members[name] = member
    if set(members) != set(expected):
        raise ValueError("public v1 image is missing tag-bound source files")
    for name, expected_content in expected.items():
        member = members[name]
        if (
            not member.isfile()
            or member.islnk()
            or member.issym()
            or member.uid != 0
            or member.gid != 0
            or member.mode & 0o777 not in {0o600, 0o644, 0o755}
        ):
            raise ValueError(
                f"public v1 image source metadata differs from the tag: {name}"
            )
        stream = archive.extractfile(member)
        if stream is None:
            raise ValueError("public v1 image source file is unreadable")
        if hashlib.sha256(stream.read()).digest() != hashlib.sha256(expected_content).digest():
            raise ValueError(
                f"public v1 image source content differs from the tag: {name}"
            )
PYTHON
  rm -f -- "${archive}"
  stop_app "${V1_SOURCE_CONTAINER}"
}

verify_candidate_source_binding() {
  local image_id=$1
  local expected_revision=$2
  local expected_source_rootfs=$3
  local current_source_rootfs
  local verification
  [[ -f ${SOURCE_MANIFEST_TOOL} ]] \
    || fail 'SOURCE_MANIFEST_TOOL is missing; candidate source verification is unavailable'
  [[ -f ${SOURCE_ROOTFS_MANIFEST} ]] \
    || fail 'the current source-rootfs manifest is missing'
  current_source_rootfs=$(run_bounded python3 "${SOURCE_MANIFEST_TOOL}" verify \
    --root "${SOURCE_ROOTFS_DIRECTORY}" \
    --manifest "${SOURCE_ROOTFS_MANIFEST}") \
    || fail 'the source-rootfs manifest does not match the current source'
  [[ ${current_source_rootfs} == "${expected_source_rootfs}" ]] \
    || fail 'the candidate source-rootfs label is stale relative to current source'
  verification=$(timeout --foreground --signal=TERM --kill-after=10s 300s \
    python3 "${SOURCE_MANIFEST_TOOL}" verify-image \
    --image "${image_id}" \
    --expected-revision "${expected_revision}" \
    --expected-source-rootfs-sha256 "${expected_source_rootfs}") \
    || fail 'candidate source-image verification failed'
  jq --exit-status \
    --arg image_id "${image_id}" \
    --arg revision "${expected_revision}" \
    --arg source_rootfs "${expected_source_rootfs}" '
      type == "object"
      and ((keys | sort) == [
        "image_id",
        "revision",
        "schema",
        "source_rootfs_sha256",
        "verified_files"
      ])
      and .schema == "antigravity-ha-source-image-verification/v1"
      and .image_id == $image_id
      and .revision == $revision
      and .source_rootfs_sha256 == $source_rootfs
      and (.verified_files | type == "number" and . > 0 and floor == .)
    ' <<< "${verification}" >/dev/null \
    || fail 'candidate source-image verifier returned invalid evidence'
  CANDIDATE_VERIFIED_FILES=$(jq --raw-output '.verified_files' \
    <<< "${verification}")
}

create_volume() {
  local volume=$1
  if run_bounded docker volume inspect "${volume}" >/dev/null 2>&1; then
    fail "refusing to reuse an existing test volume: ${volume}"
  fi
  run_bounded docker volume create --label "${RESOURCE_LABEL}" "${volume}" \
    >/dev/null || fail "could not create test volume: ${volume}"
  CREATED_VOLUMES+=("${volume}")
  [[ $(run_bounded docker volume inspect --format \
    '{{ index .Labels "io.antigravity-ha.test-id" }}' "${volume}") == "${TEST_ID}" ]] \
    || fail "test volume ownership label is invalid: ${volume}"
}

register_container() {
  local container=$1
  if run_bounded docker container inspect "${container}" >/dev/null 2>&1; then
    fail "refusing to reuse an existing test container: ${container}"
  fi
  CREATED_CONTAINERS+=("${container}")
}

container_logs() {
  local container=$1
  run_bounded docker logs "${container}" 2>&1
}

print_sanitized_logs() {
  local container=$1
  local logs=''
  logs=$(container_logs "${container}") || true
  sanitize_text "${logs}" >&2
  printf '\n' >&2
}

wait_for_ready() {
  local container=$1
  local attempt
  local logs
  local running
  for ((attempt = 0; attempt < 120; attempt += 1)); do
    logs=$(container_logs "${container}") || true
    running=$(run_bounded docker inspect --format '{{.State.Running}}' \
      "${container}" 2>/dev/null || true)
    if [[ ${running} == true ]] \
      && grep -Fq 'antigravity runtime ready:' <<< "${logs}"; then
      return 0
    fi
    if [[ ${running} != true ]]; then
      print_sanitized_logs "${container}"
      fail "${container} exited before becoming ready"
    fi
    sleep 1
  done
  print_sanitized_logs "${container}"
  fail "timed out waiting for ${container}"
}

start_app() {
  local container=$1
  local image_id=$2
  local data_volume=$3
  local config_volume=$4
  register_container "${container}"
  run_bounded docker run --detach \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --label "${RESOURCE_LABEL}" \
    --name "${container}" \
    --volume "${data_volume}:/data" \
    --volume "${config_volume}:/config" \
    "${image_id}" >/dev/null \
    || fail "could not start ${container}"
  wait_for_ready "${container}"
}

stop_app() {
  local container=$1
  run_bounded docker rm -f "${container}" >/dev/null \
    || fail "could not stop ${container}"
}

seed_v1_scenario() {
  local data_volume=$1
  local config_volume=$2
  local scenario=$3
  local mode=$4
  local marker=$5
  local app_token=$6
  local browser_token=$7
  local bot_token=$8
  local chat_id=$9

  run_bounded docker run --rm --interactive \
    --platform "${TEST_PLATFORM}" \
    --network none \
    --env FIXTURE_SCENARIO="${scenario}" \
    --env FIXTURE_MODE="${mode}" \
    --env FIXTURE_MARKER="${marker}" \
    --env FIXTURE_APP_TOKEN="${app_token}" \
    --env FIXTURE_BROWSER_TOKEN="${browser_token}" \
    --env FIXTURE_BOT_TOKEN="${bot_token}" \
    --env FIXTURE_CHAT_ID="${chat_id}" \
    --entrypoint /bin/bash \
    --volume "${data_volume}:/data" \
    --volume "${config_volume}:/config" \
    "${V1_IMAGE_ID}" -s <<'SEED'
set -Eeuo pipefail
umask 077
[[ ${FIXTURE_SCENARIO} == mapping || ${FIXTURE_SCENARIO} == preserve ]]
install -d -m 0700 /data/test-fixture
ssh-keygen -q -t ed25519 -N '' -C "${FIXTURE_SCENARIO}-fixture" \
  -f /data/test-fixture/client_ed25519
authorized_key=$(< /data/test-fixture/client_ed25519.pub)
jq --null-input \
  --arg app_token "${FIXTURE_APP_TOKEN}" \
  --arg bot_token "${FIXTURE_BOT_TOKEN}" \
  --arg browser_token "${FIXTURE_BROWSER_TOKEN}" \
  --arg chat_id "${FIXTURE_CHAT_ID}" \
  --arg mode "${FIXTURE_MODE}" \
  --arg public_key "${authorized_key}" \
  --arg session "agy-v1-upgrade-${FIXTURE_SCENARIO}" '
  {
    antigravity_token: $app_token,
    telegram_enabled: false,
    telegram_bot_token: $bot_token,
    telegram_allowed_chat_ids: [$chat_id],
    authorized_keys: [$public_key],
    web_terminal_auto_start_antigravity: false,
    tmux_session_name: $session,
    antigravity_approval_policy: "never",
    antigravity_sandbox_mode: "danger-full-access",
    browser_approval_policy: "always",
    antigravity_user_files_update_mode: $mode,
    home_assistant_browser_auto_auth: false,
    home_assistant_browser_token: $browser_token,
    log_level: "info"
  }
' > /data/options.json
printf '%s\n' "${FIXTURE_MARKER}-config" \
  > "/config/.antigravity-ha-public-v1-${FIXTURE_SCENARIO}"
chmod 0600 /data/options.json \
  "/config/.antigravity-ha-public-v1-${FIXTURE_SCENARIO}" \
  /data/test-fixture/client_ed25519
chmod 0644 /data/test-fixture/client_ed25519.pub
SEED
}

container_hash() {
  local container=$1
  local path=$2
  container_exec "${container}" sha256sum "${path}" | awk '{print $1}'
}

file_contract() {
  local container=$1
  local path=$2
  container_exec "${container}" /bin/bash -ceu '
    path=$1
    test -f "$path"
    test ! -L "$path"
    stat -c "%u:%g:%h:%a:%F" -- "$path"
  ' -- "${path}"
}

file_identity() {
  local container=$1
  local path=$2
  container_exec "${container}" /bin/bash -ceu '
    path=$1
    test -f "$path"
    test ! -L "$path"
    stat -c "%d:%i:%u:%g:%h:%a:%F" -- "$path"
  ' -- "${path}"
}

file_observation() {
  local container=$1
  local path=$2
  container_exec "${container}" /bin/bash -ceu '
    path=$1
    test -f "$path"
    test ! -L "$path"
    stat -c "%d:%i:%u:%g:%h:%a:%s:%y:%z:%F" -- "$path"
  ' -- "${path}"
}

assert_file_contract() {
  local container=$1
  local path=$2
  local mode=$3
  [[ $(file_contract "${container}" "${path}") == "0:0:1:${mode}:regular file" ]] \
    || fail "unsafe file metadata after migration: ${path}"
}

assert_private_directory() {
  local container=$1
  local path=$2
  container_exec "${container}" /bin/bash -ceu '
    path=$1
    test -d "$path"
    test ! -L "$path"
    test "$(stat -c "%u:%g:%a:%F" -- "$path")" = "0:0:700:directory"
  ' -- "${path}" >/dev/null \
    || fail "unsafe private directory after migration: ${path}"
}

assert_path_absent() {
  local container=$1
  local path=$2
  container_exec "${container}" /bin/bash -ceu '
    path=$1
    test ! -e "$path"
    test ! -L "$path"
  ' -- "${path}" >/dev/null || fail "unexpected path remains: ${path}"
}

container_tree_digest() {
  local container=$1
  local root=$2
  local manifest
  manifest=$(container_exec "${container}" /bin/bash -ceu '
    root=$1
    test -d "$root"
    test ! -L "$root"
    while IFS= read -r -d "" path; do
      relative=${path#"$root"/}
      metadata=$(stat -c "%u:%g:%a:%h:%F" -- "$path")
      case "$metadata" in
        0:0:700:*:directory)
          digest=-
          ;;
        0:0:600:1:regular\ file)
          read -r digest _ < <(sha256sum "$path")
          ;;
        *)
          printf "unsafe backup entry: %s %s\\n" "$relative" "$metadata" >&2
          exit 1
          ;;
      esac
      printf "%s\\t%s\\t%s\\n" "$relative" "$metadata" "$digest"
    done < <(find -P "$root" -mindepth 1 -print0 | sort -z)
  ' -- "${root}") || fail 'public v1 backup tree is unsafe'
  [[ -n ${manifest} ]] || fail 'public v1 backup tree is empty'
  printf '%s' "${manifest}" | sha256sum | awk '{print $1}'
}

assert_logs_clean() {
  local container=$1
  local logs
  local canary
  logs=$(container_logs "${container}") || fail "could not read logs for ${container}"
  for canary in "${SENSITIVE_CANARIES[@]}"; do
    if grep -Fq -- "${canary}" <<< "${logs}"; then
      fail "a secret or identifier canary appeared in ${container} logs"
    fi
  done
}

assert_log_fragment() {
  local container=$1
  local fragment=$2
  local logs
  logs=$(container_logs "${container}") || fail "could not read logs for ${container}"
  grep -Fq -- "${fragment}" <<< "${logs}" \
    || fail "required migration result was not logged: ${fragment}"
}

assert_no_canary_in_runtime_targets() {
  local container=$1
  local app_token=$2
  local browser_token=$3
  local bot_token=$4
  local scan_result
  local scan_status
  set +e
  scan_result=$(container_exec "${container}" /bin/bash -ceu '
    app_token=$1
    browser_token=$2
    bot_token=$3

    print_path() {
      printf "%s\n" "$1" | jq --raw-input --compact-output .
    }

    validate_native_cli_log_link() {
      local link_path=$1
      local cli_root
      local link_target
      local log_directory
      local target_path
      local target_contract
      case "$link_path" in
        /data/home/.gemini/antigravity-cli/cli.log)
          ;;
        *) return 1 ;;
      esac
      [[ $(stat -c "%u:%g:%h:%a:%F" -- "$link_path") == \
        "0:0:1:777:symbolic link" ]] || return 1
      cli_root=${link_path%/cli.log}
      log_directory=${cli_root}/log
      [[ -d $cli_root && ! -L $cli_root ]] || return 1
      [[ $(stat -c "%u:%g:%a:%F" -- "$cli_root") == \
        "0:0:700:directory" ]] || return 1
      [[ -d $log_directory && ! -L $log_directory ]] || return 1
      [[ $(stat -c "%u:%g:%a:%F" -- "$log_directory") == \
        "0:0:700:directory" ]] || return 1
      link_target=$(readlink -- "$link_path") || return 1
      [[ $link_target =~ ^log/cli-[0-9]{8}_[0-9]{6}\.log$ ]] || return 1
      [[ $link_target != /* && $link_target != *..* ]] || return 1
      target_path=${cli_root}/${link_target}
      [[ -f $target_path && ! -L $target_path ]] || return 1
      target_contract=$(stat -c "%u:%g:%h:%a:%F" -- "$target_path") \
        || return 1
      [[ $target_contract =~ ^0:0:1:(600|644):regular\ file$ ]] || return 1
    }

    for root in \
      /run/antigravity-ha \
      /config \
      /data/antigravity \
      /data/antigravity-ha \
      /data/antigravity-ha-memory \
      /data/browser-auth \
      /data/github-cli \
      /data/home/.gemini/mcp_config.json \
      /data/home/.gemini/antigravity-cli \
      /data/home/.gemini/config \
      /data/ssh \
      /root/.gemini; do
      if [[ -L $root ]]; then
        print_path "$root"
        exit 20
      fi
      [[ -e $root ]] || continue
      while IFS= read -r -d "" unsafe_path; do
        if [[ -L $unsafe_path ]] \
          && validate_native_cli_log_link "$unsafe_path"; then
          continue
        fi
        print_path "$unsafe_path"
        exit 20
      done < <(
        find -P "$root" -xdev \
          \( -type l -o \( -type f ! -links 1 \) \) -print0
      )
      while IFS= read -r -d "" path; do
        for canary in "$app_token" "$browser_token" "$bot_token"; do
          set +e
          timeout --foreground --signal=KILL 2s \
            grep -Fq -- "$canary" "$path" >/dev/null 2>&1
          status=$?
          set -e
          case "$status" in
            0)
              print_path "$path"
              exit 21
              ;;
            1) ;;
            *)
              print_path "$path"
              exit 22
              ;;
          esac
        done
      done < <(find -P "$root" -xdev -type f -links 1 -print0)
    done
  ' -- "${app_token}" "${browser_token}" "${bot_token}")
  scan_status=$?
  set -e
  case "${scan_status}" in
    0)
      [[ -z ${scan_result} ]] \
        || fail 'runtime target scan returned unexpected output'
      ;;
    20) fail "unsafe runtime target metadata: ${scan_result}" ;;
    21) fail "a retired legacy token remained in a v2 runtime target: ${scan_result}" ;;
    22) fail "a v2 runtime target could not be scanned safely: ${scan_result}" ;;
    *) fail 'v2 runtime target inspection failed' ;;
  esac
}

assert_managed_plugin_contract() {
  local container=$1
  local plugin=/data/home/.gemini/config/plugins/home-assistant
  local marker=${plugin}/.antigravity-ha-managed.json
  local settings=/data/home/.gemini/antigravity-cli/settings.json
  local mcp=/data/home/.gemini/config/mcp_config.json
  local settings_hash_before
  local settings_metadata_before
  local mcp_hash_before
  local mcp_metadata_before
  settings_hash_before=$(container_hash "${container}" "${settings}")
  settings_metadata_before=$(file_observation "${container}" "${settings}")
  mcp_hash_before=$(container_hash "${container}" "${mcp}")
  mcp_metadata_before=$(file_observation "${container}" "${mcp}")
  assert_file_contract "${container}" "${marker}" 600
  container_exec "${container}" jq --exit-status \
    --arg candidate_version "${CANDIDATE_APP_VERSION}" '
    type == "object"
    and ((keys | sort) == [
      "applied_versions",
      "installed_version",
      "owner",
      "plugin",
      "schema"
    ])
    and .schema == 1
    and .owner == "antigravity-for-home-assistant"
    and .plugin == "home-assistant"
    and .installed_version == $candidate_version
    and .applied_versions == [$candidate_version]
  ' "${marker}" >/dev/null \
    || fail 'the v2 managed plugin ownership marker is invalid'
  container_exec "${container}" /bin/bash -ceu '
    test ! -e /data/antigravity-ha/migration/managed-plugin.json
    test ! -L /data/antigravity-ha/migration/managed-plugin.json
  ' >/dev/null || fail 'v2 left a pending managed-plugin journal'
  container_exec "${container}" env -i \
    AGY_CLI_DISABLE_AUTO_UPDATE=true \
    HOME=/data/home \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    /usr/local/libexec/antigravity-real plugin validate "${plugin}" \
    >/dev/null || fail 'the native Antigravity CLI rejected the installed plugin'
  container_exec "${container}" test ! -e "${plugin}/agents/ha-telegram" \
    || fail 'the retired Telegram-only agent was installed during upgrade'
  [[ $(container_hash "${container}" "${settings}") == \
    "${settings_hash_before}" \
    && $(file_observation "${container}" "${settings}") == \
      "${settings_metadata_before}" ]] \
    || fail 'native plugin validation changed user settings'
  [[ $(container_hash "${container}" "${mcp}") == "${mcp_hash_before}" \
    && $(file_observation "${container}" "${mcp}") == \
      "${mcp_metadata_before}" ]] \
    || fail 'native plugin validation changed user MCP configuration'
}

assert_ssh_contract() {
  local container=$1
  local key_type
  for key_type in ed25519 rsa; do
    assert_file_contract "${container}" "/data/ssh/ssh_host_${key_type}_key" 600
    assert_file_contract "${container}" "/data/ssh/ssh_host_${key_type}_key.pub" 644
    container_exec "${container}" /bin/bash -ceu '
      private_key=$1
      public_key=$2
      ssh-keygen -y -f "$private_key" | cmp --silent - "$public_key"
    ' -- "/data/ssh/ssh_host_${key_type}_key" \
      "/data/ssh/ssh_host_${key_type}_key.pub" >/dev/null \
      || fail "SSH ${key_type} private/public host key mismatch"
  done
  assert_file_contract "${container}" /data/ssh/authorized_keys 600
  container_exec "${container}" cmp --silent \
    /data/test-fixture/client_ed25519.pub /data/ssh/authorized_keys \
    || fail 'SSH authorized_keys does not match the preserved option key'
  container_exec "${container}" ssh-keygen -l -f /data/ssh/authorized_keys \
    >/dev/null || fail 'SSH authorized_keys is not accepted by ssh-keygen'
  container_exec "${container}" sshd -t -f /etc/ssh/sshd_config \
    >/dev/null || fail 'the upgraded sshd configuration is invalid'
  assert_path_absent "${container}" /run/antigravity-ha/ssh-disabled
}

assert_telegram_not_reused() {
  local container=$1
  local chat_id=$2
  local pairings
  container_exec "${container}" test ! -L \
    /data/antigravity-ha/telegram/authorizations.json \
    || fail 'v2 Telegram authorization state is a symbolic link'
  if container_exec "${container}" test -e \
    /data/antigravity-ha/telegram/authorizations.json; then
    assert_file_contract "${container}" \
      /data/antigravity-ha/telegram/authorizations.json 600
    container_exec "${container}" jq --exit-status '
      type == "object"
      and ((keys | sort) == ["authorizations", "pending", "version"])
      and .version == 2
      and .pending == []
      and .authorizations == []
    ' /data/antigravity-ha/telegram/authorizations.json >/dev/null \
      || fail 'legacy Telegram authorization was imported into v2 state'
  fi
  pairings=$(container_exec "${container}" ha-telegram-pair list) \
    || fail 'could not inspect v2 Telegram pairing state'
  jq --exit-status '
    type == "object"
    and ((keys | sort) == ["authorizations", "pending"])
    and .pending == []
    and .authorizations == []
  ' \
    <<< "${pairings}" >/dev/null \
    || fail 'v2 Telegram pairing state is not empty after legacy quarantine'
  run_bounded docker exec --env LEGACY_CHAT_ID="${chat_id}" "${container}" \
    /usr/bin/node --input-type=module -e '
      import { readFileSync } from "node:fs";
      import { isPaired } from "/usr/local/share/antigravity-ha/telegram-pairing.mjs";
      import { isAuthorized, loadRuntimeConfig } from "/usr/local/share/antigravity-ha/telegram-bridge.mjs";
      const id = process.env.LEGACY_CHAT_ID;
      const config = loadRuntimeConfig(JSON.parse(readFileSync("/data/options.json", "utf8")));
      if (config.allowedUsers.size !== 0 || !config.allowedChats.has(id)) process.exit(1);
      const message = { from: { id }, chat: { id, type: "private" } };
      if (isAuthorized(config, message, { pairingLookup: () => false })) process.exit(1);
      if (isPaired(id, id, { chatType: "private" })) process.exit(1);
    ' >/dev/null || fail 'a legacy Telegram ID was accepted by v2 authorization'
}

run_mapping_scenario() {
  local options_hash
  local options_metadata
  local public_state_hash
  local public_state_metadata
  local backup_digest
  local legacy_config_hash
  local legacy_config_metadata
  local legacy_agents_hash
  local legacy_agents_metadata
  local legacy_mcp_hash
  local legacy_mcp_metadata
  local authorized_hash
  local authorized_identity
  local pair_hash
  local pair_identity

  create_volume "${MAPPING_DATA_VOLUME}"
  create_volume "${MAPPING_CONFIG_VOLUME}"
  seed_v1_scenario "${MAPPING_DATA_VOLUME}" "${MAPPING_CONFIG_VOLUME}" \
    mapping refresh_all "${MAPPING_MARKER}" "${MAPPING_APP_TOKEN}" \
    "${MAPPING_BROWSER_TOKEN}" "${MAPPING_BOT_TOKEN}" "${MAPPING_CHAT_ID}"
  start_app "${MAPPING_V1_CONTAINER}" "${V1_IMAGE_ID}" \
    "${MAPPING_DATA_VOLUME}" "${MAPPING_CONFIG_VOLUME}"

  container_exec "${MAPPING_V1_CONTAINER}" jq --exit-status '
    type == "object"
    and ((keys | sort) == ["applied", "schema"])
    and .schema == 1
    and .applied == {agents:["1.0.4"],config:["1.0.4"]}
  ' /data/antigravity/.user-files-update-state.json >/dev/null \
    || fail 'public v1.0.4 did not create its real refresh_all ownership state'
  assert_file_contract "${MAPPING_V1_CONTAINER}" \
    /data/antigravity/.user-files-update-state.json 600
  assert_path_absent "${MAPPING_V1_CONTAINER}" \
    /data/antigravity/.user-files-update-journal.json
  container_exec "${MAPPING_V1_CONTAINER}" /bin/bash -ceu '
    shopt -s nullglob
    transactions=(/data/antigravity/backups/user-files/refresh-*)
    (( ${#transactions[@]} == 1 ))
    transaction=${transactions[0]}
    test -f "$transaction/agents.image-default"
    test -f "$transaction/config.image-default"
    test -f "$transaction/metadata.json"
    mapfile -t entries < <(
      find -P "$transaction" -mindepth 1 -maxdepth 1 -printf "%f\n" | sort
    )
    (( ${#entries[@]} == 3 ))
    [[ ${entries[0]} == agents.image-default ]]
    [[ ${entries[1]} == config.image-default ]]
    [[ ${entries[2]} == metadata.json ]]
    jq --exit-status ".schema == 1 and .app_version == \"1.0.4\"
      and ((.scopes | sort) == [\"agents\", \"config\"])" \
      "$transaction/metadata.json" >/dev/null
  ' >/dev/null || fail 'public v1.0.4 refresh_all backup is incomplete'
  assert_private_directory "${MAPPING_V1_CONTAINER}" \
    /data/antigravity/backups/user-files
  backup_digest=$(container_tree_digest "${MAPPING_V1_CONTAINER}" \
    /data/antigravity/backups/user-files)

  run_bounded docker exec --interactive \
    --env FIXTURE_MARKER="${MAPPING_MARKER}" \
    --env LEGACY_CHAT_ID="${MAPPING_CHAT_ID}" \
    "${MAPPING_V1_CONTAINER}" /bin/bash -s <<'MAPPING_FIXTURE'
set -Eeuo pipefail
marker=/data/antigravity-ha-test/legacy-mcp-executed
install -d -m 0700 /data/antigravity-ha-test
rm -f "$marker"
jq --null-input --arg marker "$marker" '
  {mcpServers:{legacy_v1_canary:{command:"/usr/bin/touch",args:[$marker]}}}
' > /data/home/.gemini/mcp_config.json
jq --null-input --arg chat_id "${LEGACY_CHAT_ID}" '[$chat_id]' \
  > /data/antigravity/telegram_authorized_chats.json
jq --null-input --arg marker "${FIXTURE_MARKER}" '
  {pair_token:$marker,pin_code:"654321"}
' > /data/antigravity/telegram_pair_info.json
chmod 0600 \
  /data/home/.gemini/mcp_config.json \
  /data/antigravity/telegram_authorized_chats.json \
  /data/antigravity/telegram_pair_info.json
MAPPING_FIXTURE
  assert_path_absent "${MAPPING_V1_CONTAINER}" \
    /data/home/.gemini/antigravity-cli/settings.json
  assert_path_absent "${MAPPING_V1_CONTAINER}" \
    /data/home/.gemini/config/mcp_config.json
  options_hash=$(container_hash "${MAPPING_V1_CONTAINER}" /data/options.json)
  options_metadata=$(file_contract "${MAPPING_V1_CONTAINER}" /data/options.json)
  public_state_hash=$(container_hash "${MAPPING_V1_CONTAINER}" \
    /data/antigravity/.user-files-update-state.json)
  public_state_metadata=$(file_contract "${MAPPING_V1_CONTAINER}" \
    /data/antigravity/.user-files-update-state.json)
  legacy_mcp_hash=$(container_hash "${MAPPING_V1_CONTAINER}" \
    /data/home/.gemini/mcp_config.json)
  legacy_mcp_metadata=$(file_contract "${MAPPING_V1_CONTAINER}" \
    /data/home/.gemini/mcp_config.json)
  legacy_config_hash=$(container_hash "${MAPPING_V1_CONTAINER}" \
    /data/antigravity/config.toml)
  legacy_config_metadata=$(file_contract "${MAPPING_V1_CONTAINER}" \
    /data/antigravity/config.toml)
  legacy_agents_hash=$(container_hash "${MAPPING_V1_CONTAINER}" \
    /data/antigravity/AGENTS.md)
  legacy_agents_metadata=$(file_contract "${MAPPING_V1_CONTAINER}" \
    /data/antigravity/AGENTS.md)
  authorized_hash=$(container_hash "${MAPPING_V1_CONTAINER}" \
    /data/antigravity/telegram_authorized_chats.json)
  authorized_identity=$(file_identity "${MAPPING_V1_CONTAINER}" \
    /data/antigravity/telegram_authorized_chats.json)
  pair_hash=$(container_hash "${MAPPING_V1_CONTAINER}" \
    /data/antigravity/telegram_pair_info.json)
  pair_identity=$(file_identity "${MAPPING_V1_CONTAINER}" \
    /data/antigravity/telegram_pair_info.json)
  assert_logs_clean "${MAPPING_V1_CONTAINER}"
  stop_app "${MAPPING_V1_CONTAINER}"

  start_app "${MAPPING_V2_CONTAINER}" "${CANDIDATE_IMAGE_ID}" \
    "${MAPPING_DATA_VOLUME}" "${MAPPING_CONFIG_VOLUME}"
  [[ $(container_hash "${MAPPING_V2_CONTAINER}" /data/options.json) == \
    "${options_hash}" ]] || fail 'legacy App options changed during mapping scenario'
  [[ $(file_contract "${MAPPING_V2_CONTAINER}" /data/options.json) == \
    "${options_metadata}" ]] \
    || fail 'legacy App option metadata changed during mapping scenario'
  [[ $(container_hash "${MAPPING_V2_CONTAINER}" \
    /data/antigravity/.user-files-update-state.json) == "${public_state_hash}" ]] \
    || fail 'public v1 ownership state changed during upgrade'
  [[ $(file_contract "${MAPPING_V2_CONTAINER}" \
    /data/antigravity/.user-files-update-state.json) == "${public_state_metadata}" ]] \
    || fail 'public v1 ownership state metadata changed during upgrade'
  [[ $(container_tree_digest "${MAPPING_V2_CONTAINER}" \
    /data/antigravity/backups/user-files) == "${backup_digest}" ]] \
    || fail 'public v1 rollback backup tree changed during upgrade'
  [[ $(container_hash "${MAPPING_V2_CONTAINER}" \
    /data/home/.gemini/mcp_config.json) == "${legacy_mcp_hash}" ]] \
    || fail 'public v1 legacy MCP configuration changed during upgrade'
  [[ $(file_contract "${MAPPING_V2_CONTAINER}" \
    /data/home/.gemini/mcp_config.json) == "${legacy_mcp_metadata}" ]] \
    || fail 'public v1 legacy MCP metadata changed during upgrade'
  [[ $(container_hash "${MAPPING_V2_CONTAINER}" \
    /data/antigravity/config.toml) == "${legacy_config_hash}" ]] \
    || fail 'public v1 legacy config.toml changed during upgrade'
  [[ $(file_contract "${MAPPING_V2_CONTAINER}" \
    /data/antigravity/config.toml) == "${legacy_config_metadata}" ]] \
    || fail 'public v1 legacy config.toml metadata changed during upgrade'
  [[ $(container_hash "${MAPPING_V2_CONTAINER}" \
    /data/antigravity/AGENTS.md) == "${legacy_agents_hash}" ]] \
    || fail 'public v1 legacy AGENTS.md changed during upgrade'
  [[ $(file_contract "${MAPPING_V2_CONTAINER}" \
    /data/antigravity/AGENTS.md) == "${legacy_agents_metadata}" ]] \
    || fail 'public v1 legacy AGENTS.md metadata changed during upgrade'
  assert_path_absent "${MAPPING_V2_CONTAINER}" \
    /data/antigravity-ha-test/legacy-mcp-executed

  container_exec "${MAPPING_V2_CONTAINER}" jq --exit-status --slurp '
    .[0] as $settings
    | .[1] as $state
    | ($settings
      | (has("toolPermission") | not)
      and .enableTerminalSandbox == true
      and ((.permissions | keys | sort) == ["allow", "ask", "deny"])
      and ((.permissions.allow | length) == (.permissions.allow | unique | length))
      and ((.permissions.ask | length) == (.permissions.ask | unique | length))
      and ((.permissions.deny | length) == (.permissions.deny | unique | length))
      and (.permissions.allow | index("mcp(ha_read/ha_read_state)") != null)
      and (.permissions.allow | index("mcp(playwright/browser_snapshot)") != null)
      and (.permissions.allow | index("read_file(/config)") != null)
      and (.permissions.allow | index("write_file(/config)") != null)
      and (.permissions.allow | index("read_file(/data/home/.gemini/config)") != null)
      and (.permissions.allow | index("write_file(/data/home/.gemini/config)") != null)
      and (.permissions.allow | index("read_file(/data/home/.gemini/antigravity-cli/agents)") != null)
      and (.permissions.allow | index("write_file(/data/home/.gemini/antigravity-cli/agents)") != null)
      and (.permissions.allow | index("read_file(/data/home/.gemini/antigravity-cli/plugins)") != null)
      and (.permissions.allow | index("write_file(/data/home/.gemini/antigravity-cli/plugins)") != null)
      and (.permissions.allow | index("read_file(/data/home/.gemini/antigravity-cli/skills)") != null)
      and (.permissions.allow | index("write_file(/data/home/.gemini/antigravity-cli/skills)") != null)
      and (.permissions.allow | index("read_file(/data/home/.gemini/GEMINI.md)") != null)
      and (.permissions.allow | index("write_file(/data/home/.gemini/GEMINI.md)") != null)
      and (.permissions.allow | index("read_file(/data/home/.gemini/antigravity-cli/settings.json)") != null)
      and (.permissions.allow | index("write_file(/data/home/.gemini/antigravity-cli/settings.json)") != null)
      and (.permissions.ask | index("command(*)") != null)
      and (.permissions.ask | index("mcp(home-assistant/*)") != null)
      and (.permissions.ask | index("mcp(playwright/browser_click)") != null)
      and (.permissions.deny | index("command(sudo)") != null)
      and (.permissions.deny | index("read_file(/config/secrets.yaml)") != null)
      and (.permissions.deny | index("read_file(/data)") == null)
      and (.permissions.deny | index("write_file(/data)") == null)
      and (has("browser_approval_policy") | not)
      and (has("antigravity_token") | not)
      and (has("home_assistant_browser_token") | not))
    and (([
      $settings.permissions.allow[],
      $settings.permissions.ask[],
      $settings.permissions.deny[]
    ] | sort) == ($state.managed.settings.permission_rules | sort))
  ' \
    /data/home/.gemini/antigravity-cli/settings.json \
    /data/antigravity-ha/migration/native-files-state.json >/dev/null \
    || fail 'legacy options were not conservatively mapped into fresh native settings'
  container_exec "${MAPPING_V2_CONTAINER}" cmp --silent \
    /etc/antigravity/mcp_config.json \
    /data/home/.gemini/config/mcp_config.json \
    || fail 'fresh native MCP configuration does not match the image default'
  assert_file_contract "${MAPPING_V2_CONTAINER}" \
    /data/home/.gemini/antigravity-cli/settings.json 600
  assert_file_contract "${MAPPING_V2_CONTAINER}" \
    /data/home/.gemini/config/mcp_config.json 600
  assert_file_contract "${MAPPING_V2_CONTAINER}" \
    /data/antigravity-ha/migration/native-files-state.json 600
  container_exec "${MAPPING_V2_CONTAINER}" jq --exit-status \
    --arg candidate_version "${CANDIDATE_APP_VERSION}" '
    type == "object"
    and ((keys | sort) == ["applied", "managed", "schema"])
    and .schema == 2
    and .applied == {settings:[$candidate_version],mcp:[]}
    and ((.managed | keys) == ["settings"])
    and ((.managed.settings | keys | sort) == ["keys", "permission_rules"])
    and (.managed.settings.keys | length > 0)
    and (.managed.settings.permission_rules | type == "array")
  ' /data/antigravity-ha/migration/native-files-state.json >/dev/null \
    || fail 'v2 native ownership state is invalid after legacy option mapping'
  assert_path_absent "${MAPPING_V2_CONTAINER}" \
    /data/antigravity-ha/migration/native-files.json

  container_exec "${MAPPING_V2_CONTAINER}" /bin/bash -ceu '
    for path in \
      /data/antigravity/telegram_authorized_chats.json \
      /data/antigravity/telegram_pair_info.json; do
      test ! -e "$path"
      test ! -L "$path"
    done
  ' >/dev/null || fail 'legacy Telegram source state still exists after quarantine'
  assert_private_directory "${MAPPING_V2_CONTAINER}" \
    /data/antigravity-ha/quarantine/v1-telegram
  container_exec "${MAPPING_V2_CONTAINER}" /bin/bash -ceu '
    root=/data/antigravity-ha/quarantine/v1-telegram
    mapfile -t entries < <(
      find -P "$root" -mindepth 1 -maxdepth 1 -printf "%f\n" | sort
    )
    (( ${#entries[@]} == 2 ))
    [[ ${entries[0]} == telegram_authorized_chats.json ]]
    [[ ${entries[1]} == telegram_pair_info.json ]]
  ' >/dev/null || fail 'legacy Telegram quarantine contains unexpected entries'
  assert_file_contract "${MAPPING_V2_CONTAINER}" \
    /data/antigravity-ha/quarantine/v1-telegram/telegram_authorized_chats.json 600
  assert_file_contract "${MAPPING_V2_CONTAINER}" \
    /data/antigravity-ha/quarantine/v1-telegram/telegram_pair_info.json 600
  [[ $(container_hash "${MAPPING_V2_CONTAINER}" \
    /data/antigravity-ha/quarantine/v1-telegram/telegram_authorized_chats.json) == \
    "${authorized_hash}" ]] || fail 'legacy authorized-chat quarantine changed bytes'
  [[ $(file_identity "${MAPPING_V2_CONTAINER}" \
    /data/antigravity-ha/quarantine/v1-telegram/telegram_authorized_chats.json) == \
    "${authorized_identity}" ]] \
    || fail 'legacy authorized-chat quarantine did not preserve file identity and metadata'
  [[ $(container_hash "${MAPPING_V2_CONTAINER}" \
    /data/antigravity-ha/quarantine/v1-telegram/telegram_pair_info.json) == \
    "${pair_hash}" ]] || fail 'legacy pairing quarantine changed bytes'
  [[ $(file_identity "${MAPPING_V2_CONTAINER}" \
    /data/antigravity-ha/quarantine/v1-telegram/telegram_pair_info.json) == \
    "${pair_identity}" ]] \
    || fail 'legacy pairing quarantine did not preserve file identity and metadata'
  assert_telegram_not_reused "${MAPPING_V2_CONTAINER}" "${MAPPING_CHAT_ID}"
  assert_no_canary_in_runtime_targets "${MAPPING_V2_CONTAINER}" \
    "${MAPPING_APP_TOKEN}" "${MAPPING_BROWSER_TOKEN}" "${MAPPING_BOT_TOKEN}"
  assert_managed_plugin_contract "${MAPPING_V2_CONTAINER}"
  assert_path_absent "${MAPPING_V2_CONTAINER}" \
    /data/antigravity-ha-test/legacy-mcp-executed
  for fragment in \
    'Legacy refresh_all mode was mapped to refresh_managed' \
    'Legacy antigravity_approval_policy was conservatively mapped' \
    'Legacy antigravity_sandbox_mode was conservatively mapped' \
    'Legacy browser_approval_policy was retired' \
    'Legacy antigravity_token was not imported' \
    'Legacy home_assistant_browser_token was not migrated' \
    'Legacy Telegram chat IDs were preserved' \
    'Quarantined legacy Telegram pairing and authorization state'; do
    assert_log_fragment "${MAPPING_V2_CONTAINER}" "${fragment}"
  done
  assert_logs_clean "${MAPPING_V2_CONTAINER}"
}

run_preserve_scenario() {
  local memory_result
  local settings_metadata_before
  local path
  local key_type
  declare -a preserved_paths=(
    /data/options.json
    /data/antigravity/auth.json
    /data/antigravity/config.toml
    /data/antigravity/AGENTS.md
    /data/github-cli/hosts.yml
    /data/home/.gemini/config/mcp_config.json
    /config/.antigravity-ha-public-v1-preserve
  )
  declare -a ssh_paths=(
    /data/ssh/ssh_host_ed25519_key
    /data/ssh/ssh_host_ed25519_key.pub
    /data/ssh/ssh_host_rsa_key
    /data/ssh/ssh_host_rsa_key.pub
    /data/ssh/authorized_keys
  )
  declare -A hashes_before=()
  declare -A metadata_before=()

  create_volume "${PRESERVE_DATA_VOLUME}"
  create_volume "${PRESERVE_CONFIG_VOLUME}"
  seed_v1_scenario "${PRESERVE_DATA_VOLUME}" "${PRESERVE_CONFIG_VOLUME}" \
    preserve preserve "${PRESERVE_MARKER}" "${PRESERVE_APP_TOKEN}" \
    "${PRESERVE_BROWSER_TOKEN}" "${PRESERVE_BOT_TOKEN}" "${PRESERVE_CHAT_ID}"
  start_app "${PRESERVE_V1_CONTAINER}" "${V1_IMAGE_ID}" \
    "${PRESERVE_DATA_VOLUME}" "${PRESERVE_CONFIG_VOLUME}"
  assert_path_absent "${PRESERVE_V1_CONTAINER}" \
    /data/antigravity/.user-files-update-state.json

  run_bounded docker exec --interactive \
    --env FIXTURE_MARKER="${PRESERVE_MARKER}" \
    "${PRESERVE_V1_CONTAINER}" /bin/bash -s <<'PRESERVE_FIXTURE'
set -Eeuo pipefail
umask 077
install -d -m 0700 \
  /data/github-cli \
  /data/home/.gemini/antigravity-cli \
  /data/home/.gemini/config
printf '%s\n' "${FIXTURE_MARKER}-auth" > /data/antigravity/auth.json
printf '%s\n' "${FIXTURE_MARKER}-legacy-config" > /data/antigravity/config.toml
printf '%s\n' "${FIXTURE_MARKER}-legacy-agents" > /data/antigravity/AGENTS.md
printf '%s\n' "${FIXTURE_MARKER}-github" > /data/github-cli/hosts.yml
jq --null-input --arg marker "${FIXTURE_MARKER}" '
  {
    colorScheme:"tokyo night",
    enableTerminalSandbox:true,
    toolPermission:"strict",
    user_v1_marker:$marker
  }
' > /data/home/.gemini/antigravity-cli/settings.json
jq --null-input --arg marker "${FIXTURE_MARKER}" '
  {mcpServers:{user_v1_server:{command:"/bin/false",args:[$marker]}}}
' > /data/home/.gemini/config/mcp_config.json
chmod 0600 \
  /data/antigravity/auth.json \
  /data/antigravity/config.toml \
  /data/antigravity/AGENTS.md \
  /data/github-cli/hosts.yml \
  /data/home/.gemini/antigravity-cli/settings.json \
  /data/home/.gemini/config/mcp_config.json
PRESERVE_FIXTURE
  container_exec "${PRESERVE_V1_CONTAINER}" sqlite3 \
    /data/antigravity-ha-memory/memory.sqlite3 'PRAGMA quick_check;' \
    | grep -Fxq ok || fail 'public v1.0.4 memory database is not valid'
  run_bounded docker exec --env NODE_NO_WARNINGS=1 \
    "${PRESERVE_V1_CONTAINER}" ha-memory remember \
    --subject home:household \
    --memory-type preference \
    --key user_preference.public_v1_upgrade \
    --value-json "\"${PRESERVE_MARKER}-memory\"" \
    --source-ref user-request:public-v1-upgrade-smoke >/dev/null \
    || fail 'public v1.0.4 could not create the memory canary'
  assert_ssh_contract "${PRESERVE_V1_CONTAINER}"
  for path in "${preserved_paths[@]}" "${ssh_paths[@]}"; do
    hashes_before["${path}"]=$(container_hash "${PRESERVE_V1_CONTAINER}" "${path}")
    metadata_before["${path}"]=$(file_contract "${PRESERVE_V1_CONTAINER}" "${path}")
  done
  settings_metadata_before=$(file_contract "${PRESERVE_V1_CONTAINER}" \
    /data/home/.gemini/antigravity-cli/settings.json)
  assert_logs_clean "${PRESERVE_V1_CONTAINER}"
  stop_app "${PRESERVE_V1_CONTAINER}"

  start_app "${PRESERVE_V2_CONTAINER}" "${CANDIDATE_IMAGE_ID}" \
    "${PRESERVE_DATA_VOLUME}" "${PRESERVE_CONFIG_VOLUME}"
  for path in "${preserved_paths[@]}" "${ssh_paths[@]}"; do
    [[ $(container_hash "${PRESERVE_V2_CONTAINER}" "${path}") == \
      "${hashes_before[${path}]}" ]] \
      || fail "persistent public v1 file changed during upgrade: ${path}"
    [[ $(file_contract "${PRESERVE_V2_CONTAINER}" "${path}") == \
      "${metadata_before[${path}]}" ]] \
      || fail "persistent public v1 file metadata changed during upgrade: ${path}"
  done
  [[ $(file_contract "${PRESERVE_V2_CONTAINER}" \
    /data/home/.gemini/antigravity-cli/settings.json) == \
    "${settings_metadata_before}" ]] \
    || fail 'user native settings metadata changed during upgrade'
  container_exec "${PRESERVE_V2_CONTAINER}" jq --exit-status \
    --arg marker "${PRESERVE_MARKER}" '
      ((keys | sort) == [
        "colorScheme",
        "enableTerminalSandbox",
        "toolPermission",
        "user_v1_marker"
      ])
      and .colorScheme == "tokyo night"
      and .toolPermission == "strict"
      and .enableTerminalSandbox == true
      and .user_v1_marker == $marker
    ' /data/home/.gemini/antigravity-cli/settings.json >/dev/null \
    || fail 'user native settings were not preserved semantically'
  container_exec "${PRESERVE_V2_CONTAINER}" jq --exit-status \
    --arg marker "${PRESERVE_MARKER}" '
      .mcpServers.user_v1_server.command == "/bin/false"
      and .mcpServers.user_v1_server.args == [$marker]
    ' /data/home/.gemini/config/mcp_config.json >/dev/null \
    || fail 'user native MCP configuration was not preserved semantically'
  container_exec "${PRESERVE_V2_CONTAINER}" /bin/bash -ceu '
    for path in \
      /data/antigravity-ha/migration/native-files-state.json \
      /data/antigravity-ha/migration/native-files.json; do
      test ! -e "$path"
      test ! -L "$path"
    done
  ' >/dev/null \
    || fail 'preserve mode unexpectedly claimed ownership of user native files'
  assert_ssh_contract "${PRESERVE_V2_CONTAINER}"
  assert_managed_plugin_contract "${PRESERVE_V2_CONTAINER}"
  container_exec "${PRESERVE_V2_CONTAINER}" sqlite3 \
    /data/antigravity-ha-memory/memory.sqlite3 'PRAGMA quick_check;' \
    | grep -Fxq ok || fail 'v2 memory database is not valid after upgrade'
  memory_result=$(run_bounded docker exec --env NODE_NO_WARNINGS=1 \
    "${PRESERVE_V2_CONTAINER}" \
    ha-memory search "${PRESERVE_MARKER}-memory") \
    || fail 'v2 could not search the public v1 memory store'
  jq --exit-status --arg marker "${PRESERVE_MARKER}-memory" '
    any(.results[]?.memories[]?; .value == $marker)
  ' <<< "${memory_result}" >/dev/null \
    || fail 'public v1 memory canary was not preserved through v2'
  assert_no_canary_in_runtime_targets "${PRESERVE_V2_CONTAINER}" \
    "${PRESERVE_APP_TOKEN}" "${PRESERVE_BROWSER_TOKEN}" \
    "${PRESERVE_BOT_TOKEN}"
  assert_logs_clean "${PRESERVE_V2_CONTAINER}"
  for key_type in ed25519 rsa; do
    container_exec "${PRESERVE_V2_CONTAINER}" ssh-keygen -E sha256 -lf \
      "/data/ssh/ssh_host_${key_type}_key.pub" >/dev/null \
      || fail "could not read preserved SSH ${key_type} fingerprint"
  done
}

emit_evidence() {
  local evidence
  local finished_at
  local script_sha256
  assert_candidate_source_checkout
  assert_public_v1_revision
  finished_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  script_sha256=$(sha256sum "${BASH_SOURCE[0]}" | awk '{print $1}')
  evidence=$(jq --null-input \
    --arg candidate_image_id "${CANDIDATE_IMAGE_ID}" \
    --arg candidate_revision "${EXPECTED_CANDIDATE_REVISION}" \
    --arg candidate_source_rootfs "${CANDIDATE_SOURCE_ROOTFS}" \
    --argjson candidate_verified_files "${CANDIDATE_VERIFIED_FILES}" \
    --arg finished_at "${finished_at}" \
    --arg script_sha256 "sha256:${script_sha256}" \
    --arg started_at "${STARTED_AT}" \
    --arg v1_image_id "${V1_IMAGE_ID}" \
    --arg v1_revision "${EXPECTED_V1_REVISION}" '
    {
      schema: "antigravity-ha-public-v1-upgrade/v1",
      result: "PASS",
      closure_eligible: false,
      scope: "local-linux-amd64-container-replacement",
      started_at: $started_at,
      finished_at: $finished_at,
      harness_sha256: $script_sha256,
      provenance: {
        public_v1_image_id: $v1_image_id,
        public_v1_revision: $v1_revision,
        public_v1_tag_source_files_verified: 82,
        candidate_image_id: $candidate_image_id,
        candidate_revision: $candidate_revision,
        candidate_source_rootfs_sha256: $candidate_source_rootfs,
        candidate_source_files_verified: $candidate_verified_files,
        source_worktree_clean: true,
        immutable_ids_used_for_all_runs: true,
        candidate_source_binding_verified: true
      },
      scenarios: {
        legacy_option_mapping: {
          result: "PASS",
          public_v1_refresh_all_state_and_backup: true,
          conservative_native_mapping: true,
          legacy_mcp_preserved_not_activated: true,
          legacy_telegram_quarantined_not_reused: true
        },
        user_native_preservation: {
          result: "PASS",
          settings_metadata_and_semantics_preserved: true,
          mcp_byte_preserved: true,
          memory_record_searchable: true,
          ssh_ed25519_rsa_and_authorized_key_preserved: true
        }
      },
      sanitization: {
        contains_credentials: false,
        contains_chat_or_user_ids: false,
        contains_raw_logs: false,
        contains_memory_values: false
      },
      residual: {
        actual_haos_update: "NOT_RUN",
        supervisor_option_prevalidation: "NOT_RUN",
        apparmor_enforcement: "NOT_RUN",
        live_oauth: "NOT_RUN",
        live_telegram: "NOT_RUN"
      }
    }
  ')
  assert_candidate_source_checkout
  printf '%s\n' "${evidence}"
}

main() {
  command -v docker >/dev/null 2>&1 || fail 'docker is required'
  command -v git >/dev/null 2>&1 || fail 'git is required'
  command -v jq >/dev/null 2>&1 || fail 'jq is required'
  command -v mktemp >/dev/null 2>&1 || fail 'mktemp is required'
  command -v python3 >/dev/null 2>&1 || fail 'python3 is required'
  command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'
  command -v timeout >/dev/null 2>&1 || fail 'timeout is required'

  CANDIDATE_APP_VERSION=$(read_source_app_version) \
    || fail 'could not derive the candidate App version from config.yaml'
  readonly CANDIDATE_APP_VERSION

  assert_candidate_source_checkout
  assert_public_v1_revision
  TEMPORARY_DIRECTORY=$(mktemp -d \
    /tmp/antigravity-ha-public-v1-upgrade.XXXXXXXX) \
    || fail 'could not create a private temporary directory'
  readonly TEMPORARY_DIRECTORY
  V1_IMAGE_ID=$(resolve_image_id "${V1_IMAGE}")
  CANDIDATE_IMAGE_ID=$(resolve_image_id "${CANDIDATE_IMAGE}")
  readonly V1_IMAGE_ID CANDIDATE_IMAGE_ID
  [[ $(image_label "${V1_IMAGE_ID}" io.hass.version) == 1.0.4 ]] \
    || fail 'legacy image is not Home Assistant App version 1.0.4'
  [[ $(image_label "${V1_IMAGE_ID}" org.opencontainers.image.revision) == \
    "${EXPECTED_V1_REVISION}" ]] \
    || fail 'legacy image is not bound to the requested public v1.0.4 commit'
  verify_public_v1_source_binding "${V1_IMAGE_ID}" "${EXPECTED_V1_REVISION}"
  [[ $(image_label "${CANDIDATE_IMAGE_ID}" io.hass.version) == \
    "${CANDIDATE_APP_VERSION}" ]] \
    || fail "candidate image is not Home Assistant App version ${CANDIDATE_APP_VERSION}"
  [[ $(image_label "${CANDIDATE_IMAGE_ID}" org.opencontainers.image.revision) == \
    "${EXPECTED_CANDIDATE_REVISION}" ]] \
    || fail 'candidate revision label does not match the requested source commit'
  CANDIDATE_SOURCE_ROOTFS=$(image_label "${CANDIDATE_IMAGE_ID}" \
    io.antigravity-ha.source-rootfs-sha256)
  readonly CANDIDATE_SOURCE_ROOTFS
  [[ ${CANDIDATE_SOURCE_ROOTFS} =~ ^sha256:[0-9a-f]{64}$ ]] \
    || fail 'candidate source-rootfs label is missing'
  verify_candidate_source_binding "${CANDIDATE_IMAGE_ID}" \
    "${EXPECTED_CANDIDATE_REVISION}" "${CANDIDATE_SOURCE_ROOTFS}"
  readonly CANDIDATE_VERIFIED_FILES

  run_mapping_scenario
  run_preserve_scenario
  emit_evidence
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
