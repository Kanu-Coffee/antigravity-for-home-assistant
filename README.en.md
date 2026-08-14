<p align="right">
  <a href="README.md">한국어</a> · <strong>English</strong>
</p>

<p align="center">
  <img src="antigravity_home_assistant/logo.png" alt="Antigravity for Home Assistant logo" width="180">
</p>

<h1 align="center">Antigravity for Home Assistant</h1>

<p align="center">
  An experimental Home Assistant App that runs Google Antigravity CLI inside HA,<br>
  with guarded API, browser, memory, and Telegram access for HAOS administration.
</p>

<p align="center">
  <a href="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/Kanu-Coffee/antigravity-for-home-assistant?include_prereleases"></a>
  <a href="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/workflows/ci.yaml"><img alt="CI" src="https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/workflows/ci.yaml/badge.svg"></a>
  <img alt="Architecture: amd64 and aarch64" src="https://img.shields.io/badge/architecture-amd64%20%7C%20aarch64-blue">
  <img alt="Stage: experimental" src="https://img.shields.io/badge/stage-experimental-orange">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-green"></a>
</p>

<p align="center">
  <a href="https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKanu-Coffee%2Fantigravity-for-home-assistant"><img alt="Add the App repository to Home Assistant" src="https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg"></a>
</p>

> [!WARNING]
> This App has write access to `/config` and administrator-like Home Assistant
> Core and Supervisor API access. Install it only for trusted administrators and
> review backups and previews before changes. It is currently `experimental`;
> consult each release's evidence for complete install, update, and rollback
> verification on both real HAOS architectures.

## What v2 provides

- A pinned native Google Antigravity CLI and the `agy` command
- Image-managed Home Assistant plugin, rules, skills, and bounded read MCP
- `/config` validation, Core/App logs, and scoped Supervisor API helpers
- Headless Playwright MCP using a managed read-only user to view HA dashboards
- Bounded HA memory that retains only explicit facts and verified candidates
- A non-interactive Telegram bridge that never relays shell or tmux input
- An approval broker bound to requester, chat, preview digest, and TTL
- Always-enforced AppArmor with an optional sensitive diagnostic read-only profile
- Prebuilt GHCR release images for `amd64` and `aarch64`

## Quick installation

You need Home Assistant OS or a Supervised installation with Supervisor, an
`amd64` or `aarch64` device, internet access, and a Google account eligible for
Antigravity. This is not a HACS integration.

1. Open **Settings → Apps → App store → Repositories** in Home Assistant.
2. Add this repository URL.

   ```text
   https://github.com/Kanu-Coffee/antigravity-for-home-assistant
   ```

3. Install **Antigravity for Home Assistant** and start with the defaults. A
   release App pulls the architecture-specific image from
   `ghcr.io/kanu-coffee/antigravity-for-home-assistant` instead of building source
   on the HA device.
4. Open **OPEN WEB UI** and start native OAuth once.

   ```bash
   ha-antigravity-login
   ```

5. Complete the Google flow shown by the CLI, then start a new session.

   ```bash
   agy
   ```

`ha-antigravity-login` does not emulate a nonexistent login subcommand. It starts
the official Antigravity first-run OAuth in a controlling TTY. Never print or
attach OAuth material to an issue.

## Telegram setup

> [!CAUTION]
> An actual Antigravity 1.1.11 local canary first reproduced the shared-HOME
> global MCP launch. With the dedicated Telegram HOME and safe cwd, the same
> marker and the `/config/.agents` marker did not run, and managed customization
> tampering failed closed. Actual HAOS OAuth success and AppArmor enforcement
> are still unverified, so keep `telegram_enabled: false` until that gate passes.

Run `ha-telegram-login` once from a trusted local Ingress/SSH controlling TTY to
complete official native first-run OAuth for the dedicated Telegram identity,
then enable the bot. Do not copy or guess the interactive Antigravity login
material.

