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

SCRIPT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
IMAGE=${1:-antigravity-for-home-assistant:test}
EXPECTED_VERSION=$(sed -n \
  's/^ARG ANTIGRAVITY_VERSION=//p' antigravity_home_assistant/Dockerfile)

fail() {
  printf 'telegram action native valid control: %s\n' "$*" >&2
  exit 1
}

docker image inspect "${IMAGE}" >/dev/null 2>&1 \
  || fail "image not found: ${IMAGE}"
[[ "${EXPECTED_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail 'Dockerfile Antigravity version pin is invalid'

docker run --rm --platform "$TEST_PLATFORM" --network none \
  --tmpfs /config:rw,nosuid,nodev,noexec,mode=0755 \
  --tmpfs /data:rw,nosuid,nodev,noexec,mode=0755 \
  --tmpfs /run:rw,nosuid,nodev,noexec,mode=0755 \
  --env EXPECTED_VERSION="${EXPECTED_VERSION}" \
  --volume \
    "$SCRIPT_DIRECTORY/fixtures/telegram-action-native-valid-control.mjs:/test-fixtures/telegram-action-native-valid-control.mjs:ro" \
  --entrypoint /usr/bin/timeout \
  "${IMAGE}" 60s /usr/bin/node \
    /test-fixtures/telegram-action-native-valid-control.mjs \
  || fail 'native telegram_action valid control failed'
