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

**2.1.0 operational-permission redesign:** Public 2.0.18 on real HAOS 18.2
amd64 passed App startup, native `antigravity --version` with status 0,
Telegram transport, and a no-tool chat. Web `agy`/`antigravity` interactive I/O
failed; current kernel audit records the confined interactive profile denying
inherited/open `rw` access to `/dev/pts/0`. The first managed Telegram tool
request also ended in a terminal error. Tests 3 through 7 then reused that
failed conversation, so they are not independent PASS/FAIL evidence for each
feature. Approved write execution remained `NOT RUN`; public 2.0.18 amd64
acceptance is `FAIL` overall.

Version 2.1.0 opens ordinary operational work on `/config`, `/share`, `/media`,
non-credential persistent HOME paths, temporary workspaces, ordinary system
commands, installed MCPs, supported Core/Supervisor manager APIs, and bounded
Host/Supervisor log projections. Raw logs are unavailable. The broker removes
the exact App token and known credential-shaped lines or blocks, but does not
claim that arbitrary unkeyed application text can always be classified as
non-secret. It retains mandatory denies for
`secrets.yaml`, `.storage`, OAuth/tokens/keys, App-owned permission and MCP
policy, credential-bearing cross-process `/proc`, Recorder writes, and raw
backup/SSL/other-App configuration. `request-review` remains the safe default
and binds mutations to review or approval; explicit `always-proceed` is an
autonomous-administrator mode outside that blacklist. `strict` and
`proceed-in-sandbox` remain legacy inputs and normalize to `request-review`.
No `full_access`, `docker_api`, Docker socket, host-root/PID mount, or protection
disablement is added. This breaking transition adds 2.1.0 to
`breaking_versions`.

Native `read_file` and `write_file` are denied globally in both modes because a
symlink alias can bypass their lexical-path decision. Ordinary file work uses
only the confined `ha_files` MCP tools `ha_files_list`, `ha_files_read_text`,
and `ha_files_write_text`. They are limited to `/config`, `/share`, `/media`,
ordinary `/data/home`, `/tmp`, and `/var/tmp`, with a 1 MiB UTF-8 file limit, a
200-entry list limit, no-link/single-link regular-file checks, same-directory
atomic writes, and optional `expected_sha256` conflict detection.

Automated regressions are not HAOS evidence. Real-device 2.1.0 acceptance on
amd64 and aarch64 is `NOT RUN` at publication and overall v2 acceptance remains
`PARTIAL`.

Downgrading to 2.0.12 is neither the normal repair for the 2.0.18 permission
failure nor an automatic, lossless recovery path. Its public
image failed to attach the custom AppArmor policy, and its real-device success
evidence is limited to amd64 under `docker-default`. Supervisor does not support
a direct downgrade; restoring an exact 2.0.12 App backup replaces App `/data`
and can lose later OAuth, memory, approvals, outbox, and identity state. Without
such a backup, do not uninstall the App or manipulate Docker state.

## What v2 provides

- A pinned native Google Antigravity CLI and the `agy` command
- Image-managed Home Assistant plugin, rules, skills, and bounded read/file MCP
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
> authorized user uses the shared OAuth identity and `/config` plus global
> customizations, and can approve device, configuration, terminal, and script
> actions. OAuth material, App-owned permission settings, and sensitive paths
> cannot be modified directly. Protect the bot token, authorized chats, and
> Telegram accounts as Home Assistant administrator credentials. Public 2.0.18
> amd64 passed Bot API transport and no-tool chat, but the first managed tool
> request ended in a terminal error and later requests reused the failed
> conversation. The 2.1.0 managed read/write, approval, session-quarantine, and
> aarch64 real-device E2E paths remain `NOT RUN`.

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
native sandbox flag overrides. A `telegram_access_mode` value from 2.0.6 or
earlier is migration-only input and is not an authorization source.

Version 2.1.0 defaults to the effective native value `request-review`. It permits
URL reads, managed read/validate/memory/proposal MCPs, and `ha_files` list/read,
while `ha_files` writes, commands, URL execution, and mutation-capable MCPs
require native review or a requester-bound Telegram proposal. Explicitly
selecting `always-proceed` enables autonomous-administrator access to ordinary
commands, URLs, and installed MCPs outside the mandatory blacklist. Native
`read_file` and `write_file` remain denied in that mode; files still go through
`ha_files`. `strict` and `proceed-in-sandbox` are legacy compatibility
inputs for stored Supervisor options and normalize to `request-review`.

