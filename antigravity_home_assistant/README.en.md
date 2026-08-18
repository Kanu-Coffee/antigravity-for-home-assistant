<p align="right">
  <a href="README.md">한국어</a> · <strong>English</strong>
</p>

# Antigravity for Home Assistant

Use antigravity inside Home Assistant to inspect your setup and improve dashboards, automations, entities, and configuration errors through an Ingress Web terminal.

<p align="center">
  <img src="https://raw.githubusercontent.com/Kanu-Coffee/antigravity-for-home-assistant/main/docs/assets/web-terminal-preview.png" alt="Real Antigravity for Home Assistant Web terminal preview">
</p>

<p align="center"><em>Captured from the real public 0.5.0 Web terminal in isolated Docker. On HAOS, it appears inside Home Assistant Ingress.</em></p>

## Key features

- Antigravity CLI with read-write access to all of `/config`
- Home Assistant Core API and Supervisor `manager` helpers
- Shared `tmux` Web terminal that resumes after you close and reopen the browser
- Public-key-only SSH for direct ChatGPT mobile Remote access to the bundled antigravity environment
- An administrator-level Telegram primary channel using the same `/data/home`, `/config`, and global settings as the CLI
- **OPEN WEB UI** in the Home Assistant mobile app or website
- Headless Chromium checks for desktop/mobile dashboard layouts and console/network errors
- Project-local verified memory for HA structure and user-stated aliases, purposes, and preferences
- `/ha-feedback` for read-only app bug validation and structured feature proposals

> [!WARNING]
> This app is a powerful administrative tool that can directly change your Home Assistant configuration. Telegram is equivalent to the CLI as an administrator channel, so protect the bot token, authorized chats, and Telegram accounts. Back up important data, review plans and diffs, and never expose the SSH port directly to the internet.

**2.0.13 AppArmor security transition:** The real-HAOS amd64 2.0.12 update
passed Telegram permission reconciliation, reconnect, and App
restart/reconnect, but custom AppArmor attachment failed and
`docker-default (enforce)` was observed. Version 2.0.13 corrects that boundary
with one Supervisor-recognized slug primary declaration plus 22 indented
declarations that the AppArmor parser continues to load as independent global
`Px` targets. Intended denials may now apply, so this is a breaking update.
Real-HAOS validation of the corrected 2.0.13 policy and aarch64 device testing
are `NOT RUN`; the unavailable-aarch64 owner waiver is an experimental
deployment decision, not a PASS.

## Quick start

1. Install and start the app. It currently supports **amd64 and aarch64**, uses `stage: experimental`, and has `boot: manual`.
2. Select **OPEN WEB UI**.
3. Sign in once with `ha-antigravity-login`.
4. Run `ha-antigravity`.
5. Start with: “Inspect my current setup in read-only mode and do not change anything yet.”

When enabled, Telegram uses the same OAuth, global plugins, agents, rules, MCP,
and permission policy. Its first request keeps one conversation until `/new`,
with approvals and replies continuing in that session. There is no separate
Telegram sign-in or HOME. Version 2.0.10 supports `multi_choice_service_call`,
showing up to 31 prevalidated service-call choices on one approval card and
executing only the selected choice. Existing Approve/Deny cards remain
compatible. Version 2.0.11 also uses proposal-first Telegram cards for managed
terminal commands, inline scripts, command choices, and finite questions, and
executes only the approved exact action. The pinned CLI cannot externally resume
a native permission prompt, so arbitrary future/plugin MCP tools are not
transparently intercepted and unsupported side effects fail closed. Initial
OAuth still requires a one-time Web/SSH login when no shared identity exists.

Telegram's effective native permission is only `request-review` because of the
pinned CLI boundary. Schema values `strict`, `always-proceed`, and
`proceed-in-sandbox` are upgrade-input compatibility and the user-files updater
normalizes all of them to `request-review`. Playwright auto-allows only the four
upstream `readOnly: true` console/network/snapshot/screenshot tools;
navigate/tabs/hover/wait/resize/close fail closed until a typed adapter exists.
If the bridge exits after proposal registration but before sealing encrypted
approval/card state, registration cannot be recovered and the request must be
repeated.

Explicit `reset_v2` recovery backs up safe settings and replaces managed keys
and all three permission buckets with exact defaults regardless of prior
ownership state. It preserves user top-level settings outside permissions,
global MCP, plugins, OAuth, and `/config`, and repairs drift on every startup
until returned to `preserve`.
Starting in 2.0.12, a Telegram-enabled startup automatically restores the five
App-managed security keys and exact 29/0/33 permission policy in a root-owned,
single-link regular, parseable settings file of at most 256 KiB, so a supported
update does not require a manual `reset_v2`. Unknown allow/ask/deny rules are
not retained and an existing mode is hardened to 0600;
an unrecoverable file remains fail-closed without Bot API contact or a restart
loop.

If you do not need SSH, leave `authorized_keys` empty. The Web UI will continue to work.

## Example requests

```text
Check whether Bubble Card is already installed.
Preserve my current dashboard and design a one-column mobile home view.
Show me the plan and diff first, then apply and validate it only after I approve.
```

```text
Based on my weekday wake, departure, and arrival times and my current sensors,
suggest five useful automations with safeguards against false triggers.
Do not edit any files yet.
```

```text
/ha-feedback bug Validate an app symptom in read-only mode and prepare a public-safe report.
```

Direct GitHub submission requires an available candidate search, a ten-minute single-use preview, and separate confirmation. Search or submission uncertainty never triggers an automatic retry; use the Issue Form fallback instead.

See the [English user guide](DOCS.en.md) for installation, all settings, mobile Remote, updates, security, and troubleshooting. [한국어 사용 설명서](DOCS.md) is also available.

This is an unofficial community project. It is not affiliated with or endorsed by OpenAI, Home Assistant, or Nabu Casa.