Create a bot token with [@BotFather](https://t.me/botfather), then choose one of
the following authorization methods.

### Static allowlists

Set both the user ID and chat ID lists in the App configuration. A request is
accepted only when it belongs to their intersection. Filling only one list does
not authorize access.

```yaml
telegram_enabled: true
telegram_bot_token: "REDACTED"
telegram_allowed_user_ids:
  - "123456789"
telegram_allowed_chat_ids:
  - "123456789"
telegram_access_mode: confirm_changes
```

### Local one-time pairing

Create a token from the local Web UI or SSH shell and send it to the same bot
before it expires.

```bash
ha-telegram-pair create --ttl 5m
```

Send `/start TOKEN` in Telegram. The token is displayed once and can be consumed
once, so treat it as a secret. Manage authorizations with
`ha-telegram-pair list` and
`ha-telegram-pair revoke AUTHORIZATION_ID`. A PIN, automatic deep link, and
`/unpair` are not part of the v2 contract.

Bot pairing authorizes only Telegram user/chat access; it does not replace
native OAuth for the dedicated Telegram Antigravity identity. `/start`, `/help`,
`/status`, `/new`, and `/cancel` are local control commands handled directly by
the bridge, not AI prompts. If a natural-language request reports that login is
required, run `ha-telegram-login` from a trusted App terminal instead of finding
or copying credential files.

If Telegram was enabled first, the bridge does not contact the Bot API. It
waits quietly in `waiting_for_authorization`. Creating a pairing in the same
App terminal is detected without an App restart.

### Three operating modes

| Mode | Reads | Change proposals |
| --- | --- | --- |
| `read_only` | Allowed | Execution denied |
| `confirm_changes` | Allowed | Confirmation by the same user and chat every time |
| `autonomous` | Allowed | Only broker-verifiable low-risk configuration changes run automatically |

The minimal broker currently reclassifies every HA `service_call` as high risk
because device safety metadata is unavailable, so a human must confirm even in
`autonomous`. Restart, update, restore, and delete operations are not yet
supported and fail closed. The Telegram worker uses
`agy --print --output-format stream-json --mode plan` only to create proposals;
it never injects commands into a shell or shared tmux session.

## Secure defaults

- AppArmor is always enabled and cannot be disabled by an App option.
- `antigravity_sensitive_data_access: false` is the default. Interactive
  Antigravity then cannot read or write `secrets.yaml`, `.storage`, or the
  Recorder database.
- Setting it to `true` lets only the interactive Antigravity child read those
  three classes for diagnostics. Writes, renames, and deletion remain denied.
- Telegram, browser, memory, broker, and a general shell do not receive this
  additional permission.
- SSH private keys, App tokens, backups, SSL private material, and cloud auth stay
  denied in both modes.
- `always-proceed` and disabling the terminal sandbox cannot bypass AppArmor or
  Telegram broker policy.
- The interactive native OAuth process uses `/data/home`; Telegram uses the
  separate `/data/antigravity-ha/telegram-home`. The identities are not shared,
  but AppArmor alone cannot completely distinguish a legitimate authentication
  read from an induced credential read inside either owning process.

SSH accepts public keys only. Never expose TCP `2224` directly to the internet;
use a trusted VPN.

## Updates and migration

The default `antigravity_user_files_update_mode` is `preserve`.

| Value | Behavior |
| --- | --- |
| `preserve` | Preserve OAuth and user-owned settings, MCP, and plugins; refresh the App-owned HA plugin once per version |
| `refresh_managed` | Keep those guarantees and plugin refresh, then back up and merge ownership-recorded settings keys and permission rules |
| `reset_v2` | Perform the same managed-settings merge strictly and stop if ownership is missing or ambiguous |

Even `reset_v2` does not reset `/config`, OAuth, SSH keys, browser identity,
memory, or user plugins. It stops instead of overwriting assets whose ownership
cannot be proven. Regardless of mode, the App-owned `home-assistant` plugin is
refreshed from the canonical image copy once per App version when its ownership
marker is safe. A marker-less plugin with that name is treated as a user-owned
conflict and stops startup. Before an update, make a full Home Assistant backup
and record the working version/image. On failure, return to `preserve`, then recover with a
previous immutable version and a verified scoped backup. Automatic HAOS rollback
is not guaranteed.

## Documentation and verification status

- [Korean App user guide](antigravity_home_assistant/DOCS.md)
- [English App user guide](antigravity_home_assistant/DOCS.en.md)
- [v2 engineering contract and checklist](docs/v2/README.md)
- [Releases and change history](antigravity_home_assistant/CHANGELOG.md)

Repository tests cover the native CLI contract, Telegram and read brokers,
memory, browser, migration, and AppArmor policy. A parse or build on generic
Linux is not proof of AppArmor enforcement on HAOS or runtime success on both
architectures. Before installing, check the release CI, GHCR multi-arch manifest,
and recorded HAOS verification.

## License

[Apache License 2.0](LICENSE)