Starting in 2.0.12, enabling
Telegram transactionally backs up a root-owned, single-link regular, parseable
settings file of at most 256 KiB. Version 2.1.0 restores `allowNonWorkspaceAccess=true`,
`artifactReviewPolicy=agent-decides`, `enableTerminalSandbox=false`,
the selected effective `toolPermission`, and that mode's exact permission buckets.
Unknown custom allow/ask/deny rules are removed, while top-level settings outside
those five App-managed security keys, global MCP, plugins, OAuth, and `/config`
remain preserved. A non-0600 mode is hardened to 0600 by the transaction.
Symlinks, hardlinks, non-root ownership, oversized files, or unparsable JSON are
left untouched; the bridge records one
sanitized `permission_boundary_blocked` event and waits without contacting the
Bot API or entering a restart loop. Repair with `reset_v2` or another safe file
recovery and restart the App. Exact denies in both modes protect `secrets.yaml`,
`.storage`, OAuth and cloud credentials, App-owned runtime/browser/bot tokens,
SSH/private keys, native MCP and permission policy, credential-bearing `/proc`,
Recorder writes, and raw backup/SSL/other-App configuration.

In `request-review`, Telegram automatically allows only the four Playwright tools that upstream
declares `readOnly: true`: `browser_console_messages`,
`browser_network_requests`, `browser_snapshot`, and `browser_take_screenshot`.
Mutation-capable browser tools including `browser_navigate`,
`browser_navigate_back`, `browser_tabs`, `browser_hover`, `browser_wait_for`,
`browser_resize`, and `browser_close` fail closed until a typed approval adapter
exists. Explicit `always-proceed` permits installed Playwright navigation and
interaction within the current authenticated user request, but does not open
the mandatory credential or file blacklist.

The bridge receives the prompt through piped stdin and runs the shared
`antigravity --output-format stream-json` launcher with the same `/data/home` and
`/config`. It does not inject input into a shell or shared tmux session, but it
inherits the same global settings, plugins, agents, rules, and permission policy
as the CLI. Replies enter an encrypted persistent outbox before send, are
removed only after Telegram acknowledges delivery, and use bounded backoff only
for clearly unsent 429 responses. Ambiguous delivery failures remain isolated
until `/retry`.

Version 2.0.11 uses a **proposal-first** Telegram path. Bounded read MCPs may
inspect safe state, logs, and configuration directly. Home Assistant service or
configuration changes first use `ha_change_propose`; terminal commands, bounded
inline scripts, mutually exclusive command choices, and finite questions first
use `telegram_action_propose`. A proposal MCP cannot execute the operation or
access execution credentials. It registers an exact action digest and public
preview. The bridge binds the card to the requester, chat, session generation,
update, conversation, and TTL. Only an opaque button selection dispatches one
prevalidated action through the HA broker or a credential-free executor. Once
committed, an unprovable completion is reported `in_doubt` and is never spawned
again. The sealed result continues the same Antigravity conversation in a new
turn.

The HA broker supports every live Home Assistant domain/service with bounded
`service_data` and ordinary YAML patches. Approved service calls are checked
against live `/api/services`; YAML uses an expected digest, atomic backup/write,
`ha-config-check`, and exact rollback on failure. The terminal/script executor
receives only the approved source, canonical working directory, and timeout,
runs under the separate AppArmor command profile, and receives neither App
tokens nor native OAuth. Shell-visible background and daemon patterns are
rejected immediately before spawn, but this is not cgroup containment for an
opaque interpreter's double-fork. Daemon jobs are unsupported, and uncertain
completion ends `in_doubt`. A `question` selection has no side effect and
returns only the selected label to the conversation.

Starting in 2.0.10, the broker also supports `multi_choice_service_call` with
one to 31 mutually exclusive service calls. Telegram renders at most 32 buttons
including Cancel, with no more than four buttons per row and eight rows. A
choice callback carries only a short opaque token, never executable parameters.
The bridge revalidates its encrypted token-to-choice mapping and the broker's
requester, session generation, conversation, proposal digest, choice, and
idempotency bindings before executing exactly one prevalidated choice. New
`v3c`/`v3d` choose/cancel callbacks coexist with legacy `v2a`/`v2d`
Approve/Deny cards.

Version 2.0.11 `multi_choice_terminal` and `question` operations also support
one to 31 choices plus Cancel in the same 4-by-8 grid. Action callbacks use
`v4a`/`v4d`/`v4c` and carry only short encrypted-state tokens, never command,
script, or choice payloads. `/cancel` cancels pending or approved actions; it is
not rollback for an already committed operation. TTL cleanup expires only an
untouched pending card; a durable decision or result remains until callback ACK.

Choice mappings and selections persist across a bridge restart, but an
unstarted proposal itself remains in change-broker memory. A bridge-only restart
can therefore revalidate a card while the broker remains alive; a full App or
broker restart that loses the proposal rejects the old card and requires a new
request. An execution already accepted by the broker can recover its durable
idempotency status or completed result without dispatching the mutation again.

Registration by a proposal MCP is not itself crash-durable. If the bridge exits
after coordinator registration succeeds but before it seals the encrypted
approval state and card/outbox, there is no approval card to recover and the
user must repeat the original request to create a new proposal. Durability
claims begin after that seal and cover approval decisions/results or executions
already accepted by the broker.

