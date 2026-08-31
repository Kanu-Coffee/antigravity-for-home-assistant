#!/usr/bin/env bash
set -Eeuo pipefail

readonly TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}
readonly IMAGE=${1:-antigravity-for-home-assistant:test}
readonly TEST_ID="antigravity-ha-remote-serialization-${RANDOM}-${RANDOM}-$$"
readonly APP_CONTAINER=${TEST_ID}-app
readonly FIXTURE=${PWD}/tests/fixtures/fake-remote-control-agy

cleanup() {
  docker rm -f "${APP_CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf 'remote login serialization smoke: %s\n' "$*" >&2
  exit 1
}

run_bounded() {
  timeout --foreground --signal=TERM --kill-after=5s 30s "$@"
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
[[ -x ${FIXTURE} ]] || fail "fixture is missing or not executable: ${FIXTURE}"

docker run -d --rm \
  --platform "${TEST_PLATFORM}" \
  --name "${APP_CONTAINER}" \
  --entrypoint /bin/sleep \
  --mount "type=bind,src=${FIXTURE},dst=/usr/local/bin/agy,readonly" \
  "${IMAGE}" infinity >/dev/null \
  || fail 'failed to start isolated fixture container'

docker exec "${APP_CONTAINER}" install -d -m 0700 \
  /config /data/home /data/home/.gemini /run/antigravity-ha \
  || fail 'failed to prepare isolated Remote directories'
docker exec -d "${APP_CONTAINER}" \
  /usr/local/libexec/ha-antigravity-remote-runtime \
  || fail 'failed to start background Remote runtime'

set +e
run_bounded docker exec -t "${APP_CONTAINER}" \
  /usr/local/bin/ha-antigravity-remote-login >/dev/null 2>&1
login_status=$?
set -e
[[ ${login_status} -eq 0 ]] || fail "interactive login fixture exited ${login_status}"

for ((attempt = 0; attempt < 10; attempt += 1)); do
  if docker exec "${APP_CONTAINER}" \
      test -e /run/antigravity-ha/fake-remote-service-started; then
    break
  fi
  sleep 1
done
docker exec "${APP_CONTAINER}" \
  test -e /run/antigravity-ha/fake-remote-service-started \
  || fail 'background Remote did not start after login completed'
docker exec "${APP_CONTAINER}" \
  test -e /run/antigravity-ha/fake-remote-service-name-valid \
  || fail 'background Remote did not receive the configured instance name'
docker exec "${APP_CONTAINER}" \
  test ! -e /run/antigravity-ha/fake-remote-login-name-argument \
  || fail 'transient login Remote reused the persistent instance name'
docker exec "${APP_CONTAINER}" \
  test ! -e /run/antigravity-ha/fake-remote-overlap-detected \
  || fail 'interactive and background Remote processes overlapped'

printf '%s\n' 'remote login serialization smoke passed'
