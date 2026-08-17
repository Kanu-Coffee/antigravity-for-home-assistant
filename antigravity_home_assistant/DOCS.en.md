<p align="right">
  <a href="DOCS.md">한국어</a> · <strong>English</strong>
</p>

# Antigravity for Home Assistant user guide

This guide explains how to install the v2 App and use native Google
Antigravity, Telegram, Home Assistant tools, and the safety controls.

> [!WARNING]
> This App has write access to all of `/config` and administrator-like Home
> Assistant Core and Supervisor API access. Restrict it to trusted
> administrators and review previews and backups before changes. Never expose
> its SSH port directly to the internet.

## Status and support scope

### Supported environment

- Home Assistant OS or a Supervised installation with Supervisor
- An `amd64` or `aarch64` device
- Internet access for the App image and Google Antigravity OAuth
- A Google account eligible for Antigravity

This App is not a HACS integration. It currently has `stage: experimental` and
`boot: manual`. Releases are packaged to use the prebuilt
`ghcr.io/kanu-coffee/antigravity-for-home-assistant:<version>` image. Before
installing, check the release's multi-architecture manifest and recorded tests
on real HAOS.

### Runtime surfaces

| Surface | Purpose | Change boundary |
| --- | --- | --- |
| Ingress Web terminal | Interactive Antigravity and local administration | Native permission + AppArmor |
| Public-key SSH | Remote shell for trusted administrators | Native permission + AppArmor |
| Telegram Bot | Administrator-level primary Antigravity channel | Native permission + AppArmor + approval broker |

Ingress, SSH, and Telegram use the same `/config` project, `/data/home`, OAuth,
global/workspace plugins, agents, rules, MCP, and permission policy. The Telegram
transport does not relay input to the Web terminal shell or tmux, but it is not
a separate isolated identity.

## Installation

### Add the App repository

