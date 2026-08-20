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

**2.1.1 native-settings compatibility fix:** On the first public-2.1.0 Web
`agy` launch, Antigravity 1.1.13 tried to remove non-canonical top-level
`toolPermission` and `enableTerminalSandbox` in `request-review` mode. The intended AppArmor
write/link/lock deny then blocked replacement of the final `settings.json`,
producing an atomic-rename error and default fallback. Both paths share one
directory, so this was not `EXDEV`. Version 2.1.1's native shape omits top-level
`toolPermission` in `request-review`, retains exact
`"toolPermission":"always-proceed"` in `always-proceed`, and omits
`enableTerminalSandbox` in both modes. It validates known native permission
buckets against the Telegram mode in App options and records them in native
order; `always-proceed` omits empty `ask`. Settings/OAuth/policy denies remain;
no copy/unlink fallback or settings-write grant is added.

Telegram tokens and allowlists reside in `/data/options.json`, the Bridge is a
separate S6 service, and its proposal MCP is `telegram_action`. Missing Core
`telegram_bot` services or an MCP literally named `telegram` is not proof that
the Bridge is inactive. Real-HAOS 2.1.1 Web/AppArmor/Telegram/browser/memory
acceptance is `NOT RUN` on both architectures, so overall v2 remains `PARTIAL`.

**2.1.0 operational-permission redesign:** Public 2.0.18 on real HAOS 18.2
amd64 passed App startup, native `antigravity --version` with status 0,
Telegram transport, and a no-tool chat. Web `agy`/`antigravity` interactive I/O
and the first managed Telegram tool failed; kernel audit records denied
inherited/open `rw` access to `/dev/pts/0`. Tests 3 through 7 reused the failed
conversation and are not independent tool results. Approved write remained
`NOT RUN`, so public 2.0.18 acceptance is `FAIL` overall.

Version 2.1.0 opens supported mounts, manager APIs, installed MCPs, commands,
and bounded Host/Supervisor log projections under an operational blacklist.
Raw logs are unavailable; exact App tokens and known credential-shaped lines or
blocks are removed without claiming complete detection of arbitrary unkeyed
application text. Native `read_file`/`write_file` are denied in both modes to
block symlink-alias bypasses. Ordinary files use only confined `ha_files_list`,
`ha_files_read_text`, and `ha_files_write_text`. Secrets, `.storage`, OAuth/
tokens/keys, policy, credential-bearing `/proc`, Recorder writes, and raw host/
Docker boundaries remain blocked. `request-review` is the default; explicit
`always-proceed` is autonomous administrator mode for installed MCPs, commands,
URLs, and Playwright interaction outside the blacklist. `strict` and
`proceed-in-sandbox` normalize to `request-review`. This breaking transition
adds 2.1.0 to `breaking_versions`. Real-device 2.1.0 acceptance is `NOT RUN` on
amd64 and aarch64 at publication, and overall v2 remains `PARTIAL`. A 2.0.12
downgrade is not a clean, safe, or lossless fallback.

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

Telegram defaults to effective native `request-review` and also supports
explicit `always-proceed`. `strict` and `proceed-in-sandbox` are legacy upgrade
inputs normalized to `request-review`. In request-review, Playwright auto-allows
only the four upstream `readOnly: true` console/network/snapshot/screenshot
tools; navigate/tabs/hover/wait/resize/close fail closed until a typed adapter
exists. Always-proceed permits installed Playwright interaction within the
current authenticated user request but does not open the mandatory blacklist.
If the bridge exits after proposal registration but before sealing encrypted
approval/card state, registration cannot be recovered and the request must be
repeated.

Explicit `reset_v2` recovery backs up safe settings and replaces managed fields
and the selected mode's known permission buckets with exact defaults regardless
of prior ownership state. `request-review` records `allow`/`deny`/`ask`, while
`always-proceed` records `allow`/`deny` and omits empty `ask`. It preserves user
top-level settings outside permissions,
global MCP, plugins, OAuth, and `/config`, and repairs drift on every startup
until returned to `preserve`.
Starting in 2.0.12, a Telegram-enabled startup automatically repairs an eligible
root-owned, single-link regular, parseable settings file of at most 256 KiB. In
its current 2.1.1 form, it restores the App-managed security fields, selected
mode's sparse native shape, and known permission buckets, so a supported update
does not require a manual `reset_v2`. Unknown allow/ask/deny rules are not
retained and an existing mode is hardened to 0600;
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
