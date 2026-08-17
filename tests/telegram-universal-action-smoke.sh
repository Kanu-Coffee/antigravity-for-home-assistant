#!/usr/bin/env bash
set -Eeuo pipefail

TEST_PLATFORM=${TEST_PLATFORM:-linux/amd64}
case "$TEST_PLATFORM" in
  linux/amd64) EXPECTED_HA_ARCH=amd64 ;;
  linux/arm64) EXPECTED_HA_ARCH=aarch64 ;;
  *) printf 'unsupported TEST_PLATFORM: %s\n' "$TEST_PLATFORM" >&2; exit 64 ;;
esac
HA_ARCH=${HA_ARCH:-$EXPECTED_HA_ARCH}
[[ $HA_ARCH == "$EXPECTED_HA_ARCH" ]] || exit 64
export TEST_PLATFORM HA_ARCH

SCRIPT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
IMAGE=${1:-antigravity-for-home-assistant:test}

if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  docker() {
    MSYS_NO_PATHCONV=1 command docker "$@"
  }
fi

fail() {
  printf 'telegram universal action smoke: %s\n' "$*" >&2
  exit 1
}

docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || fail "image not found: $IMAGE"

docker run --rm --platform "$TEST_PLATFORM" \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /config:rw,nosuid,nodev,noexec,mode=0755 \
  --tmpfs /run:rw,nosuid,nodev,noexec,mode=0755 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,mode=1777 \
  --volume "$SCRIPT_DIRECTORY/fixtures/telegram-universal-action-image-smoke.mjs:/test-fixtures/telegram-universal-action-image-smoke.mjs:ro" \
  --entrypoint /usr/bin/node \
  "$IMAGE" \
  /test-fixtures/telegram-universal-action-image-smoke.mjs \
  || fail 'installed universal Telegram approval path failed'
