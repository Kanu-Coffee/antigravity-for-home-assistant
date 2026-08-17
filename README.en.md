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
- A non-interactive Telegram bridge using the same `/config` and global Antigravity environment
- An approval broker bound to requester, chat, preview digest, and TTL
- Always-enforced AppArmor, exact sensitive-data denies, and an optional Recorder diagnostic read-only profile
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
> Telegram is a **primary administrator channel** equivalent to the CLI. An
> authorized Telegram user intentionally uses and can modify `/data/home`,
> `/config`, native OAuth, global/workspace plugins, agents, rules, MCP, and the
> Antigravity permission policy. Protect the bot token, authorized chats, and
> Telegram accounts as Home Assistant administrator credentials. Integrated
> OAuth, AppArmor, and Bot API E2E on real HAOS remain `NOT RUN` until release
> evidence records them.

Complete official native first-run OAuth once with `ha-antigravity-login` in the
Web UI or SSH, then enable the bot. There is no separate Telegram identity,
`ha-telegram-login`, dedicated HOME, or HOME bootstrap.

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

Bot pairing authorizes a Telegram user/chat to access the administrator-level
Antigravity environment. `/start`, `/help`, `/status`, `/new`, and `/cancel` are
local bridge control commands rather than AI prompts. The first natural-language
request persistently binds a conversation before execution; subsequent prompts,
approvals, and replies are serialized in that conversation. Only explicit
`/new` rotates it. If login is required, run `ha-antigravity-login` from a trusted
App terminal instead of finding or copying credential files.

If Telegram was enabled first, the bridge does not contact the Bot API. It
waits quietly in `waiting_for_authorization`. Creating a pairing in the same
App terminal is detected without an App restart.

### Shared permission policy

Telegram has no channel-specific mode. It follows the same
`antigravity_tool_permission` and `antigravity_sensitive_data_access` settings as
Web and SSH. Antigravity 1.1.13's native `--sandbox` cannot create its required
namespaces in a non-privileged HAOS App and fails with `operation not permitted`.
Version 2.0.9 does not use that nested sandbox on any of the three channels.
Instead, commands and stdio tools started by the model cross a discrete `Px`
transition into the `antigravity_home_assistant-command` AppArmor profile. That
boundary keeps shared OAuth and App-managed settings away from command/tool
descendants while retaining ordinary `/config`, network, and scoped-helper work.
It requires no `full_access`, `SYS_ADMIN`, protected-mode change, or other HAOS
privilege. `antigravity_terminal_sandbox` is deprecated, no-op compatibility
input; both `true` and `false` normalize to `false`, and the wrapper rejects
native sandbox flag overrides. A
`telegram_access_mode` value from 2.0.6 or earlier is migration-only input and is
not an authorization source. New installs default to `always-proceed` and allow
the same operational tools in all three channels: `/config`, user global plugins,
agents, skills and rules, URL access, commands, and MCP. Exact denies
still block direct reads and writes of `secrets.yaml`, `.storage`, App-owned
runtime/browser/bot tokens, SSH/private keys, and standard cloud-auth paths.
Spawned command/stdio tools are also unable to read the native OAuth backend
under AppArmor. Inline secrets that users place inside global
plugin/MCP configuration are part of a trusted extension context and are
outside this guarantee.
Writing `settings.json` directly through a raw file tool is an exception to
default-allow. For an explicit current user request to change an ordinary global
setting, obtain the current digest with `agy-settings sha256`, then send
`expected_sha256` and a JSON merge `patch` on stdin to `agy-settings patch`.
That helper updates atomically but rejects the App-owned security keys
`permissions`, `enableTerminalSandbox`, `allowNonWorkspaceAccess`,
`toolPermission`, and `artifactReviewPolicy`; change those policies only through
App options and a restart. User plugins, agents,
skills, and rules remain shared and directly writable, and updates preserve
existing user-owned rules. Version 2.0.9 and later image-managed defaults already
allow `mcp(*)` and leave managed `ask` empty. Do not add redundant
server-specific rules such as `mcp(ha_change/*)`, `mcp(ha_read/*)`, or
`mcp(ha_memory/*)`. User-added `ask` and `deny` rules still take precedence.
The bridge receives
the prompt through piped stdin and runs the shared
`antigravity --output-format stream-json`
launcher with the same `/data/home` and `/config`. It does not inject input into a shell or shared tmux session, but it
inherits the same global settings, plugins, agents, rules, and permission policy
as the CLI. Replies enter an encrypted persistent outbox before send, are removed
only after Telegram acknowledges delivery, and use bounded backoff only for
clearly unsent 429 responses. Ambiguous delivery failures remain isolated until
`/retry`.
Because 1.1.13 `stream-json` cannot resume a native permission prompt, a Telegram
button cannot continue that prompt. Managed runtime rules route ordinary Home
Assistant service/config changes through `ha_change_propose`. The broker supports
every live Home Assistant domain/service with bounded `service_data` and ordinary
YAML patches. Every App-managed broker `service_call`,
`multi_choice_service_call`, or `config_patch` submitted that way is high-risk
and requires durable requester/chat/session-bound Approve/Choose/Deny buttons;
global tool policy
cannot downgrade that broker classification. Approved service calls are checked
against live `/api/services`; YAML uses an expected digest, atomic backup/write,
and `ha-config-check`, with exact rollback on failure.

