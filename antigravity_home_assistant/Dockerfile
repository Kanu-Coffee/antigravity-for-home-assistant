# syntax=docker/dockerfile:1.7
ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:bookworm@sha256:8c7a9e207425e79b6b2ed1628a2b6727fa6e518d9fdddcbe3b1ac20440e70492
FROM ${BUILD_FROM}

ARG DEBIAN_SNAPSHOT=20260812T000000Z
ARG BUILD_ARCH=amd64
ARG BUILD_VERSION=2.0.9
ARG SOURCE_REVISION=""
ARG SOURCE_ROOTFS_SHA256=""
ARG TARGETARCH
ARG ANTIGRAVITY_VERSION=1.1.13
ARG ANTIGRAVITY_BUILD=6057583128215552
ARG ANTIGRAVITY_AMD64_SHA512=89c6881b6c1999cb8236e7181c2192ae8f372b0413396c0f7bcff83d27ac9c0cc1202795cc0d629ec1ecbf4937d1c294cf4f5e4f9f8e05b1e972e27198313442
ARG ANTIGRAVITY_ARM64_SHA512=d2f3642873e3283265ebf4d4e2cc8c3652dff5a0b193a33ebfe0dded68521dd02b4c28ed92ff54784f6a6267e95c807b4d8194e8a6d619d4348638ab5c810d44
ARG NODE_VERSION=22.23.2
ARG NODE_AMD64_SHA256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
ARG NODE_ARM64_SHA256=fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8
ARG GH_VERSION=2.93.0
ARG GH_AMD64_SHA256=02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0
ARG GH_ARM64_SHA256=c55feb33684abba57e9909737340d5b39282257c0363e1edde6785ac4a413be7
ARG TTYD_VERSION=1.7.7
ARG TTYD_AMD64_SHA256=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_ARM64_SHA256=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165
ARG CHROMIUM_VERSION=151.0.7922.108
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
ARG WS_VERSION=8.21.3

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

COPY playwright/package.json playwright/package-lock.json /usr/local/lib/antigravity-ha/playwright/

