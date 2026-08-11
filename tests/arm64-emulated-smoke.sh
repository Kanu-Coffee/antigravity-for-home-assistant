#!/usr/bin/env bash
set -Eeuo pipefail

if (( $# != 1 )); then
  echo 'Usage: arm64-emulated-smoke.sh <local-image>' >&2
  exit 64
fi

readonly IMAGE=$1
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "Missing local image: ${IMAGE}" >&2
  exit 1
fi

if [[ "$(docker image inspect --format '{{.Architecture}}' "${IMAGE}")" != arm64 ]]; then
  echo "Expected an arm64 image: ${IMAGE}" >&2
  exit 1
fi

docker run --rm --platform linux/arm64 \
  --entrypoint /bin/bash \
  "${IMAGE}" -ceu '
    [[ "$(uname -m)" == aarch64 ]]
    [[ "${AGY_CLI_DISABLE_AUTO_UPDATE:-}" == true ]]
    [[ "$(/usr/local/libexec/antigravity-real --version)" == 1.1.11 ]]
    [[ "$(node --version)" == v22.23.2 ]]
    gh --version | grep -Fq "gh version 2.93.0 "
    ttyd --version 2>&1 | grep -Fq "ttyd version 1.7.7"
    chromium --version | grep -Fq Chromium
    node -e "const { DatabaseSync } = require(\"node:sqlite\"); const db = new DatabaseSync(\":memory:\"); db.close()"
    node --check /usr/local/share/antigravity-ha/ha-read-broker.mjs
    node --check /usr/local/share/antigravity-ha/ha-validate-mcp.mjs
    node --check /usr/local/share/antigravity-ha/ha-memory-ha-client.mjs
    test -x /usr/local/bin/antigravity
    test -x /usr/local/bin/ha-read-broker
    test -x /usr/local/bin/ha-validate-mcp
    test -x /usr/local/libexec/antigravity-interactive-restricted
    test -x /usr/local/libexec/antigravity-interactive-sensitive-read
    test -f /usr/local/share/antigravity-ha/plugins/home-assistant/plugin.json
    test -f /etc/antigravity/settings.json
    test -f /etc/antigravity/mcp_config.json
    jq --exit-status '\''
      .mcpServers.ha_read.command == "/usr/local/bin/ha-read-mcp"
      and .mcpServers.ha_validate.command == "/usr/local/bin/ha-validate-mcp"
    '\'' /usr/local/share/antigravity-ha/plugins/home-assistant/mcp_config.json >/dev/null
  '

printf 'arm64 emulated packaging smoke passed for %s\n' "${IMAGE}"