Starting in 2.0.10, the broker also supports `multi_choice_service_call` with
one to 31 mutually exclusive service calls. Telegram renders at most 32 buttons
including Cancel, with no more than four buttons per row and eight rows. A
choice callback carries only a short opaque token, never executable parameters.
The bridge revalidates its encrypted token-to-choice mapping and the broker's
requester, session generation, conversation, proposal digest, choice, and
idempotency bindings before executing exactly one prevalidated choice. New
`v3c`/`v3d` choose/cancel callbacks coexist with legacy `v2a`/`v2d`
Approve/Deny cards.

Choice mappings and selections persist across a bridge restart, but an
unstarted proposal itself remains in change-broker memory. A bridge-only restart
can therefore revalidate a card while the broker remains alive; a full App or
broker restart that loses the proposal rejects the old card and requires a new
request. An execution already accepted by the broker can recover its durable
idempotency status or completed result without dispatching the mutation again.

The 2.0.10 stream parser accepts bounded string `toolAction` and `toolSummary`
metadata in addition to the required `Arguments`, `ServerName`, and `ToolName`
fields. If exactly one completed valid proposal receipt exists but only its
terminal text is empty, the bridge substitutes a fixed safe acknowledgement so
the approval card can still be delivered. A proposal-free empty response,
unknown parameter key, non-string result, or oversized result remains
fail-closed.

Trusted user-installed/global native tools, `command(*)`/`mcp(*)`, direct
`ha-api`/`supervisor-api`, and ordinary `/config` shell writes inherit the same
administrator authority as the CLI and are not transparently intercepted by the
broker. Mutations through those paths follow user-owned rules and the current
explicit request, subject to exact denies and AppArmor. Authenticated Web/SSH
operations may use those trusted direct paths and are not automatically routed
through a Telegram approval button. The broker guarantee therefore does not
cover every possible native mutation. Native prompts cannot be resumed through
Telegram, and Telegram has no private auto-approval override.

## Secure defaults

- AppArmor is always enabled and cannot be disabled by an App option.
- Direct reads and writes of `secrets.yaml`, `.storage`, App-owned runtime
  tokens/options, SSH/private keys, and standard cloud-auth paths are denied
  regardless of
  `antigravity_sensitive_data_access`.
- Spawned command/stdio tools cannot read the native OAuth backend under
  AppArmor.
- `antigravity_sensitive_data_access: false` is the default and also denies the
  Recorder database. Setting it to `true` gives Web, SSH, and Telegram
  Antigravity runtimes diagnostic read-only access to Recorder DB files and
  sidecars; writes, renames, and deletion remain denied.
- Browser, memory, broker, and a general shell do not receive this additional permission.
- SSH private keys, App tokens, backups, SSL private material, and standard
  cloud-auth paths stay denied in both modes. Do not put inline secrets in
  global plugin/MCP configuration; use a credential-aware wrapper or protected
  environment reference.
- `always-proceed` cannot bypass AppArmor or Telegram broker policy, and the
  command-profile transition cannot be disabled by an App option. The native
  terminal sandbox is not used.
- Web, SSH, and Telegram Antigravity intentionally share `/data/home` OAuth and
  user settings plus the `/config` project. AppArmor cannot distinguish a
  legitimate credential or settings read from one induced by a Telegram prompt;
  exact user/chat authorization and Telegram account protection are the
  administrator boundary. The primary OAuth backend's real path and
  same-process built-in-read non-disclosure are not yet verified on real HAOS.

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

Build development source images only with `tools/development/build-app`. It
removes only the project-owned, checkout-hashed Buildx builder/cache on exit,
never performs a global Docker prune, and retains the two newest unreferenced
local images carrying this checkout's labels. Release builds use the stable
`antigravity-home-assistant` GHA cache scope. At App runtime, successful
recovery, update, and config transactions bound manifest-verified completed
managed-plugin, native user-files refresh, and change-broker config backups to
the newest two in each category. Active journal/result, unowned, malformed, or
unsafe backups are never auto-deleted.

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
