<p align="right">
  <a href="README.md">한국어</a> · <strong>English</strong>
</p>

# Antigravity for Home Assistant

A Home Assistant App that runs the Google Antigravity Remote daemon inside
HAOS. Use the official Remote Control Dashboard for normal work; use the
Ingress terminal for first-time authentication and recovery.

## Highlights

- Antigravity access to the `/config`, `/share`, and `/media` projects
- Home Assistant configuration checks and bounded Core and Supervisor helpers
- A managed browser for desktop/mobile dashboard, console, and network checks
- Local memory for explicit and verified Home Assistant context
- `/ha-feedback` for read-only bug investigation and feature proposals
- A loopback-only Remote daemon with no published external port

> [!WARNING]
> This App is an administrator tool that can directly change Home Assistant
> configuration. Protect the Remote account and browser session like Home
> Assistant administrator credentials. Review backups, plans, and diffs before
> changes.

<!-- separate admonitions -->

> [!CAUTION]
> On its first 3.0.0 start, the App deletes all App-owned 2.x runtime data once,
> without a backup. `/config`, `/share`, and `/media` are preserved, but
> authentication, browser identity, memory, and customizations must be created
> again. See the [3.0 transition guide](DOCS.en.md#300-transition) for the exact
> targets.

## Start

1. Install and start the App.
2. In **OPEN WEB UI**, run:

   ```bash
   ha-antigravity-remote-login
   ```

3. Complete Google authentication with the printed URL and code, then wait for
   the helper's completion message. The service starts Remote automatically
   after the login process has fully exited; no App restart is required.
4. Sign in to the
   [Antigravity Remote Control Dashboard](https://antigravity.google.com/) with
   the same account, then select the `home-assistant` instance and a new/default
   project rooted at `/config`.

Without authentication, only Remote waits; Ingress remains available. To rename
the instance, set `remote_control_name` and restart the App.

```yaml
remote_control_name: home-assistant
antigravity_sensitive_data_access: false
home_assistant_browser_auto_auth: true
log_level: info
```

See the [English user guide](DOCS.en.md) for installation, configuration,
security, and troubleshooting. A [한국어 안내](DOCS.md) is also available.

This project is `experimental`. Automated checks are not evidence of behavior
on real HAOS; unperformed device validation remains `NOT RUN`. A user-provided
read-only self-check on one 3.0.0 production device reported all seven categories
as `PASS`, but no architecture or image digest was supplied, so it is not
architecture-qualified 3.0.2 acceptance evidence.
