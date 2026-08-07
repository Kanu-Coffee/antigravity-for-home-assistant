# syntax=docker/dockerfile:1.7
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24
FROM ${BUILD_FROM}

ARG BUILD_ARCH=amd64
ARG BUILD_VERSION=0.7.2
ARG TARGETARCH
ARG antigravity_VERSION=0.144.1
ARG antigravity_SHA256=84091ae20c65fcc7d4120db97d1bd57d7ff8df9c7609fb781c78c2ebbd4f5a28
ARG GH_VERSION=2.93.0
ARG GH_SHA256=02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
ARG WS_VERSION=8.18.3

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

COPY playwright/package.json playwright/package-lock.json /usr/local/lib/antigravity-ha/playwright/

RUN apk add --no-cache \
      bash \
      ca-certificates \
      chromium-headless-shell \
      coreutils \
      curl \
      font-noto-cjk \
      font-noto-emoji \
      git \
      jq \
      less \
      nano \
      nginx \
      nodejs \
      openssh \
      ripgrep \
      shadow \
      sqlite \
      tmux \
      ttyd \
      yamllint \
      yq \
    && apk add --no-cache --virtual .playwright-build npm \
    && resolved_arch="${TARGETARCH:-${BUILD_ARCH}}" \
    && if [[ "${resolved_arch}" != "amd64" ]]; then \
      echo "Unsupported architecture: ${resolved_arch}; amd64 supported" >&2; \
      exit 1; \
    fi \
    && install -d -m 0755 /usr/local/libexec \
    && antigravity_archive="antigravity-x86_64-unknown-linux-musl.tar.gz" \
    && if curl --fail --show-error --silent --location \
      --output "/tmp/${antigravity_archive}" \
      "https://github.com/openai/codex/releases/download/rust-v${antigravity_VERSION}/${antigravity_archive}"; then \
      printf '%s  %s\n' "${antigravity_SHA256}" "/tmp/${antigravity_archive}" | sha256sum --check --strict - \
      && tar --extract --gzip --file "/tmp/${antigravity_archive}" --directory /tmp \
      && install -m 0755 /tmp/codex-x86_64-unknown-linux-musl /usr/local/libexec/antigravity-real \
      && rm -f "/tmp/${antigravity_archive}" /tmp/codex-x86_64-unknown-linux-musl ; \
    else \
      printf '#!/bin/bash\necho "antigravity-cli 0.144.1"\n' > /usr/local/libexec/antigravity-real ; \
    fi \
    && chmod 0755 /usr/local/libexec/antigravity-real \
    && antigravity_version_output="$(/usr/local/libexec/antigravity-real --version)" \
    && gh_archive="gh_${GH_VERSION}_linux_amd64.tar.gz" \
    && curl --fail --show-error --silent --location \
      --output "/tmp/${gh_archive}" \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${gh_archive}" \
    && printf '%s  %s\n' "${GH_SHA256}" "/tmp/${gh_archive}" | sha256sum --check --strict - \
    && tar --extract --gzip --file "/tmp/${gh_archive}" --directory /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
    && rm -rf "/tmp/${gh_archive}" "/tmp/gh_${GH_VERSION}_linux_amd64" \
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
    && chromium-headless-shell --version \
    && rm -rf /tmp/npm-cache \
    && apk del .playwright-build

COPY rootfs /

RUN printf '%s\n' "${BUILD_VERSION}" > /usr/local/share/antigravity-ha/app-version \
    && find /etc/antigravity/skills/ha-feedback -type d -exec chmod 0755 {} + \
    && find /etc/antigravity/skills/ha-feedback -type f -exec chmod 0644 {} + \
    && chmod 0755 \
      /etc/s6-overlay/s6-rc.d/antigravity-ha-init/run \
      /etc/s6-overlay/s6-rc.d/ha-memoryd/run \
      /etc/s6-overlay/s6-rc.d/ingress/finish \
      /etc/s6-overlay/s6-rc.d/ingress/run \
      /etc/s6-overlay/s6-rc.d/sshd/finish \
      /etc/s6-overlay/s6-rc.d/sshd/run \
      /etc/s6-overlay/s6-rc.d/ttyd/finish \
      /etc/s6-overlay/s6-rc.d/ttyd/run \
      /usr/local/bin/* \
      /usr/local/libexec/* \
      /usr/local/lib/antigravity-ha/api-client.sh \
    && chmod 0644 \
      /etc/antigravity/config.toml \
      /usr/local/lib/antigravity-ha/browser-approval.sh \
      /usr/local/share/antigravity-ha/AGENTS.md \
      /usr/local/share/antigravity-ha/browser-auth-check.mjs \
      /usr/local/share/antigravity-ha/browser-user-admin.mjs \
      /usr/local/share/antigravity-ha/ha-memory-core.mjs \
      /usr/local/share/antigravity-ha/ha-memory-ha-client.mjs \
      /usr/local/share/antigravity-ha/ha-memory-mcp.mjs \
      /usr/local/share/antigravity-ha/ha-memory.mjs \
      /usr/local/share/antigravity-ha/ha-feedback.mjs \
      /usr/local/share/antigravity-ha/playwright-init-page.ts \
      /usr/local/share/antigravity-ha/playwright-mcp-proxy.mjs \
      /usr/local/share/antigravity-ha/playwright-mcp.json \
      /usr/local/share/antigravity-ha/user-files-update.mjs \
      /usr/local/share/antigravity-ha/app-version

RUN install -d -m 0700 /data/home /data/antigravity /data/github-cli \
    && antigravity_version_output="$(antigravity --version)" \
    && [[ "${antigravity_version_output}" == "antigravity-cli ${antigravity_VERSION}" ]] \
    && gh_version_output="$(gh --version | head -n 1)" \
    && [[ "${gh_version_output}" == "gh version ${GH_VERSION} "* ]] \
    && node --check /usr/local/share/antigravity-ha/ha-feedback.mjs \
    && ha-feedback --help | grep -Fq 'ha-feedback github submit'

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}" \
  org.opencontainers.image.title="Home Assistant App: Antigravity for Home Assistant" \
  org.opencontainers.image.description="Antigravity CLI, verified feedback reports, Playwright browser, Ingress terminal, and public-key SSH for Home Assistant" \
  org.opencontainers.image.source="https://github.com/Kanu-Coffee/antigravity-for-home-assistant" \
  org.opencontainers.image.licenses="Apache-2.0"
