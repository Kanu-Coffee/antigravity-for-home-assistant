<p align="right">
  <a href="README.md">한국어</a> · <strong>English</strong>
</p>

<p align="center">
  <img src="antigravity_home_assistant/logo.png" alt="Antigravity for Home Assistant logo" width="180">
</p>

<h1 align="center">Antigravity for Home Assistant</h1>

<p align="center">
  An experimental Home Assistant App that runs Google Antigravity Remote inside HAOS<br>
  so you can manage the Home Assistant project from a browser.
</p>

<p align="center">
  <a href="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/Kanu-Coffee/antigravity-for-home-assistant?include_prereleases"></a>
  <a href="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/workflows/ci.yaml"><img alt="CI" src="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/workflows/ci.yaml/badge.svg"></a>
  <img alt="Architecture: amd64 and aarch64" src="https://img.shields.io/badge/architecture-amd64%20%7C%20aarch64-blue">
  <img alt="Stage: experimental" src="https://img.shields.io/badge/stage-experimental-orange">
</p>

<p align="center">
  <a href="https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKanu-Coffee%2Fantigravity-for-home-assistant"><img alt="Add the repository to Home Assistant" src="https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg"></a>
</p>

> [!WARNING]
> This App can write `/config` and has administrator-like Home Assistant Core
> and Supervisor API access. Install it only for trusted administrators. Review
> a Home Assistant backup plus every Antigravity plan and diff before an
> important change.

<!-- separate admonitions -->

> [!CAUTION]
> **The first 3.0.0 start resets all App-owned 2.x runtime data once, without a
> backup.** `/config`, `/share`, and `/media` are preserved, but Antigravity,
> Remote, GitHub, browser identity, and local memory must be configured again.
> Read the [3.0 transition guide](antigravity_home_assistant/DOCS.en.md#300-transition)
> before upgrading.

## Highlights

- Official [Antigravity Remote Control](https://antigravity.google/docs/remote-control/)
  for starting work, monitoring progress, providing input or approval, and
  reviewing results
- Project work in `/config`, `/share`, and `/media`, including Home Assistant
  configuration validation
- Bounded Core and Supervisor read helpers that do not expose credentials to
  the model process
- A managed headless browser for desktop and mobile dashboard inspection
- Local memory limited to user-stated or verified Home Assistant context
- `/ha-feedback` for read-only App bug investigation and feature proposals
- An Ingress terminal for recovery and first-time authentication inside HA

The Remote daemon listens only on App-internal loopback. No external port is
published. In a browser, sign in to the
[Remote Control Dashboard](https://antigravity.google.com/) with the same Google
Account.

## Quick start

1. In Home Assistant, open **Settings → Apps → App store → Repositories** and
   add:

   ```text
   https://github.com/Kanu-Coffee/antigravity-for-home-assistant
   ```

2. Install and start **Antigravity for Home Assistant**.
3. Open **OPEN WEB UI** and run the one-time authentication helper:

   ```bash
   ha-antigravity-remote-login
   ```

4. Open the printed URL, paste the authorization code, and complete sign-in
   with the same Google Account. Never copy authentication material into logs
   or issues.
5. The service detects the authentication and starts the Remote daemon
   automatically; no App restart is required. It also returns automatically
   after a HAOS reboot.
6. In the [Remote Control Dashboard](https://antigravity.google.com/), select
   the default `home-assistant` instance and start a task.

Before authentication, the App remains healthy and keeps Ingress available. If
the instance does not appear, use Ingress to inspect authentication status and
App logs and rerun the helper.

## Configuration

Version 3.0 exposes only four options:

```yaml
remote_control_name: home-assistant
antigravity_sensitive_data_access: false
home_assistant_browser_auto_auth: true
log_level: info
```

For installation, the 3.0 reset, security boundaries, and troubleshooting, see
the [English user guide](antigravity_home_assistant/DOCS.en.md). A
[한국어 안내](antigravity_home_assistant/DOCS.md) is also available.

## Status and support

This project is `experimental`. Source, container, and emulated-architecture
checks are not real HAOS evidence; unperformed device results remain `NOT RUN`.
A user-provided read-only self-check on one 3.0.0 production device reported all
seven Remote, `/config`, managed-tool, browser, memory, legacy-channel-removal,
and sensitive-path-isolation categories as `PASS`. Because the architecture and
image digest were not supplied, it is not architecture-qualified 3.0.2 release
acceptance evidence.
Read the [support policy](SUPPORT.md) before opening an issue.

This is an unofficial community project and is not affiliated with or endorsed
by Google or Home Assistant/Nabu Casa.