[![Add the App repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKanu-Coffee%2Fantigravity-for-home-assistant)

If the button is unavailable, add this URL under **Settings → Apps → App store →
Repositories**.

```text
https://github.com/Kanu-Coffee/antigravity-for-home-assistant
```

Select and install the App. Public releases pull the architecture-specific GHCR
image instead of building source on the HA device. If the App is missing or the
image pull fails, first confirm that the selected version actually publishes a
`linux/amd64` or `linux/arm64` manifest.

### First start

1. Start the App with the defaults.
2. Check the log for init, discrete AppArmor execution profiles, read broker, memory, and Web
   terminal startup results. Do not share tokens or internal response bodies.
3. Open **OPEN WEB UI**. The shell starts in `/config`.
4. Test the connection with a read-only request first.

```text
Summarize the current Home Assistant structure and recent Core errors read-only.
Do not change files, registries, or device states yet.
```

## Native Antigravity sign-in

### Google OAuth

Run this once from a controlling TTY in the Web terminal or public-key SSH.

```bash
ha-antigravity-login
```

Complete the official Google OAuth flow displayed by the CLI. The helper runs
native Antigravity directly; it does not use a fabricated login subcommand or an
App-specific API token. Start a new session afterward.

```bash
agy
```

`antigravity` and `ha-antigravity` are wrappers for the same native CLI. The CLI
manages OAuth material under `/data/home/.gemini/**`, which persists across App
restarts and normal updates. Never print that directory, authorization headers,
or credential contents, or copy them into Git, Telegram, or a support issue.

### Native paths and plugin

v2 uses the native JSON and plugin paths of Antigravity 1.1.13.

| Role | Path |
| --- | --- |
| CLI settings | `/data/home/.gemini/antigravity-cli/settings.json` |
| Global MCP settings | `/data/home/.gemini/config/mcp_config.json` |
| App-managed HA plugin | `/data/home/.gemini/config/plugins/home-assistant/` |
| Workspace MCP | `/config/.agents/mcp_config.json` |
| Shared Web/SSH/Telegram HOME | `/data/home/` |

The App preserves unknown user JSON keys and user plugins, merging only the keys
it owns. It does not create or overwrite the project's `/config/AGENTS.md` as an
HA preset. HA defaults, skills, and MCP servers live in the image-managed
`home-assistant` plugin. Antigravity launched from Telegram inherits those
global/workspace customizations and may modify them when requested by the user.

## App configuration

### Recommended starting configuration

```yaml
telegram_enabled: false
telegram_bot_token: ""
telegram_allowed_user_ids: []
telegram_allowed_chat_ids: []
authorized_keys: []
web_terminal_auto_start_antigravity: false
tmux_session_name: antigravity-ha
antigravity_tool_permission: always-proceed
antigravity_terminal_sandbox: false
antigravity_sensitive_data_access: false
antigravity_user_files_update_mode: preserve
home_assistant_browser_auto_auth: true
log_level: info
```

### Option reference

| Option | Default | Allowed values and meaning |
| --- | --- | --- |
| `telegram_enabled` | `false` | Whether to start the Telegram bridge |
| `telegram_bot_token` | `""` | Secret BotFather token; never expose it in logs or issues |
| `telegram_allowed_user_ids` | `[]` | Allowed numeric user IDs stored as strings |
| `telegram_allowed_chat_ids` | `[]` | Allowed numeric chat IDs stored as strings |
| `authorized_keys` | `[]` | One-line OpenSSH public keys allowed for SSH root login |
| `web_terminal_auto_start_antigravity` | `false` | Start `agy` once in a new tmux session |
| `tmux_session_name` | `antigravity-ha` | A 1–64 character session name using `[A-Za-z0-9._-]` |
| `antigravity_tool_permission` | `always-proceed` | `request-review`, `proceed-in-sandbox`, `always-proceed`, `strict` |
| `antigravity_terminal_sandbox` | `false` | Deprecated no-op compatibility input; neither value enables the native sandbox and both normalize to `false` |
| `antigravity_sensitive_data_access` | `false` | Diagnostic read-only access to Recorder DB files for Web/SSH/Telegram runtimes while AppArmor stays on |
| `antigravity_user_files_update_mode` | `preserve` | `preserve`, `refresh_managed`, `reset_v2`; deprecated migration-only `refresh_agents`, `refresh_all` |
| `home_assistant_browser_auto_auth` | `true` | Manage a local-only, read-only browser identity |
| `log_level` | `info` | `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal` |

The App Network setting for `22/tcp` defaults to host port `2224`. It is not a
JSON option, and you can disable the port when SSH is unused.

Telegram has no separate mode. It follows `antigravity_tool_permission` and
`antigravity_sensitive_data_access` exactly like Web and SSH. The 1.1.13 native
`--sandbox` cannot create namespaces inside the non-privileged HAOS App, so none
of the three 2.0.9 channels uses it. Commands and stdio tools started by the model
instead cross a discrete `Px` transition into the
`antigravity_home_assistant-command` AppArmor profile, with no added host
privilege. `antigravity_terminal_sandbox` is deprecated no-op input; either value
normalizes to `false`, and native sandbox argv overrides are rejected.
`always-proceed` does not disable AppArmor or an App-managed broker's high-risk
human confirmation.

New installs start with `always-proceed`. Managed permissions give all three
channels the same operational access to ordinary `/config`, user global plugins,
agents, skills and rules, URLs, commands, and MCP; the managed `ask`
bucket is empty so headless Telegram does not stop at a native prompt. Exact
read/write denies cover `secrets.yaml`, `.storage`, App-owned runtime
options/tokens, SSH/private keys, and standard cloud-auth paths. Spawned
command/stdio tools also cannot read the native OAuth backend under AppArmor.
Other user-created rules are preserved. Inline secrets that
users put in global plugin/MCP configuration belong to a trusted extension
context and are outside this guarantee.
Writing `settings.json` directly through a raw file tool is the exception. For
an explicit current user request to change an ordinary global setting, obtain
the current digest with `agy-settings sha256`, then send `expected_sha256` and a
JSON merge `patch` on stdin to `agy-settings patch`. The helper updates
atomically but rejects the App-owned `permissions`, `enableTerminalSandbox`,
`allowNonWorkspaceAccess`, `toolPermission`, and `artifactReviewPolicy` keys.
Change those five security policies through App options and a restart. User
plugins, agents, skills, and rules remain shared and directly writable.

### After changing settings

If you changed App options, save them and restart the App. If you changed native
settings, plugin or MCP data, or the global permission profile, end and relaunch
existing Web/SSH Antigravity processes. The Telegram binding survives restart and rotates
only when the user sends `/new`. If the sensitive profile cannot
attach, that Antigravity launch must fail instead of falling back to
broader permissions.

## Access methods

### Web terminal

**OPEN WEB UI** is a ttyd/tmux terminal behind Home Assistant Ingress
authentication. Bash opens by default and you run `agy` yourself. tmux exists
only to reconnect interactive terminal sessions. Multiple tabs may share a
session, so leave it open only for trusted administrators.

### SSH

SSH is optional and accepts public keys only.

1. Create an Ed25519 key pair on the client.
2. Add only its one-line public key to `authorized_keys`. Never place a private
   key in the App configuration.
3. Restart the App and check the host port under Network.
4. Connect from the local network or a VPN.

```bash
ssh -p 2224 root@homeassistant.local
```

Password and keyboard-interactive login are disabled. Do not port-forward TCP
`2224` directly from a router; use a trusted VPN or mesh VPN.

## Telegram

> [!CAUTION]
> Telegram is a primary administrator channel equivalent to the CLI. Authorized
> users can use the shared OAuth identity and read and modify `/config` and
> user-created global/workspace plugins, agents, rules, and MCP customizations.
> Raw settings writes are an
> exception; use `agy-settings patch` for ordinary global settings. Protect the
> bot token, authorized chats,
> and Telegram accounts like HA administrator credentials.
> Integrated OAuth, AppArmor, and Bot API E2E on real HAOS remain `NOT RUN`.

Sign in once with `ha-antigravity-login` in the Web UI or SSH. Telegram uses the
same `/data/home` identity; there is no separate `ha-telegram-login`.

Bot pairing authenticates a Telegram user/chat for this administrator
environment. `/start`, `/help`, `/status`, `/new`, and `/cancel` are local bridge
control commands; natural-language text goes to the same Antigravity environment.

### Create a bot

1. Run `/newbot` with [@BotFather](https://t.me/botfather) in Telegram.
2. Save the issued HTTP API token in `telegram_bot_token`.
3. Prepare one authorization method below, set `telegram_enabled: true`, and
   restart the App.

Treat the bot token like a password. Never include it in screenshots, shell
history, logs, or support payloads.

### Authorize users

#### Static user and chat intersection

Set both `telegram_allowed_user_ids` and `telegram_allowed_chat_ids`. The bridge
processes a request only when its sender user ID and current chat ID appear in
the corresponding lists. A user list or a chat list alone grants no access.
Store IDs as quoted strings rather than JSON or YAML numbers.

#### Local one-time pairing

If you do not know the static IDs, create an expiring token in the App's Web
terminal or SSH.

```bash
ha-telegram-pair create --ttl 5m
```

Send `/start TOKEN` to the bot before the token expires. Issuance is local-only,
the plaintext is shown once, and it cannot be reused after consumption. TTL
accepts seconds (`30s`) or minutes (`5m`) up to ten minutes.

```bash
ha-telegram-pair list
ha-telegram-pair revoke AUTHORIZATION_ID
```

Handle list output and authorization IDs only where needed. v2 has no
log-generated automatic deep link, six-digit PIN, or Telegram `/unpair` command.

If Telegram was enabled first, the bridge does not contact the Bot API. It
waits quietly in `waiting_for_authorization`. Creating a pairing in the same
App terminal is detected without an App restart. Restart the App after changing
the static lists so Supervisor applies the new options.

### Permission and change policy

The Telegram-only `read_only`/`confirm_changes`/`autonomous` modes were removed
in 2.0.7. Telegram uses the same native `antigravity_tool_permission`,
sensitive-data setting, and AppArmor command boundary as Web and SSH. The native
nested sandbox is not used. A `telegram_access_mode` saved by 2.0.6 or earlier
is ignored migration input, not an authorization source. Managed
runtime rules route ordinary Home Assistant service/config changes through
`ha_change_propose`. Every App-managed broker `service_call`/`config_patch`
created that way requires durable Telegram confirmation. Global policy cannot
downgrade the broker's high-risk classification, including locks, alarms, safety
heating/water, host or Core restarts, restores, updates, removals, or credential
and permission changes.

Antigravity 1.1.13 `stream-json` has no protocol for relaying a native interactive
permission prompt to Telegram and resuming the same turn. A Telegram button does
not resume a stopped native tool turn. Managed operational tools pass the default
allow rules before a prompt; ordinary Home Assistant service/config changes use a
broker proposal and same-session Telegram approval. An arbitrary native tool covered by a user-
added global ask/deny rule can still fail headlessly; review it in Web/SSH or
intentionally change the global permission policy.

Trusted user-installed/global native tools, `command(*)`/`mcp(*)`, direct
`ha-api`/`supervisor-api`, and ordinary `/config` shell writes inherit the same
administrator authority as the CLI and are not transparently intercepted by the
broker. Mutations through those direct paths follow user-owned rules and the
current explicit request, subject to exact denies and AppArmor. The broker
guarantees below therefore do not cover every possible native mutation.
Authenticated Web/SSH direct work may use its native interactive flow and is not
automatically routed through a Telegram approval button. That is an approval
transport difference, not a separate HOME, OAuth identity, or global permission
runtime.

### Commands and sessions

| Command | Behavior |
| --- | --- |
| `/start` | Authorization status and basic guidance |
| `/help` | Available commands and current global permission |
| `/status` | Bridge and current session status |
| `/retry` | Explicitly resend an ambiguous delivery from the current session |
| `/new` | Start a new conversation for that user and chat |
| `/cancel` | Request cancellation of the current queued task |

Requests for one user and chat are processed in order with a bounded queue,
timeouts, and response size limits. The first request persistently binds a
conversation ID before execution; later prompts and approvals reuse that same
session. Only `/new` creates another session. Antigravity results enter an
encrypted persistent outbox before send and are removed only after Telegram
acknowledges delivery. Clearly unsent 429 responses use bounded backoff; ambiguous
delivery failures remain isolated until `/retry`. `/cancel` is not a rollback
command for work already completed externally.

Telegram acknowledges an Approve/Deny callback and performs its basic authorization
checks immediately, but approved broker execution remains session-serialized in
the same requester queue. Execution revalidates requester, chat, current session
generation, conversation, proposal digest, and expiry. `/new`, `/cancel`, restart,
expiry, and duplicate callbacks cannot execute stale approval state; the broker's
durable idempotency record admits the same mutation exactly once.

### Approval security

The Telegram model process receives neither the raw Supervisor token nor the
final execution socket; it can only create typed proposals. The bridge retrieves
the proposal from the broker again before displaying its preview. Confirmation
is bound to proposal ID, the same conversation, user and chat, preview digest,
and a short TTL. The approval callback and result continue in that session.
A one-time 256-bit capability plus an idempotency key prevents reuse and
duplicate execution. A changed preview or precondition, or an expired approval,
requires a new proposal.

Broker previews redact token/secret/password/auth/key/PIN/code/credential-like
values while binding approval to the raw payload digest. `service_call` validates
every Home Assistant domain/service against live `GET /api/services`, with an
optional single entity or array of up to 100 entities and bounded plain-JSON
`service_data`. Every broker `service_call` is high-risk and requires approval. Fresh
`expected_state` verification is optional only for a single entity; other calls
report only REST API completion rather than claiming a state outcome.

`config_patch` supports ordinary YAML below `/config`, excluding `secrets.yaml`,
`.storage`, and other sensitive hidden paths. It enforces an expected SHA, atomic
backup/write, and `ha-config-check`, restoring the exact backup and checking again
on failure. Omitting activation reports `restart_required`; explicit reloads are
supported for `input_boolean`, `automation`, `script`, and `scene`. Every broker
`config_patch` is also high-risk and requires approval.

## Home Assistant capabilities

### Helpers and read MCP

| Tool | Purpose |
| --- | --- |
| `ha-config-check` | Validate Home Assistant configuration |
| `ha-core-logs` | Bounded Core log access |
| `ha-addon-logs ADDON_SLUG` | Read logs for one named App |
| `ha-api` | Core API helper |
| `supervisor-api` | Supervisor API helper |
| `ha-memory status` | Check memory schema, freshness, and degraded status |
| `ha-feedback` | Prepare a secret-free bug or feature report candidate |

The Antigravity plugin tools `ha_read_config`, `ha_read_state`, `ha_read_states`,
`ha_read_services`, `ha_read_system_info`, `ha_read_registry`,
`ha_read_history`, `ha_read_traces`, `ha_read_core_logs`, and `ha_read_app_logs`
project fixed endpoints and bound output size. `ha_validate_config` checks the
configuration without a reload, while `ha_verify_state` compares a fresh exact
entity API result with an expected state and optional lower timestamp bound.
The raw Supervisor token is not passed to the model. Trace tools omit raw
configuration, actions/results, triggers, and context. API helpers are
administrator surfaces; a diagnostic finding alone does not authorize a
service call or modification.

### Dashboard browser

The `playwright` MCP observes dashboards at the container-local
`http://127.0.0.1:8099/`. Review relevant pages at desktop 1440×900 and mobile
390×844, including a visible snapshot, screenshot, console warnings and errors,
and failed network requests.

With `home_assistant_browser_auto_auth: true`, the App creates or reuses a
local-only, non-admin user whose sole group is `system-read-only`. Check it with
`ha-browser-auth-status`. Disabling the option shows the normal login screen in
the next browser session and does not automatically delete the managed identity.
Complete removal happens only when the user explicitly runs
`ha-browser-auth-remove`.

Even a read-only identity is not an absolute boundary against permission defects
in custom integrations. Keep dashboard validation observational and never
bypass Core TLS failures.

### Validated memory

Memory is stored at `/data/antigravity-ha-memory/memory.sqlite3`. It never loads
the full database into a prompt; it searches only bounded results relevant to
the current question and exact subject. One clear durable fact stated directly
by the user may become explicit memory. Other learning follows candidate →
verified → applied.

Current or historical state values, timestamps, raw conversations, raw
automation logic, credentials, and unsupported inference are not retained.
`empty`, `degraded`, and `stale` differ from a verified no-result. Use
`ha-memory status` and bounded `search`, `history`, and `conflicts` for health and
audit. Memory rollback compensates only a semantic event; it never rolls back HA
configuration or a device state.

### Configuration changes

Use this sequence even in interactive Antigravity when changing HA configuration.

1. Check that the target is outside sensitive deny paths and record its expected SHA.
2. Prepare the smallest YAML patch and a secret-redacted preview.
3. After approval, atomically back up/write and run `ha-config-check`.
4. On validation failure, restore the exact backup and check again.
5. Run a supported explicit reload or accurately report `restart_required`.
6. Include a fresh HA API result in success only for operations that support
   semantic verification.

Direct `.storage` edits and Recorder database repair are not normal workflows. A
diagnostic finding alone does not authorize a restart, update, removal, restore,
or service call.

## AppArmor and sensitive data

### Always enforce

Supervisor enables AppArmor by default. The redundant metadata default is
omitted, while the custom `apparmor.txt` in the App directory replaces the
default profile. No user option, Telegram command, or migration mode can turn
it off, and the App does not require disabling HA protection mode. A failed
profile attach must not fall back to broader permissions.

### Sensitive-data option

`antigravity_sensitive_data_access` is not an AppArmor on/off switch. It selects
the **discrete top-level execution profile (`Px` transition)** used by interactive
Antigravity started from Ingress, SSH, or Telegram.

| Path class | Default `false` | `true` |
| --- | --- | --- |
| `/config/secrets.yaml` | Read/write denied | Read/write denied |
| `/config/.storage/**` | Read/write denied | Read/write denied |
| Recorder database and sidecars | Read/write denied | Diagnostic read-only; write denied |

Even with `true`, direct secrets/storage access and Recorder rename, truncate,
delete, locking, database repair, and full dumps remain disallowed. Never copy
diagnostic values into output, memory, screenshots, proposals, or artifacts.
Prefer supported APIs and secret key names.

### Items that stay denied

Regardless of the option, browser, memory, broker, and general shells receive no
additional sensitive-read access. Web, SSH, and Telegram Antigravity apply this
option together. SSH private and host keys, App, browser and bot tokens, backups,
private material under `/config/ssl`, standard cloud-auth paths, and broker
capabilities remain denied outside their owning process. Do not place inline
secrets in global plugin/MCP configuration; use a credential-aware wrapper or a
protected environment reference.

Web, SSH, and Telegram Antigravity intentionally share `/data/home` and
`/config`. AppArmor therefore cannot distinguish legitimate OAuth or user-setting
access from the same access induced by a Telegram prompt or tool. This is the
product boundary of a primary administrator channel, not an isolation guarantee;
exact user/chat authentication, native permissions, the spawned-executable
command transition, output redaction, and the broker add defense in depth. The
primary OAuth backend's real path and same-process built-in-read non-disclosure
are not yet verified on real HAOS.
Telegram is off by default; review the actual HAOS OAuth/AppArmor gate and
documented residual risk.

## Updates, migration, and rollback

### Before an update

1. Make a full Home Assistant backup and confirm it is restorable.
2. Record the working App version and, when possible, immutable image digest.
3. Inspect the Git state and uncommitted changes under `/config`.
4. Record OAuth, Web UI/SSH, memory, browser, and Telegram authorization status
   without secrets.
5. Review release evidence for amd64/aarch64, AppArmor enforcement, and migration.

### Migration modes

| Mode | Preservation and change scope |
| --- | --- |
| `preserve` | Preserve OAuth and user settings/MCP/plugins; canonically security-refresh the App-owned HA plugin once per version |
| `refresh_managed` | Keep that preservation and plugin refresh, then root-only back up and merge ownership-recorded settings keys and permission rules |
| `reset_v2` | Perform the same managed-settings merge strictly; fail closed when ownership state is absent or ambiguous |

All three modes exclude `/config`, native OAuth, SSH keys, browser identity,
memory DB, and user-owned plugins and MCP servers from reset targets. Regardless
of mode, the App-owned `home-assistant` plugin is refreshed from the
canonical image copy once per App version when its ownership marker is safe. A
new install records the current version marker. An existing marker-less plugin
with that name is treated as a user-owned conflict and stops startup without
being overwritten. Other replaced files first receive a root-only backup under
`/data/antigravity-ha/backups/native-files/`.

Global `mcp_config.json` receives an empty `mcpServers` default only when missing;
an existing file is byte-preserved in every mode. HA MCP servers, rules, and
skills live inside the App plugin. `refresh_managed` and `reset_v2` limit
re-execution with per-App-version transaction state, but returning the option
to `preserve` after review is recommended.

Repository developers build source images with `tools/development/build-app`.
It removes only the project-owned, checkout-hashed Buildx builder/cache on exit,
never performs a global Docker prune, and keeps the two newest unreferenced local
images owned by that checkout. Reusable release builds use the stable
`antigravity-home-assistant` GHA cache scope. This does not manage the HAOS
Supervisor image lifecycle.

The App prunes backups only after recovery, update, or config transactions end
successfully or unchanged. Managed-plugin transactions under
`/data/antigravity-ha/backups/plugin-*`, native user-files refreshes under
`backups/native-files/refresh-*`, and config patches under
`change-broker/backups/*` each retain the two newest entries whose ownership
manifest and root-owned, symlink-free completed tree validate. Older eligible
entries are removed through atomic quarantine. Active journal/result backups
and manifest-less, unsafe, or symlinked trees are never auto-deleted.

### v1 migration cautions

- v1 managed-file refresh values map conservatively to `refresh_managed` and are
  never promoted automatically to `reset_v2`. The v2 schema accepts those two
  deprecated values only so Supervisor can start the upgraded container. After
  user-file and managed-plugin bootstrap succeeds, the App posts the full
  current option object back to the fixed Supervisor self-options endpoint with
  only this key changed to `refresh_managed`. An unavailable request leaves the
  legacy value intact and retries on the next App start.
- Previous provider credentials and App-specific tokens are not imported as
  native authentication. Google OAuth may need to be completed again.
- Previous non-native settings and guidance files may be preserved, but do not
  assume Antigravity 1.1.13 loads them as native settings or plugins.
- If the public v1 managed-file journal remains, v2 first recovers an unfinished
  `config.toml` or `AGENTS.md` replacement from its verified legacy backup. It
  stops before writing native files when that recovery is corrupt or ambiguous.
- Legacy Telegram pairing and sessions are not trusted. Authorize again with
  both static lists or a new local pairing. v2 never reuses the old
  authorization/pairing files; it moves them into the root-only
  `/data/antigravity-ha/quarantine/v1-telegram/` directory.

### Rollback

Automatic HAOS rollback is not guaranteed. Recover in this order when a problem
occurs.

1. Stop Telegram and mutation work, then invalidate pending approvals.
2. Stop the App and inspect migration status and logs without secrets.
3. Set the update mode to `preserve`.
4. Reinstall a previous immutable version or image if Supervisor offers it.
5. Restore only required App-managed files from a verified transaction backup.
6. If memory schema changed, first verify compatibility with that version's
   backup.
7. Smoke-test Ingress/SSH, OAuth, read API, memory, and browser; enable Telegram
   last.

Do not delete `/config`, restore a database, or restore a Home Assistant backup
without the user's explicit current confirmation.

## Troubleshooting

### App installation or startup fails

- Confirm the device is `amd64` or `aarch64`.
- Confirm the release tag, `config.yaml` version, and GHCR manifest agree.
- Inspect App/Supervisor logs for init and per-service errors without sharing
  tokens or response bodies.
- Never work around a failed AppArmor profile attach by disabling protection mode.

### OAuth fails

- Confirm the Web terminal or SSH session provides a controlling TTY.
- Run `ha-antigravity-login` for the shared Web/SSH/Telegram identity, then
  follow the Google flow shown by the CLI.
- Do not use nonexistent login/status subcommands or arbitrary API-key
  environment variables.
- Never print or manually edit the OAuth directory.

### Telegram does not respond

- Check `telegram_enabled`, bot token format, and whether the App restarted.
- If the log says `waiting_for_authorization`, do not keep restarting. Configure
  both static lists or complete local pairing. Save `telegram_enabled: false`
  when Telegram is not in use.
- For static authorization, check the intersection of both user and chat lists.
- For pairing, check TTL, one-time consumption, and `ha-telegram-pair list`.
- `connect_retry` means the bridge remains alive and retries Telegram with a
  bounded backoff. When present, `transport_code` is a safe DNS, route, or TLS
  classification; the token and raw transport error are never logged. For
  high-latency dual-stack paths that repeatedly return `ETIMEDOUT`, the App
  allows 1.5 seconds per address attempt without forcibly disabling IPv6.
- `connect_blocked` means the Bot token or request policy must be corrected in
  App options before restarting. The same 4xx request is not retried.
- If `request_failed` has `reason_class=authentication_required`, do not repeat
  Bot pairing. Run `ha-antigravity-login` from a trusted App Web terminal or SSH
  session.
- `reason_class=headless_read_denied` means a non-allowlisted headless file read
  was blocked. If it repeats for an ordinary question, do not edit user settings
  or add `read_file(*)`; update to the latest App version and restart.
- `/status` distinguishes Telegram transport, the bound conversation, and the
  most recent shared AI runtime/outbox result. Working help or status does not prove the
  shared native OAuth is ready.
- If `/start`, `/help`, `/status`, or a bridge-generated failure reaches Telegram
  and `telegram_api_errors_total` does not increase, the outbound Bot API network
  is working. A `request_failed` after `session_bound` with no `delivery_queued`
  is an Antigravity terminal-result failure, not a send failure, and there is no
  outbox item for `/retry` yet.
- In that case inspect the bounded `reason_class` and recent runtime in `/status`.
  `terminal_missing`, `terminal_status_failed`, `terminal_response_invalid`,
  `conversation_mismatch`, `stream_contract_failed`, and
  `proposal_result_invalid` identify terminal stages without retaining prompts,
  raw model output, or stderr.
- Never upload native CLI logs, OAuth URLs, tokens, or raw prompts. Do not guess
  or manually edit credential paths in the shared HOME.
- Never use `--dangerously-skip-permissions` or a broad file-read grant.
- If a change preview changed or expired, submit a new request and approve again.

### Browser or memory fails

- If a login page appears, run `ha-browser-auth-status`. `disabled` can be the
  intentional option state.
- Restart the App and browser session after changing the browser option.
- Use `ha-memory status` to distinguish `empty`, `degraded`, and `stale`.
- The reason in parentheses on a memory refresh warning is a bounded diagnostic
  code, not raw output. Keep the existing catalog and correlate
  `ha-memory refresh --force` with Core logs from the same time.
- Do not reset recovery Web UI/SSH merely because browser or memory failed.

### Configuration change fails

- Inspect `ha-config-check` and the scoped diff.
- Never reload or restart Core while validation fails.
- Do not interpret a broker precondition mismatch, expired capability, or
  `in_doubt` as success. Read fresh state and have a human assess the result.

## Verification status and known limitations

As of the repository state on 2026-08-11, static and component tests cover the
native CLI wrapper, read/change brokers, Telegram binding and replay, memory,
browser contracts, migration, and AppArmor policy parsing. Success in a generic
development environment cannot mark these items `VERIFIED`:

- Clean install, start, and update on real HAOS amd64 and aarch64
- Native Antigravity OAuth and plugin discovery on both architectures
- Discrete custom AppArmor execution profiles attached in enforce mode on HAOS
- Actual pull of the public GHCR generic manifest and per-architecture digests
- End-to-end dashboard, Telegram shared policy/session/outbox, all migration modes, and rollback

The App therefore remains experimental. Check the release CI, Builder, GHCR
manifest, and HAOS acceptance record for each item. Do not interpret plans or
unit tests in these documents as validation on a real device.

## Support reports

Before reporting a problem, collect the App version, architecture, reproduction
steps, expected and actual behavior, and checks performed. `ha-feedback` can
prepare a secret-free report candidate, but review the final payload yourself.
Never upload OAuth, Supervisor, bot or browser tokens, `secrets.yaml`, `.storage`,
private keys, internal URLs, or complete raw logs to a GitHub issue.

- [Repository README](../README.en.md)
- [v2 documentation index](../docs/v2/README.md)
- [Security contract](../docs/v2/security.md)
- [Telegram contract](../docs/v2/telegram-spec.md)
- [Migration and release contract](../docs/v2/migration-release.md)