The 2.0.11 stream parser accepts bounded string `toolAction` and `toolSummary`
metadata in addition to the required `Arguments`, `ServerName`, and `ToolName`
fields. If exactly one completed valid proposal receipt exists but only its
terminal text is empty, the bridge substitutes a fixed safe acknowledgement so
the approval card can still be delivered. A proposal-free empty response,
unknown parameter key, non-string result, or oversized result remains
fail-closed.

There is an important boundary: pinned CLI 1.1.13
`--print --output-format stream-json` cannot export a native permission request
and resume it from that point after external approval. The App therefore does
not claim transparent interception of arbitrary future or user-installed plugin
MCP tools. Managed HA, terminal, script, and question workflows are supported
by the two proposal MCPs; an unrepresentable Telegram side effect fails closed
instead of falling back to a direct tool. On a native permission denial, the
bridge may ask the same conversation once to re-plan with a proposal, but does
not resume or approve the denied invocation. Authenticated interactive Web/SSH
work may use direct tools under native review and is not automatically converted
to a Telegram card.

Once the shared native OAuth identity is authenticated, routine supported work
can be completed from Telegram without a terminal. Initial native OAuth still
requires a controlling TTY, so an unauthenticated installation must run
`ha-antigravity-login` once from the Web terminal or SSH. Real HAOS AppArmor,
native OAuth, live Bot API cards/callbacks, and real-device HA changes remain
`NOT RUN` until release evidence records them.

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
- The native default is `request-review`, which binds mutations to review or a
  proposal approval. Explicit `always-proceed` autonomously runs ordinary work
  outside the blacklist. Only `strict` and `proceed-in-sandbox` are legacy
  upgrade inputs normalized to `request-review`. Both effective modes retain
  the AppArmor command-profile transition and mandatory blacklist. The native
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
| `preserve` | Preserve OAuth and user-owned settings, MCP, and plugins; when Telegram is enabled, automatically reconcile safe settings' five App-managed security keys and permission buckets to the exact policy; refresh the App-owned HA plugin once per version |
| `refresh_managed` | Keep those guarantees and plugin refresh, then back up and merge ownership-recorded settings keys and permission rules |
| `reset_v2` | Explicit recovery mode: back up safely parseable settings and replace managed keys plus all three permission buckets with the exact image defaults, regardless of ownership state |

`reset_v2` preserves user top-level settings outside `permissions`, the existing
global MCP configuration, user plugins, `/config`, OAuth, SSH keys, browser
identity, and memory. It exactly resets managed keys and the entire
`permissions.allow`/`ask`/`deny` object even when prior App ownership state is
missing or ambiguous. Unsafe regular-file state or invalid JSON still fails
closed. Until the option is returned to `preserve`, every startup repairs drift;
switch it back after recovery. Regardless of mode, the App-owned `home-assistant` plugin is
refreshed from the canonical image copy once per App version when its ownership
marker is safe. A marker-less plugin with that name is treated as a user-owned
conflict and stops startup. Before an update, make a full Home Assistant backup
and record the working version/image. On failure, return to `preserve`, then recover with a
previous immutable version and a verified scoped backup. Automatic HAOS rollback
is not guaranteed.

Telegram-enabled automatic reconciliation does not change the selected mode to
`reset_v2`. It uses the same journaled backup transaction once, then a matching
restart completes without another backup. With Telegram disabled, the existing
preserve-mode user-permission behavior remains unchanged.

Build development source images only with `tools/development/build-app`. It
removes only the project-owned, checkout-hashed Buildx builder/cache on exit,
never performs a global Docker prune, and retains the two newest unreferenced
local images carrying this checkout's labels. Release builds use the stable
`antigravity-home-assistant` GHA cache scope. At App runtime, successful
recovery, update, and config transactions bound manifest-verified completed
managed-plugin, native user-files refresh, and change-broker config backups to
the newest two in each category. Active journal/result, unowned, malformed, or
unsafe backups are never auto-deleted. HA memory bounds unreferenced terminal
refresh records to the newest 64 while retaining syncs referenced by the current
catalog, revisions, changes, and audit history. A `running` row left by an
abnormal mid-refresh exit is not auto-deleted because there is no safe lease
signal to distinguish it from live work.

HAOS App updates do not use that development build cache. This repository ships
the generic prebuilt GHCR image recommended by Home Assistant, so the device
pulls the final image and Supervisor owns old-image cleanup after a successful
replacement. Shared layers or image IDs still used by another App are expected
to remain. This App does not add a Docker socket, `docker_api`, or `full_access`,
and it never runs a global prune or `/supervisor/repair` automatically during an
update. If storage appears to grow, use Telegram's `ha_read_storage_usage` plus
Supervisor logs to distinguish system, App data/config, and backup usage first.
`repair` is a broad administrator-approved recovery operation for an evidenced
stale overlay/image failure. Real before/after HAOS update storage observation
remains `NOT RUN`.

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
