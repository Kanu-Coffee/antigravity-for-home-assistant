<p align="right">
  <a href="README.md">한국어</a> · <strong>English</strong>
</p>

<p align="center">
  <img src="antigravity_home_assistant/logo.png" alt="Antigravity for Home Assistant Logo" width="180">
</p>

<h1 align="center">Antigravity for Home Assistant</h1>

<p align="center">
  Home Assistant App integrating Google Antigravity CLI (`agy`), Ingress web terminal,<br>
  SSH, headless browser verification, and local verified Home Assistant memory.
</p>

<p align="center">
  <a href="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/Kanu-Coffee/antigravity-for-home-assistant?include_prereleases"></a>
  <a href="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/workflows/ci.yaml"><img alt="CI" src="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/workflows/ci.yaml/badge.svg"></a>
  <img alt="Architecture: amd64" src="https://img.shields.io/badge/architecture-amd64-blue">
  <img alt="Stage: experimental" src="https://img.shields.io/badge/stage-experimental-orange">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-green"></a>
</p>

## Overview

Antigravity for Home Assistant brings Google Antigravity CLI (`agy`) inside Home Assistant OS as an App/Add-on. It mounts `/config` as the active working directory, allowing Antigravity to create and maintain dashboards, automations, scripts, entities, and configurations cleanly.

## Key Features

- **Ingress Web Terminal**: `ttyd` + `tmux` session accessible directly inside Home Assistant UI.
- **Public-Key SSH**: Remote shell access via port 2223 for SSH client sessions.
- **Headless Browser Verification**: Embedded Playwright / Headless Chromium tool set for UI & dashboard testing.
- **Local HA Memory**: Bounded local SQLite/MCP memory engine (`ha_memory`) for context preservation without state leaks.
- **Diagnostic Feedback**: `$ha-feedback` tool for generating sanitized bug and feature reports.

## Quick Start

1. Add `https://github.com/Kanu-Coffee/antigravity-for-home-assistant` to Home Assistant Add-on Repositories.
2. Install **Antigravity for Home Assistant**.
3. Open the Ingress Web UI and authenticate `agy` CLI using `ha-antigravity-login`.
4. Launch `ha-antigravity` to start managing Home Assistant.

## License

Distributed under the [Apache License 2.0](LICENSE).