RUN sed -i \
      -e "s|https\?://deb.debian.org/debian-security|https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}|g" \
      -e "s|https\?://deb.debian.org/debian|https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}|g" \
      /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::Check-Valid-Until "false";\n' \
      > /etc/apt/apt.conf.d/99snapshot \
    && grep -Fq \
      "URIs: https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}" \
      /etc/apt/sources.list.d/debian.sources \
    && grep -Fq \
      "URIs: https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}" \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      chromium \
      coreutils \
      curl \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      git \
      jq \
      less \
      nano \
      nginx \
      openssh-server \
      ripgrep \
      sqlite3 \
      tmux \
      xz-utils \
      yamllint \
    && rm -rf /var/lib/apt/lists/* \
    && resolved_arch="${TARGETARCH:-${BUILD_ARCH}}" \
    && case "${resolved_arch}" in \
      amd64) \
        antigravity_platform=linux-x64; \
        antigravity_archive=cli_linux_x64.tar.gz; \
        antigravity_sha512="${ANTIGRAVITY_AMD64_SHA512}"; \
        gh_arch=amd64; \
        gh_sha256="${GH_AMD64_SHA256}"; \
        node_arch=x64; \
        node_sha256="${NODE_AMD64_SHA256}"; \
        ttyd_arch=x86_64; \
        ttyd_sha256="${TTYD_AMD64_SHA256}"; \
        ;; \
      arm64 | aarch64) \
        antigravity_platform=linux-arm; \
        antigravity_archive=cli_linux_arm64.tar.gz; \
        antigravity_sha512="${ANTIGRAVITY_ARM64_SHA512}"; \
        gh_arch=arm64; \
        gh_sha256="${GH_ARM64_SHA256}"; \
        node_arch=arm64; \
        node_sha256="${NODE_ARM64_SHA256}"; \
        ttyd_arch=aarch64; \
        ttyd_sha256="${TTYD_ARM64_SHA256}"; \
        ;; \
      *) \
        echo "Unsupported architecture: ${resolved_arch}" >&2; \
        exit 1; \
        ;; \
    esac \
    && curl --fail --show-error --silent --location \
      --output /tmp/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" \
    && printf '%s  %s\n' "${ttyd_sha256}" /tmp/ttyd \
      | sha256sum --check --strict - \
    && install -m 0755 /tmp/ttyd /usr/local/bin/ttyd \
    && install -d -m 0755 /usr/local/libexec \
    && install -m 0755 /usr/bin/env /usr/local/libexec/antigravity-native-env \
    && curl --fail --show-error --silent --location \
      --output /tmp/antigravity.tar.gz \
      "https://storage.googleapis.com/antigravity-public/antigravity-cli/${ANTIGRAVITY_VERSION}-${ANTIGRAVITY_BUILD}/${antigravity_platform}/${antigravity_archive}" \
    && printf '%s  %s\n' "${antigravity_sha512}" /tmp/antigravity.tar.gz \
      | sha512sum --check --strict - \
    && tar -xzf /tmp/antigravity.tar.gz -C /tmp \
    && install -m 0755 /tmp/antigravity /usr/local/libexec/antigravity-real \
    && antigravity_version_output="$(/usr/local/libexec/antigravity-real --version)" \
    && [[ "${antigravity_version_output}" == "${ANTIGRAVITY_VERSION}" ]] \
    && node_archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    && curl --fail --show-error --silent --location \
      --output "/tmp/${node_archive}" \
      "https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}" \
    && printf '%s  %s\n' "${node_sha256}" "/tmp/${node_archive}" \
      | sha256sum --check --strict - \
    && tar --extract --xz --file "/tmp/${node_archive}" \
      --directory /usr --strip-components=1 \
    && [[ "$(node --version)" == "v${NODE_VERSION}" ]] \
    && gh_archive="gh_${GH_VERSION}_linux_${gh_arch}.tar.gz" \
    && curl --fail --show-error --silent --location \
      --output "/tmp/${gh_archive}" \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${gh_archive}" \
    && printf '%s  %s\n' "${gh_sha256}" "/tmp/${gh_archive}" \
      | sha256sum --check --strict - \
    && tar --extract --gzip --file "/tmp/${gh_archive}" --directory /tmp \
    && install -m 0755 \
      "/tmp/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh \
    && gh_version_output="$(gh --version | head -n 1)" \
    && [[ "${gh_version_output}" == "gh version ${GH_VERSION} "* ]] \
    && [[ "$(node -p "require('/usr/local/lib/antigravity-ha/playwright/package.json').dependencies['@playwright/mcp']")" == "${PLAYWRIGHT_MCP_VERSION}" ]] \
    && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_cache=/tmp/npm-cache \
      npm ci --prefix /usr/local/lib/antigravity-ha/playwright \
        --omit=dev --ignore-scripts --no-audit --no-fund \
    && [[ "$(node -p "require('/usr/local/lib/antigravity-ha/playwright/node_modules/@playwright/mcp/package.json').version")" == "${PLAYWRIGHT_MCP_VERSION}" ]] \
    && [[ "$(node -p "require('/usr/local/lib/antigravity-ha/playwright/node_modules/ws/package.json').version")" == "${WS_VERSION}" ]] \
    && node -e "require('/usr/local/lib/antigravity-ha/playwright/node_modules/playwright-core')" \
    && node --input-type=module -e "const ws = await import('/usr/local/lib/antigravity-ha/playwright/node_modules/ws/wrapper.mjs'); if (typeof ws.default !== 'function') process.exit(1)" \
    && node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); db.exec('CREATE VIRTUAL TABLE smoke USING fts5(value)'); db.close()" \
    && [[ "$(/usr/bin/chromium --version)" == "Chromium ${CHROMIUM_VERSION} "* ]] \
    && rm -rf \
      /tmp/antigravity \
      /tmp/antigravity.tar.gz \
      "/tmp/${gh_archive}" \
      "/tmp/gh_${GH_VERSION}_linux_${gh_arch}" \
      "/tmp/${node_archive}" \
      /tmp/npm-cache \
      /tmp/ttyd

ENV AGY_CLI_DISABLE_AUTO_UPDATE=true

