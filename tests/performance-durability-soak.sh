#!/usr/bin/env bash
set -Eeuo pipefail

MODE=contract
IMAGE=''
EVIDENCE=''
CANDIDATE_LEAF_DIGEST=''
CANDIDATE_STAGE_DIGEST=''

usage() {
  cat >&2 <<'USAGE'
Usage:
  performance-durability-soak.sh [--mode contract] [--evidence PATH]
  performance-durability-soak.sh --mode release --image IMAGE \
    --candidate-stage-digest SHA256 --candidate-leaf-digest SHA256 \
    --evidence PATH

contract is a shortened local fixture and cannot close GAP-007. release fixes
the soak at 30 minutes, simultaneous outage at 15 minutes, and candidate
container restarts at 20; those thresholds cannot be overridden.
USAGE
}

while (( $# > 0 )); do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || { usage; exit 64; }
      MODE=$2
      shift 2
      ;;
    --image)
      [[ $# -ge 2 ]] || { usage; exit 64; }
      IMAGE=$2
      shift 2
      ;;
    --evidence)
      [[ $# -ge 2 ]] || { usage; exit 64; }
      EVIDENCE=$2
      shift 2
      ;;
    --candidate-leaf-digest)
      [[ $# -ge 2 ]] || { usage; exit 64; }
      CANDIDATE_LEAF_DIGEST=$2
      shift 2
      ;;
    --candidate-stage-digest)
      [[ $# -ge 2 ]] || { usage; exit 64; }
      CANDIDATE_STAGE_DIGEST=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 64
      ;;
  esac
done

[[ $MODE == contract || $MODE == release ]] || { usage; exit 64; }
if [[ $MODE == release && -n $EVIDENCE ]]; then
  rm -f -- "$EVIDENCE"
fi
while IFS= read -r variable_name; do
  case "$variable_name" in
    GAP007_DURATION*|GAP007_OUTAGE*|GAP007_RESTART*|GAP007_SOAK*|GAP007_THRESHOLD*)
      echo 'GAP-007 duration and threshold environment overrides are forbidden' >&2
      exit 64
      ;;
  esac
done < <(compgen -A variable GAP007_ || true)

ROOT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
HARNESS=${ROOT_DIRECTORY}/tests/performance-durability-soak.mjs
MANIFEST_TOOL=${ROOT_DIRECTORY}/.github/scripts/source-rootfs-manifest.py
EVIDENCE_CONTRACT=${ROOT_DIRECTORY}/.github/scripts/gap007_evidence_contract.py
PERFORMANCE_BUDGET=${ROOT_DIRECTORY}/docs/v2/performance-budget.json
SOURCE_ROOTFS=${ROOT_DIRECTORY}/antigravity_home_assistant/rootfs
[[ -f $HARNESS ]] || { echo 'GAP-007 Node harness is missing' >&2; exit 1; }

if [[ $MODE == contract ]]; then
  [[ -z $IMAGE ]] || { echo '--image is accepted only in release mode' >&2; exit 64; }
  [[ -z $CANDIDATE_LEAF_DIGEST && -z $CANDIDATE_STAGE_DIGEST ]] \
    || { echo 'candidate digests are accepted only in release mode' >&2; exit 64; }
  CONTRACT_EVIDENCE=$EVIDENCE
  CONTRACT_EVIDENCE_TEMPORARY=false
  if [[ -z $CONTRACT_EVIDENCE ]]; then
    CONTRACT_EVIDENCE=$(mktemp)
    CONTRACT_EVIDENCE_TEMPORARY=true
  fi
  trap '
    if [[ $CONTRACT_EVIDENCE_TEMPORARY == true ]]; then
      rm -f -- "$CONTRACT_EVIDENCE"
    fi
  ' EXIT
  node "$HARNESS" \
    --mode contract \
    --evidence "$CONTRACT_EVIDENCE" >/dev/null
  cat -- "$CONTRACT_EVIDENCE"
  exit 0
fi

[[ -n $IMAGE && -n $EVIDENCE \
  && $CANDIDATE_LEAF_DIGEST =~ ^sha256:[0-9a-f]{64}$ \
  && $CANDIDATE_STAGE_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] \
  || { usage; exit 64; }
command -v docker >/dev/null 2>&1 || { echo 'docker is required for release mode' >&2; exit 1; }
docker buildx version >/dev/null 2>&1 \
  || { echo 'Docker Buildx is required for stable OCI image-size measurement' >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo 'jq is required for release mode' >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo 'python3 is required for release mode' >&2; exit 1; }
command -v timeout >/dev/null 2>&1 || { echo 'GNU timeout is required for release mode' >&2; exit 1; }
for required_file in "$MANIFEST_TOOL" "$EVIDENCE_CONTRACT" "$PERFORMANCE_BUDGET"; do
  [[ -f $required_file ]] || { echo 'GAP-007 release contract input is missing' >&2; exit 1; }
done
docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || { echo 'candidate image is not available locally' >&2; exit 1; }

IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE")
IMAGE_ARCHITECTURE=$(docker image inspect --format '{{.Architecture}}' "$IMAGE")
IMAGE_REVISION=$(docker image inspect --format \
  '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")
IMAGE_SOURCE_ROOTFS=$(docker image inspect --format \
  '{{index .Config.Labels "io.antigravity-ha.source-rootfs-sha256"}}' "$IMAGE")
mapfile -t IMAGE_REPOSITORY_DIGESTS < <(docker image inspect --format \
  '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE")
[[ $IMAGE_ID =~ ^sha256:[0-9a-f]{64}$ ]] \
  || { echo 'candidate image has no immutable sha256 image ID' >&2; exit 1; }
[[ $IMAGE_ARCHITECTURE =~ ^(amd64|arm64)$ ]] \
  || { echo 'candidate image architecture is unsupported' >&2; exit 1; }
IMAGE_REPOSITORY=${IMAGE%@*}
[[ $IMAGE_REPOSITORY != "$IMAGE" && -n $IMAGE_REPOSITORY ]] \
  || { echo 'candidate image must use an exact registry digest' >&2; exit 1; }
STAGE_DIGEST_BOUND=false
for repository_digest in "${IMAGE_REPOSITORY_DIGESTS[@]}"; do
  if [[ $repository_digest == *@"$CANDIDATE_STAGE_DIGEST" ]]; then
    STAGE_DIGEST_BOUND=true
    break
  fi
done
[[ $STAGE_DIGEST_BOUND == true ]] \
  || { echo 'candidate image is not bound to the exact amd64 staging digest' >&2; exit 1; }

TEST_ID="antigravity-gap007-${RANDOM}-$$"
CONTAINER="${TEST_ID}-candidate"
DATA_VOLUME="${TEST_ID}-data"
CONFIG_VOLUME="${TEST_ID}-config"
WORK_DIRECTORY=$(mktemp -d)
COMPONENT_EVIDENCE=${WORK_DIRECTORY}/component-evidence.json
STATS_BEFORE=${WORK_DIRECTORY}/stats-before.json
STATS_AFTER_SOAK=${WORK_DIRECTORY}/stats-after-soak.json
STATS_AFTER_RESTARTS=${WORK_DIRECTORY}/stats-after-restarts.json
IMAGE_SOURCE_MANIFEST=${WORK_DIRECTORY}/source-rootfs-manifest.json
IMAGE_VERIFICATION=${WORK_DIRECTORY}/source-image-verification.json
RUNTIME_MANIFEST=${WORK_DIRECTORY}/runtime-manifest.json
COMPONENT_STDOUT=${WORK_DIRECTORY}/component-stdout.log
COMPONENT_STDERR=${WORK_DIRECTORY}/component-stderr.log
RESTART_DURATIONS='[]'

docker buildx imagetools inspect --raw \
  "${IMAGE_REPOSITORY}@${CANDIDATE_LEAF_DIGEST}" > "$RUNTIME_MANIFEST" \
  || { echo 'could not read the exact runtime leaf manifest' >&2; exit 1; }
[[ sha256:$(sha256sum "$RUNTIME_MANIFEST" | cut -d ' ' -f 1) == \
  "$CANDIDATE_LEAF_DIGEST" ]] \
  || { echo 'runtime leaf manifest digest differs from the candidate binding' >&2; exit 1; }
IMAGE_SIZE_BYTES=$(jq --exit-status --raw-output '
  select(.mediaType == "application/vnd.oci.image.manifest.v1+json")
  | select(.config.size | type == "number" and . > 0)
  | select(.layers | type == "array" and length > 0)
  | select(all(.layers[]; .size | type == "number" and . > 0))
  | [.config.size, (.layers[].size)] | add
' "$RUNTIME_MANIFEST") \
  || { echo 'runtime leaf manifest has invalid size descriptors' >&2; exit 1; }
[[ $IMAGE_SIZE_BYTES =~ ^[1-9][0-9]*$ ]] \
  || { echo 'candidate OCI compressed image size is invalid' >&2; exit 1; }

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm -f "$DATA_VOLUME" "$CONFIG_VOLUME" >/dev/null 2>&1 || true
  rm -rf -- "$WORK_DIRECTORY"
}
trap cleanup EXIT

fail() {
  local reason=$*
  local failure_temporary=${EVIDENCE}.failure-${RANDOM}-$$
  mkdir -p -- "$(dirname -- "$EVIDENCE")"
  jq --null-input \
    --arg reason "$reason" \
    --arg image_id "${IMAGE_ID:-}" \
    --arg revision "${IMAGE_REVISION:-}" \
    '{
      schema_version: 1,
      requirement_id: "GAP-007",
      mode: "release",
      result: "FAIL",
      closure_eligible: false,
      provenance: {
        candidate_image_id: (if $image_id == "" then null else $image_id end),
        candidate_revision: (if $revision == "" then null else $revision end)
      },
      failure: {reason: $reason},
      sanitization: {
        external_calls: 0,
        contains_credentials: false,
        contains_entity_or_chat_identifiers: false,
        contains_raw_logs_or_prompts: false
      }
    }' > "$failure_temporary" || true
  if [[ -s $failure_temporary ]]; then
    chmod 0600 "$failure_temporary"
    mv -f -- "$failure_temporary" "$EVIDENCE"
  else
    rm -f -- "$failure_temporary"
  fi
  printf 'GAP-007 release harness: %s\n' "$reason" >&2
  exit 1
}

runtime_is_ready() {
  docker exec "$CONTAINER" /bin/bash -ceu '
    test -S /run/antigravity-ha/change-broker.sock
    test -S /run/antigravity-ha/ha-read.sock
    test -s /data/antigravity-ha-memory/memory.sqlite3
    test ! -e /data/antigravity-ha/migration/native-files.json
    test ! -e /data/antigravity-ha/migration/managed-plugin.json
    test ! -e /data/antigravity/.native-files-update-journal.json
    test ! -e /data/antigravity/.user-files-update-journal.json
    test ! -e /run/antigravity-ha/telegram-pairing.lock
    [[ "$(sqlite3 /data/antigravity-ha-memory/memory.sqlite3 "PRAGMA quick_check;")" == ok ]]
    ! ps -eo stat= | grep -Eq "^[[:space:]]*Z"
  ' >/dev/null 2>&1
}

wait_for_ready() {
  local started_at=$1
  local attempt
  for ((attempt = 0; attempt < 120; attempt += 1)); do
    if [[ $(docker inspect --format '{{.State.Running}}' "$CONTAINER") != true ]]; then
      fail 'candidate exited before readiness'
    fi
    if docker logs --since "$started_at" "$CONTAINER" 2>&1 \
      | grep -Fq 'antigravity runtime ready:' \
      && runtime_is_ready; then
      return 0
    fi
    sleep 1
  done
  fail 'candidate did not reach runtime/socket/migration readiness'
}

capture_stats() {
  local output=$1
  docker stats --no-stream --format '{{json .}}' "$CONTAINER" \
    | jq '{
        cpu_percent: .CPUPerc,
        memory_percent: .MemPerc,
        memory_usage: .MemUsage,
        process_count: (.PIDs | tonumber)
      }' > "$output"
}

verify_image_rootfs() {
  docker exec "$CONTAINER" /bin/bash -ceu '
    manifest=/usr/local/share/antigravity-ha/source-rootfs-manifest.json
    test -s "$manifest"
    aggregate="sha256:$(jq --ascii-output --compact-output --sort-keys ".files" "$manifest" \
      | tr -d "\n" | sha256sum | awk "{print \$1}")"
    test "$aggregate" = "$(jq --raw-output .source_rootfs_sha256 "$manifest")"
    while IFS= read -r encoded; do
      item=$(printf "%s" "$encoded" | base64 --decode)
      path=$(jq --raw-output .path <<< "$item")
      expected_mode=$(jq --raw-output .mode <<< "$item")
      expected_size=$(jq --raw-output .size <<< "$item")
      expected_sha256=$(jq --raw-output .sha256 <<< "$item")
      test -f "$path"
      test ! -L "$path"
      test "$(stat -c %u:%g "$path")" = "0:0"
      raw_mode=$(stat -c %a "$path")
      if (( (8#$raw_mode & 8#111) != 0 )); then actual_mode=0755; else actual_mode=0644; fi
      test "$actual_mode" = "$expected_mode"
      test "$(stat -c %s "$path")" = "$expected_size"
      test "sha256:$(sha256sum "$path" | awk "{print \$1}")" = "$expected_sha256"
    done < <(jq --raw-output ".files[] | @base64" "$manifest")
  ' >/dev/null
}

container_memory_bytes() {
  docker exec "$CONTAINER" /bin/bash -ceu 'cat /sys/fs/cgroup/memory.current'
}

container_cpu_usage_microseconds() {
  docker exec "$CONTAINER" /bin/bash -ceu \
    'awk '\''$1 == "usage_usec" { print $2 }'\'' /sys/fs/cgroup/cpu.stat'
}

SOURCE_STATUS_BEFORE=$(git -C "$ROOT_DIRECTORY" status --porcelain=v1 --untracked-files=all)
[[ -z $SOURCE_STATUS_BEFORE ]] \
  || fail 'release evidence requires a clean committed repository worktree'
SOURCE_REVISION_BEFORE=$(git -C "$ROOT_DIRECTORY" rev-parse HEAD)
docker run --rm --network none --entrypoint /bin/cat "$IMAGE" \
  /usr/local/share/antigravity-ha/source-rootfs-manifest.json \
  > "$IMAGE_SOURCE_MANIFEST" \
  || fail 'candidate source-rootfs manifest is missing'
SOURCE_ROOTFS_BEFORE=$(python3 "$MANIFEST_TOOL" verify \
  --root "$SOURCE_ROOTFS" \
  --manifest "$IMAGE_SOURCE_MANIFEST") \
  || fail 'candidate source-rootfs does not match current source'
python3 "$EVIDENCE_CONTRACT" candidate \
  --image-id "$IMAGE_ID" \
  --revision "$IMAGE_REVISION" \
  --source-rootfs-sha256 "$IMAGE_SOURCE_ROOTFS" \
  --expected-revision "$SOURCE_REVISION_BEFORE" \
  --expected-source-rootfs-sha256 "$SOURCE_ROOTFS_BEFORE" \
  || fail 'candidate provenance binding is invalid'
python3 "$MANIFEST_TOOL" verify-image \
  --image "$IMAGE" \
  --expected-revision "$SOURCE_REVISION_BEFORE" \
  --expected-source-rootfs-sha256 "$SOURCE_ROOTFS_BEFORE" \
  > "$IMAGE_VERIFICATION" \
  || fail 'candidate exported rootfs differs from its manifest/source/OCI labels'

MAX_AVERAGE_CPU_PERCENT=$(jq --exit-status --raw-output \
  '.limits.max_average_cpu_percent | select(type == "number" and . > 0)' \
  "$PERFORMANCE_BUDGET") \
  || fail 'average CPU budget is missing'
MAX_PEAK_RSS_BYTES=$(jq --exit-status --raw-output \
  '.limits.max_peak_rss_bytes | select(type == "number" and . > 0)' \
  "$PERFORMANCE_BUDGET") \
  || fail 'peak RSS budget is missing'
MAX_IMAGE_SIZE_BYTES=$(jq --exit-status --raw-output \
  '.limits.max_image_size_bytes | select(type == "number" and . > 0)' \
  "$PERFORMANCE_BUDGET") \
  || fail 'image size budget is missing'
(( IMAGE_SIZE_BYTES <= MAX_IMAGE_SIZE_BYTES )) \
  || fail "candidate image size ${IMAGE_SIZE_BYTES} exceeded its fixed budget ${MAX_IMAGE_SIZE_BYTES}"

docker volume create "$DATA_VOLUME" >/dev/null
docker volume create "$CONFIG_VOLUME" >/dev/null
docker run --rm --interactive \
  --network none \
  --entrypoint /bin/sh \
  --volume "${DATA_VOLUME}:/data" \
  "$IMAGE" -ceu '
    umask 077
    jq --null-input '\''{
      telegram_enabled: false,
      telegram_bot_token: "",
      telegram_allowed_user_ids: [],
      telegram_allowed_chat_ids: [],
      authorized_keys: [],
      web_terminal_auto_start_antigravity: false,
      tmux_session_name: "antigravity-gap007",
      antigravity_tool_permission: "request-review",
      antigravity_terminal_sandbox: true,
      antigravity_user_files_update_mode: "preserve",
      home_assistant_browser_auto_auth: false,
      log_level: "info"
    }'\'' > /data/options.json
  '

OVERALL_STARTED_AT_UTC=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
OVERALL_STARTED_NS=$(date +%s%N)
docker run --detach \
  --name "$CONTAINER" \
  --network none \
  --env SUPERVISOR_TOKEN=GAP007_LOCAL_FIXTURE_TOKEN \
  --volume "${DATA_VOLUME}:/data" \
  --volume "${CONFIG_VOLUME}:/config" \
  "$IMAGE" >/dev/null
STARTED_AT=$(docker inspect --format '{{.State.StartedAt}}' "$CONTAINER")
wait_for_ready "$STARTED_AT"
verify_image_rootfs || fail 'candidate installed rootfs differs from its source manifest'
capture_stats "$STATS_BEFORE"
STATE_HASH_BEFORE=$(docker exec "$CONTAINER" sha256sum \
  /data/antigravity-ha/migration/native-files-state.json | awk '{print $1}')
[[ $STATE_HASH_BEFORE =~ ^[0-9a-f]{64}$ ]] || fail 'migration state hash is invalid'

PACKAGED_WORKLOAD_ROOT=/tmp/antigravity-gap007-workload
PACKAGED_HARNESS=${PACKAGED_WORKLOAD_ROOT}/tests/performance-durability-soak.mjs
PACKAGED_EVIDENCE=${PACKAGED_WORKLOAD_ROOT}/component-evidence.json
docker exec "$CONTAINER" /bin/bash -ceu \
  'install -d -m 0700 \
    /tmp/antigravity-gap007-workload/tests \
    /tmp/antigravity-gap007-workload/antigravity_home_assistant/rootfs/usr/local/share
  ln -s /usr/local/share/antigravity-ha \
    /tmp/antigravity-gap007-workload/antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha'
docker cp "$HARNESS" "${CONTAINER}:${PACKAGED_HARNESS}"
docker exec "$CONTAINER" chmod 0600 "$PACKAGED_HARNESS"

WORKLOAD_STARTED_NS=$(date +%s%N)
CPU_USAGE_BEFORE=$(container_cpu_usage_microseconds)
PEAK_RSS_BYTES=$(container_memory_bytes)
timeout --foreground --signal=TERM --kill-after=30s 40m \
  docker exec "$CONTAINER" node "$PACKAGED_HARNESS" \
  --mode release \
  --candidate-image-id "$IMAGE_ID" \
  --candidate-leaf-digest "$CANDIDATE_LEAF_DIGEST" \
  --candidate-stage-digest "$CANDIDATE_STAGE_DIGEST" \
  --source-revision "$SOURCE_REVISION_BEFORE" \
  --source-rootfs-sha256 "$SOURCE_ROOTFS_BEFORE" \
  --execution-scope packaged_image \
  --evidence "$PACKAGED_EVIDENCE" \
  > "$COMPONENT_STDOUT" 2> "$COMPONENT_STDERR" &
COMPONENT_PID=$!
while kill -0 "$COMPONENT_PID" 2>/dev/null; do
  current_rss=$(container_memory_bytes)
  if (( current_rss > PEAK_RSS_BYTES )); then
    PEAK_RSS_BYTES=$current_rss
  fi
  sleep 5
done
COMPONENT_STATUS=0
wait "$COMPONENT_PID" || COMPONENT_STATUS=$?
if (( COMPONENT_STATUS == 124 || COMPONENT_STATUS == 137 )); then
  fail 'packaged GAP-007 component exceeded the fixed 40-minute wall-clock limit'
fi
(( COMPONENT_STATUS == 0 )) \
  || fail 'packaged 30-minute soak or 15-minute simultaneous outage failed'
current_rss=$(container_memory_bytes)
if (( current_rss > PEAK_RSS_BYTES )); then
  PEAK_RSS_BYTES=$current_rss
fi
CPU_USAGE_AFTER=$(container_cpu_usage_microseconds)
WORKLOAD_FINISHED_NS=$(date +%s%N)
WORKLOAD_ELAPSED_SECONDS=$(jq --null-input \
  --argjson start "$WORKLOAD_STARTED_NS" \
  --argjson finish "$WORKLOAD_FINISHED_NS" \
  '($finish - $start) / 1000000000')
AVERAGE_CPU_PERCENT=$(jq --null-input \
  --argjson before "$CPU_USAGE_BEFORE" \
  --argjson after "$CPU_USAGE_AFTER" \
  --argjson elapsed "$WORKLOAD_ELAPSED_SECONDS" \
  '((((($after - $before) / 1000000) / $elapsed) * 100) * 1000 | round) / 1000')
jq --exit-status --null-input \
  --argjson observed "$AVERAGE_CPU_PERCENT" \
  --argjson maximum "$MAX_AVERAGE_CPU_PERCENT" \
  '$observed <= $maximum' >/dev/null \
  || fail 'candidate average CPU exceeded its fixed budget'
(( PEAK_RSS_BYTES <= MAX_PEAK_RSS_BYTES )) \
  || fail 'candidate peak RSS exceeded its fixed budget'
docker cp "${CONTAINER}:${PACKAGED_EVIDENCE}" "$COMPONENT_EVIDENCE"
python3 "$EVIDENCE_CONTRACT" component \
  --evidence "$COMPONENT_EVIDENCE" \
  --image-id "$IMAGE_ID" \
  --candidate-leaf-digest "$CANDIDATE_LEAF_DIGEST" \
  --candidate-stage-digest "$CANDIDATE_STAGE_DIGEST" \
  --revision "$SOURCE_REVISION_BEFORE" \
  --source-rootfs-sha256 "$SOURCE_ROOTFS_BEFORE" \
  || fail 'component evidence did not satisfy the packaged release contract'
capture_stats "$STATS_AFTER_SOAK"

for ((restart_index = 1; restart_index <= 20; restart_index += 1)); do
  restart_started_ns=$(date +%s%N)
  docker restart --time 10 "$CONTAINER" >/dev/null \
    || fail "candidate restart ${restart_index} failed"
  STARTED_AT=$(docker inspect --format '{{.State.StartedAt}}' "$CONTAINER")
  wait_for_ready "$STARTED_AT"
  restart_finished_ns=$(date +%s%N)
  restart_milliseconds=$(((restart_finished_ns - restart_started_ns) / 1000000))
  RESTART_DURATIONS=$(jq --compact-output \
    --argjson value "$restart_milliseconds" '. + [$value]' \
    <<< "$RESTART_DURATIONS")
done

capture_stats "$STATS_AFTER_RESTARTS"
STATE_HASH_AFTER=$(docker exec "$CONTAINER" sha256sum \
  /data/antigravity-ha/migration/native-files-state.json | awk '{print $1}')
[[ $STATE_HASH_AFTER == "$STATE_HASH_BEFORE" ]] \
  || fail 'migration ownership state changed across rapid restarts'
[[ $(docker image inspect --format '{{.Id}}' "$IMAGE") == "$IMAGE_ID" ]] \
  || fail 'candidate image ID changed during the release run'
verify_image_rootfs || fail 'candidate rootfs changed across rapid restarts'
SOURCE_REVISION_AFTER=$(git -C "$ROOT_DIRECTORY" rev-parse HEAD)
SOURCE_STATUS_AFTER=$(git -C "$ROOT_DIRECTORY" status --porcelain=v1 --untracked-files=all)
[[ -z $SOURCE_STATUS_AFTER ]] \
  || fail 'repository worktree changed during the release run'
SOURCE_ROOTFS_AFTER=$(python3 "$MANIFEST_TOOL" verify \
  --root "$SOURCE_ROOTFS" \
  --manifest "$IMAGE_SOURCE_MANIFEST") \
  || fail 'current source-rootfs changed during the release run'
[[ $SOURCE_REVISION_AFTER == "$SOURCE_REVISION_BEFORE" ]] \
  || fail 'source revision changed during the release run'
[[ $SOURCE_ROOTFS_AFTER == "$SOURCE_ROOTFS_BEFORE" ]] \
  || fail 'source-rootfs digest changed during the release run'

OVERALL_FINISHED_AT_UTC=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
OVERALL_FINISHED_NS=$(date +%s%N)
OVERALL_ELAPSED_SECONDS=$(jq --null-input \
  --argjson start "$OVERALL_STARTED_NS" \
  --argjson finish "$OVERALL_FINISHED_NS" \
  '((($finish - $start) / 1000000000) * 1000 | round) / 1000')
EVIDENCE_DIRECTORY=$(dirname -- "$EVIDENCE")
mkdir -p -- "$EVIDENCE_DIRECTORY"
EVIDENCE_TEMPORARY="${EVIDENCE}.tmp-${RANDOM}-$$"

jq \
  --arg started "$OVERALL_STARTED_AT_UTC" \
  --arg finished "$OVERALL_FINISHED_AT_UTC" \
  --arg image_id "$IMAGE_ID" \
  --arg stage_digest "$CANDIDATE_STAGE_DIGEST" \
  --arg architecture "$IMAGE_ARCHITECTURE" \
  --arg revision "$IMAGE_REVISION" \
  --arg source_rootfs "$SOURCE_ROOTFS_AFTER" \
  --arg state_hash "sha256:${STATE_HASH_AFTER}" \
  --argjson elapsed "$OVERALL_ELAPSED_SECONDS" \
  --argjson image_size "$IMAGE_SIZE_BYTES" \
  --argjson average_cpu_percent "$AVERAGE_CPU_PERCENT" \
  --argjson peak_rss_bytes "$PEAK_RSS_BYTES" \
  --argjson restart_durations "$RESTART_DURATIONS" \
  --slurpfile budget "$PERFORMANCE_BUDGET" \
  --slurpfile source_image_verification "$IMAGE_VERIFICATION" \
  --slurpfile stats_before "$STATS_BEFORE" \
  --slurpfile stats_after_soak "$STATS_AFTER_SOAK" \
  --slurpfile stats_after_restarts "$STATS_AFTER_RESTARTS" '
    .scope = "local_candidate_release_fixture"
    | .closure_eligible = true
    | .started_at_utc = $started
    | .finished_at_utc = $finished
    | .actual_elapsed_seconds = $elapsed
    | .provenance.candidate_image_id = $image_id
    | .provenance.candidate_stage_digest = $stage_digest
    | .provenance.candidate_architecture = $architecture
    | .provenance.candidate_revision = $revision
    | .provenance.git_commit = $revision
    | .provenance.source_tree_sha256 = $source_rootfs
    | .provenance.source_rootfs_sha256 = $source_rootfs
    | .provenance.source_tree_stable = true
    | .provenance.source_image_verification = $source_image_verification[0]
    | .rapid_restart.candidate_container = {
        required_count: 20,
        completed_count: ($restart_durations | length),
        durations_milliseconds: $restart_durations,
        migration_state_sha256: $state_hash,
        stale_socket_count: 0,
        pending_journal_count: 0,
        zombie_process_count: 0,
        result: "PASS"
      }
    | .resources.candidate = {
        image_size_bytes: $image_size,
        idle_before: $stats_before[0],
        after_soak: $stats_after_soak[0],
        after_restarts: $stats_after_restarts[0],
        budget_status: "PASS"
      }
    | .resources.budget_status = "PASS"
    | .resources.candidate_budget = {
        baseline_evidence_sha256: $budget[0].baseline_evidence_sha256,
        limits: $budget[0].limits,
        observed: {
          average_cpu_percent: $average_cpu_percent,
          peak_rss_bytes: $peak_rss_bytes,
          image_size_bytes: $image_size
        },
        result: "PASS"
      }
    | .remaining_gap = "local GAP-007 complete; HAOS-specific gates remain separate"
  ' "$COMPONENT_EVIDENCE" > "$EVIDENCE_TEMPORARY"

python3 "$EVIDENCE_CONTRACT" final \
  --evidence "$EVIDENCE_TEMPORARY" \
  --image-id "$IMAGE_ID" \
  --candidate-leaf-digest "$CANDIDATE_LEAF_DIGEST" \
  --candidate-stage-digest "$CANDIDATE_STAGE_DIGEST" \
  --revision "$SOURCE_REVISION_AFTER" \
  --source-rootfs-sha256 "$SOURCE_ROOTFS_AFTER" \
  --budget "$PERFORMANCE_BUDGET" \
  || fail 'final sanitized evidence did not satisfy the release contract'
chmod 0600 "$EVIDENCE_TEMPORARY"
mv -f -- "$EVIDENCE_TEMPORARY" "$EVIDENCE"
cat -- "$EVIDENCE"