RUN --mount=type=bind,source=rootfs,target=/tmp/antigravity-source-rootfs,readonly \
    source_root=/tmp/antigravity-source-rootfs \
    && manifest="${source_root}/usr/local/share/antigravity-ha/source-rootfs-manifest.json" \
    && test -s "${manifest}" \
    && [[ "${SOURCE_REVISION}" =~ ^[0-9a-f]{40}$ ]] \
    && [[ "${SOURCE_REVISION}" != 0000000000000000000000000000000000000000 ]] \
    && [[ "${SOURCE_ROOTFS_SHA256}" =~ ^sha256:[0-9a-f]{64}$ ]] \
    && jq --exit-status \
      --arg source_rootfs "${SOURCE_ROOTFS_SHA256}" \
      'type == "object" and keys == ["files", "schema", "source_rootfs_sha256"] and .schema == "antigravity-ha-source-rootfs/v1" and .source_rootfs_sha256 == $source_rootfs and (.files | type == "array" and length > 0) and ([.files[].path] == ([.files[].path] | sort | unique)) and all(.files[]; type == "object" and keys == ["mode", "path", "sha256", "size"] and (.path | type == "string" and startswith("/") and (contains("//") | not) and (test("(^|/)\\.\\.(/|$)") | not) and (explode | all(. >= 32 and . != 127))) and (.mode == "0644" or .mode == "0755") and (.size | type == "number" and floor == . and . >= 0) and (.sha256 | type == "string" and test("^sha256:[0-9a-f]{64}$")))' \
      "${manifest}" >/dev/null \
    && aggregate="sha256:$(jq --ascii-output --compact-output --sort-keys '.files' "${manifest}" \
      | tr -d '\n' | sha256sum | awk '{print $1}')" \
    && [[ "${aggregate}" == "${SOURCE_ROOTFS_SHA256}" ]] \
    && test -z "$(find "${source_root}" -mindepth 1 ! -type d ! -type f -print -quit)" \
    && expected_count="$(($(jq '.files | length' "${manifest}") + 1))" \
    && actual_count="$(find "${source_root}" -type f -printf '.' | wc -c)" \
    && [[ "${actual_count}" == "${expected_count}" ]] \
    && while IFS= read -r encoded; do \
      item="$(printf '%s' "${encoded}" | base64 --decode)"; \
      path="$(jq --raw-output '.path' <<< "${item}")"; \
      expected_mode="$(jq --raw-output '.mode' <<< "${item}")"; \
      expected_size="$(jq --raw-output '.size' <<< "${item}")"; \
      expected_sha256="$(jq --raw-output '.sha256' <<< "${item}")"; \
      candidate="${source_root}${path}"; \
      test -f "${candidate}" && test ! -L "${candidate}"; \
      raw_mode="$(stat -c '%a' -- "${candidate}")"; \
      if (( (8#${raw_mode} & 8#111) != 0 )); then actual_mode=0755; else actual_mode=0644; fi; \
      [[ "${actual_mode}" == "${expected_mode}" ]]; \
      [[ "$(stat -c '%s' -- "${candidate}")" == "${expected_size}" ]]; \
      [[ "sha256:$(sha256sum "${candidate}" | awk '{print $1}')" == "${expected_sha256}" ]]; \
    done < <(jq --raw-output '.files[] | @base64' "${manifest}")

COPY rootfs /

RUN manifest=/usr/local/share/antigravity-ha/source-rootfs-manifest.json \
    && test -s "${manifest}" \
    && jq --exit-status \
      --arg source_rootfs "${SOURCE_ROOTFS_SHA256}" \
      '.schema == "antigravity-ha-source-rootfs/v1" and .source_rootfs_sha256 == $source_rootfs' \
      "${manifest}" >/dev/null \
    && aggregate="sha256:$(jq --ascii-output --compact-output --sort-keys '.files' "${manifest}" \
      | tr -d '\n' | sha256sum | awk '{print $1}')" \
    && [[ "${aggregate}" == "${SOURCE_ROOTFS_SHA256}" ]] \
    && while IFS= read -r encoded; do \
      item="$(printf '%s' "${encoded}" | base64 --decode)"; \
      path="$(jq --raw-output '.path' <<< "${item}")"; \
      expected_mode="$(jq --raw-output '.mode' <<< "${item}")"; \
      expected_size="$(jq --raw-output '.size' <<< "${item}")"; \
      expected_sha256="$(jq --raw-output '.sha256' <<< "${item}")"; \
      test -f "${path}" && test ! -L "${path}"; \
      [[ "$(stat -c '%u:%g' -- "${path}")" == "0:0" ]]; \
      raw_mode="$(stat -c '%a' -- "${path}")"; \
      if (( (8#${raw_mode} & 8#111) != 0 )); then actual_mode=0755; else actual_mode=0644; fi; \
      [[ "${actual_mode}" == "${expected_mode}" ]]; \
      [[ "$(stat -c '%s' -- "${path}")" == "${expected_size}" ]]; \
      [[ "sha256:$(sha256sum "${path}" | awk '{print $1}')" == "${expected_sha256}" ]]; \
    done < <(jq --raw-output '.files[] | @base64' "${manifest}") \
    && printf '%s\n' "${BUILD_VERSION}" > /usr/local/share/antigravity-ha/app-version \
    && find /usr/local/share/antigravity-ha/plugins -type d -exec chmod 0755 {} + \
    && find /usr/local/share/antigravity-ha/plugins -type f -exec chmod 0644 {} + \
    && chmod 0755 \
      /etc/s6-overlay/s6-rc.d/antigravity-ha-init/run \
      /etc/s6-overlay/s6-rc.d/ha-change-broker/run \
      /etc/s6-overlay/s6-rc.d/ha-memoryd/run \
      /etc/s6-overlay/s6-rc.d/ha-read-broker/run \
      /etc/s6-overlay/s6-rc.d/ingress/finish \
      /etc/s6-overlay/s6-rc.d/ingress/run \
      /etc/s6-overlay/s6-rc.d/sshd/finish \
      /etc/s6-overlay/s6-rc.d/sshd/run \
      /etc/s6-overlay/s6-rc.d/telegram-bot/run \
      /etc/s6-overlay/s6-rc.d/ttyd/finish \
      /etc/s6-overlay/s6-rc.d/ttyd/run \
      /usr/local/bin/* \
      /usr/local/libexec/* \
    && chmod 0644 \
      /etc/antigravity/mcp_config.json \
      /etc/antigravity/settings.json \
      /etc/profile.d/antigravity-ha.sh \
      /usr/local/lib/antigravity-ha/api-client.sh \
      /usr/local/lib/antigravity-ha/browser-approval.sh \
      /usr/local/lib/antigravity-ha/config.sh \
      /usr/local/lib/antigravity-ha/environment.sh \
      /usr/local/lib/antigravity-ha/supervisor-credential.sh \
      /usr/local/share/antigravity-ha/AGENTS.md \
      /usr/local/share/antigravity-ha/antigravity-settings-update.mjs \
      /usr/local/share/antigravity-ha/browser-auth-check.mjs \
      /usr/local/share/antigravity-ha/browser-user-admin.mjs \
      /usr/local/share/antigravity-ha/ha-memory-core.mjs \
      /usr/local/share/antigravity-ha/ha-memory-ha-client.mjs \
      /usr/local/share/antigravity-ha/ha-memory-mcp.mjs \
      /usr/local/share/antigravity-ha/ha-memory.mjs \
      /usr/local/share/antigravity-ha/managed-plugin-update.mjs \
      /usr/local/share/antigravity-ha/ha-change-broker-client.mjs \
      /usr/local/share/antigravity-ha/ha-change-broker.mjs \
      /usr/local/share/antigravity-ha/ha-change-proposal-mcp.mjs \
      /usr/local/share/antigravity-ha/ha-feedback.mjs \
      /usr/local/share/antigravity-ha/ha-telegram-pair.mjs \
      /usr/local/share/antigravity-ha/ha-read-broker.mjs \
      /usr/local/share/antigravity-ha/ha-read-client.mjs \
      /usr/local/share/antigravity-ha/ha-read-mcp.mjs \
      /usr/local/share/antigravity-ha/ha-validate-mcp.mjs \
      /usr/local/share/antigravity-ha/playwright-init-page.ts \
      /usr/local/share/antigravity-ha/playwright-mcp-proxy.mjs \
      /usr/local/share/antigravity-ha/playwright-mcp.json \
      /usr/local/share/antigravity-ha/source-rootfs-manifest.json \
      /usr/local/share/antigravity-ha/supervisor-credential-fd.mjs \
      /usr/local/share/antigravity-ha/supervisor-options-migrate.mjs \
      /usr/local/share/antigravity-ha/telegram-bridge.mjs \
      /usr/local/share/antigravity-ha/telegram-pairing.mjs \
      /usr/local/share/antigravity-ha/telegram-state.mjs \
      /usr/local/share/antigravity-ha/user-files-update.mjs \
      /usr/local/share/antigravity-ha/app-version

RUN install -d -m 0700 /data/home /data/antigravity /data/github-cli \
    && antigravity_version_output="$(antigravity --version)" \
    && [[ "${antigravity_version_output}" == "${ANTIGRAVITY_VERSION}" ]] \
    && gh_version_output="$(gh --version | head -n 1)" \
    && [[ "${gh_version_output}" == "gh version ${GH_VERSION} "* ]] \
    && node --check /usr/local/share/antigravity-ha/ha-feedback.mjs \
    && node --check /usr/local/share/antigravity-ha/managed-plugin-update.mjs \
    && node --check /usr/local/share/antigravity-ha/supervisor-options-migrate.mjs \
    && node /usr/local/share/antigravity-ha/ha-feedback.mjs --help \
      | grep -Fq 'ha-feedback github submit'

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}" \
  org.opencontainers.image.title="Home Assistant App: Antigravity for Home Assistant" \
  org.opencontainers.image.description="Antigravity CLI, verified feedback reports, Playwright browser, Ingress terminal, and public-key SSH for Home Assistant" \
  org.opencontainers.image.revision="${SOURCE_REVISION}" \
  org.opencontainers.image.source="https://github.com/Kanu-Coffee/antigravity-for-home-assistant" \
  io.antigravity-ha.source-rootfs-sha256="${SOURCE_ROOTFS_SHA256}" \
  org.opencontainers.image.licenses="Apache-2.0"
