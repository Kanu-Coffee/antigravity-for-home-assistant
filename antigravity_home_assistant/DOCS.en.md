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

On a real HAOS 18.2 amd64 host, the 2.0.12 `preserve` update passed Telegram
permission reconciliation, Bot reconnect/delivery, and App restart/reconnect,
while custom AppArmor attachment failed with `docker-default (enforce)`. Public
2.0.13 then failed on S6 runtime directories with exit 111, and public 2.0.14
failed on resolved Bashio execution with init exit 126. Public 2.0.15 started the
App service graph and Ingress HTTP/WebSocket, but the primary profile lacked PTY
multiplexor access, so ttyd `pty_spawn` returned EACCES. During the same startup,
`refresh_managed` rejected malformed `permissions.ask` before Telegram-safe
normalization and the bridge remained `permission_boundary_blocked`. Real-HAOS
amd64 acceptance of 2.0.15 is therefore `FAIL`. Version 2.0.16 repaired both
faults and started the App, Ingress, Web terminal, and Telegram Bot API
connection, but `agy` and `antigravity --version` immediately exited with
SIGSEGV/status 139 and Telegram workers failed with the same native crash. An
exact public-2.0.16-image/custom-AppArmor reproduction recorded a kernel-audit
`file_mmap` permission `m` denial on `/usr/local/libexec/antigravity-real` under
`interactive-runtime-restricted`; `interactive-runtime-sensitive-read` had the
same `r`-only rule. Version 2.0.17 fixed that native mmap fault and 2.0.18 fixed
the next managed proposal module/binding defects. Public 2.0.18 on real amd64
HAOS passed App startup, native `antigravity --version` with status 0, Telegram
transport, and a no-tool chat. Web `agy`/`antigravity` interactive I/O failed;
current kernel audit records the interactive profile denying inherited/open
`rw` access to `/dev/pts/0`. The first managed Telegram tool request ended in a
terminal error. Tests 3 through 7 then reused the failed conversation and are
not independent feature PASS/FAIL evidence. Approved writes remained `NOT RUN`,
so public 2.0.18 acceptance is `FAIL` overall.

Version 2.1.0 broadens the supported operational scope to `/config`, `/share`,
`/media`, non-credential persistent HOME paths, temporary workspaces, ordinary
system commands, installed MCPs, Core/Supervisor manager APIs, and
bounded Host/Supervisor log projections under an explicit blacklist. Raw logs
are unavailable; the broker removes the exact App token and known
credential-shaped lines or blocks without claiming that arbitrary unkeyed
application text can always be classified as non-secret.
`request-review` is the default review mode; explicit `always-proceed` is an
autonomous-administrator mode for ordinary work outside the blacklist.
`strict` and `proceed-in-sandbox` normalize to `request-review`. Secrets,
`.storage`, OAuth/tokens, policy, credential-bearing process introspection,
Recorder writes, and raw host credential mounts remain denied. No `full_access`,
Docker socket, or host-root/PID mount is added. Automated regressions are not
HAOS evidence; 2.1.0 real-device acceptance on amd64 and aarch64 is `NOT RUN`
at publication and overall v2 acceptance remains `PARTIAL`.

On public 2.1.2 on real HAOS amd64, the authenticated Web TUI processed Done,
Enter, and Ctrl+C on the Terms/data-use screen, but native local save could not
atomically rename `settings.json.<uuid>.tmp` to final `settings.json`. The
`agy-settings` hash was identical before and after. This is real evidence of a
protected final-settings replacement failure rather than missing terminal
input; it does not prove the separate remote Terms request succeeded. Version
2.1.3 adds a manual consumer-Google-OAuth/Terms controller with an isolated
`/run` staging HOME. It blocks production HOME, `/config`, command, MCP,
proposal, and automatic browser-helper access from onboarding native, then
commits only telemetry-compatible settings, a bounded opaque OAuth credential
file, and exact onboarding booleans in a no-secret journaled, ordered,
crash-consistent sequence after a completed consumer marker
with OAuth and a normal or intentional Ctrl+C close. Real-HAOS 2.1.3
install/update, enforced onboarding AppArmor, OAuth/Terms persistence, normal
Web/Telegram regression, and aarch64 acceptance are `NOT RUN`; overall v2
remains `PARTIAL`.

Native `read_file` and `write_file` are denied globally in both modes to block
symlink-alias bypasses. Ordinary file access uses only the confined `ha_files`
tools `ha_files_list`, `ha_files_read_text`, and `ha_files_write_text`. They are
limited to `/config`, `/share`, `/media`, ordinary `/data/home`, `/tmp`, and
`/var/tmp`, with a 1 MiB UTF-8 limit, a 200-entry listing limit, no-link and
single-link regular-file checks, same-directory atomic writes, and optional
`expected_sha256` conflict detection.

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
4. On first use, complete the sign-in procedure below and close its helper,
   then run `agy`. Test the connection with a read-only request first.

```text
Summarize the current Home Assistant structure and recent Core errors read-only.
Do not change files, registries, or device states yet.
```

## Native Antigravity sign-in

### Google OAuth

Run this once from a controlling TTY in the Web terminal or public-key SSH.
First confirm that no other `agy` session or Telegram job is active.

```bash
ha-antigravity-login
```

Select the personal/consumer Google flow; do not select Google Cloud project or
enterprise onboarding. Automatic browser helpers are intentionally disabled in
this protected session. Open the official HTTPS URL shown by the CLI, paste the
returned authorization code into the controlling TTY, and complete the
Terms/data-use screen. When the normal agent screen appears, do not enter a
prompt; press Ctrl+C to close the helper. Do not start another `agy` or Telegram
request until it has fully exited.

In the Web UI, the helper clears the **entire history of the current Web pane**
when it closes so the OAuth URL and pasted code do not remain in reconnectable
scrollback. It does not report success if it cannot revalidate the same pane and
socket or clear that history. Browser history, the clipboard, screenshots, and
an SSH client's own scrollback are outside the App boundary and must be cleared
separately; the SSH terminal saved-scrollback erase is best effort.

The helper is bounded to 15 minutes. After a timeout, unexpected exit, or
incomplete result, do not start a normal session; restart the App and retry from
the beginning. Its completion message reports only local validation and sync,
not remote Terms acceptance. Rerun it if Terms appear on the next launch. Start
a new session only after the helper closes successfully.

```bash
agy
```

`antigravity` and `ha-antigravity` are wrappers for the same native CLI. The
2.1.3 login helper runs native under a root-owned `/run` staging HOME, then
validates and commits only successful consumer-flow telemetry-compatible
settings, a bounded opaque OAuth credential file, and the exact onboarding
marker into the shared HOME in a no-secret journaled, ordered, crash-consistent
sequence. Each destination replacement is individually atomic; interrupted
prefixes remain quarantined. Normal Web/Telegram final-settings write/link/lock
denies remain in place. The CLI manages OAuth material under
`/data/home/.gemini/**`, which persists across App restarts and normal updates.
Never print that directory, authorization headers, or credential contents, or
copy them into Git, Telegram, or a support issue.

### Post-Terms data-use telemetry opt-out

You can turn off telemetry after accepting it on the Terms screen. Do not edit
`settings.json` directly with an editor, native file tool, or shell redirection.
Use only the mediator from an authenticated Web/SSH terminal, bound to a fresh
digest:

```bash
digest="$(agy-settings sha256)"
jq -nc --arg digest "${digest}" \
  '{expected_sha256:$digest,patch:{enableTelemetry:false}}' \
  | agy-settings patch
```

`false` is stored explicitly as the opt-out. This 2.1.3 mediator is
privacy-strengthening and false-only: it does not provide opt-in or re-enable,
which requires a separate authenticated consent flow. Obtain a fresh digest for
every opt-out. This mediator does not grant normal native sessions broad
final-settings write permission.

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
antigravity_tool_permission: request-review
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
| `antigravity_tool_permission` | `request-review` | `request-review` permits URL/managed reads and `ha_files` list/read, and reviews `ha_files` writes/mutations; explicit `always-proceed` is autonomous administrator mode for commands, URLs, and installed MCPs outside the blacklist. Native raw file tools stay denied in both modes; `strict`/`proceed-in-sandbox` are normalized legacy upgrade inputs |
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
Version 2.1.0 defaults to `request-review`: URL reads, managed
read/validate/memory/proposal tools, and `ha_files` list/read are permitted,
while `ha_files` writes, commands, URL execution, and mutation tools require
native review or a Telegram proposal. Explicit `always-proceed` autonomously
runs commands, URLs, and installed-MCP work outside the mandatory blacklist.
Native `read_file` and `write_file` stay denied and files still go through
`ha_files`. Only `strict` and
`proceed-in-sandbox` are legacy upgrade inputs normalized to `request-review`.
Starting in 2.0.12, enabling
Telegram transactionally backs up a root-owned, single-link regular, parseable
settings file of at most 256 KiB. In its current 2.1.3 form, it restores the
App-managed security fields, selected mode's sparse native shape, and known
permission buckets, while removing retired `enableTerminalSandbox`. Unknown
custom allow/ask/deny rules are removed, while top-level settings outside this
permission boundary, global MCP/plugins/OAuth, and `/config` remain preserved;
an existing mode is hardened to 0600.
Starting in 2.0.16, even a non-array existing permission bucket in an otherwise
safe supported settings file is replaced by the canonical managed policy before
typed merge validation.
Symlinks, hardlinks, non-root ownership, oversized files, or unparsable JSON are
left untouched; the startup gate records one
`permission_boundary_blocked` event and waits without Bot API contact or a
restart loop. Repair with `reset_v2` or another safe file recovery and restart
the App. Exact denies in both modes cover `secrets.yaml`, `.storage`, OAuth and
cloud credentials, App-owned runtime tokens and permission/MCP policy, SSH
private keys, credential-bearing `/proc`, Recorder writes, and raw
backup/SSL/other-App configuration.

In `request-review`, Playwright auto-allow is limited to the four tools upstream declares
`readOnly: true`: `browser_console_messages`, `browser_network_requests`,
`browser_snapshot`, and `browser_take_screenshot`. Mutation-capable tools such
as `browser_navigate`, `browser_navigate_back`, `browser_tabs`, `browser_hover`,
`browser_wait_for`, `browser_resize`, and `browser_close` fail closed in
Telegram until a typed approval adapter is implemented. Explicit
`always-proceed` permits installed Playwright navigation and interaction within
the current authenticated user request, but does not open the mandatory
credential or file blacklist.

Telegram HA mutations must first register with `ha_change_propose`; terminal
commands, scripts, command choices, and finite questions must first register
with `telegram_action_propose`. Neither MCP executes the action: it sends only
an exact digest and public preview to the bridge. A native permission denial
caused by invoking a direct tool first is not approval and that invocation
cannot be resumed. The bridge may ask the same conversation once to re-plan
proposal-first, but an unsupported side effect fails closed rather than bypassing
the card.

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
> Raw settings writes are an exception; use `agy-settings patch` only for the
> documented native-stable top-level scalar UI settings. Unknown non-null keys
> and object/array values are rejected; `null` for an unknown top-level key is
> accepted only to remove stale data. Protect the
> bot token, authorized chats,
> and Telegram accounts like HA administrator credentials.
> Integrated OAuth, AppArmor, and Bot API E2E on real HAOS remain `NOT RUN`.

The supported scalar keys are `altScreenMode`, `clearScrollbackOnResize`,
`colorScheme`, `disableSlashCommands`, `enableTelemetry`, `modelProvider`,
`showFeedbackSurvey`, and `showTips`. `enableTelemetry` accepts only `false` as
a privacy-strengthening opt-out and uses the digest-bound mediator above.

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
is ignored migration input, not an authorization source. Version 2.0.11 splits
managed Telegram side effects between two typed proposal paths. Every HA
service/configuration mutation first uses `ha_change_propose`; terminal commands,
bounded inline scripts, command choices, and finite questions first use
`telegram_action_propose`. A proposal MCP has neither execution credentials nor
the final execution socket. It registers only an exact payload digest and public
preview. The bridge validates requester, chat, session generation, update,
conversation, and TTL before sending a durable Approve/Choose/Deny card. Only
then may the HA broker or credential-free executor run one action that was
validated before the card was created.

Antigravity 1.1.13 `--print --output-format stream-json` has no protocol to
export a native permission prompt and resume at that point after external
approval. A Telegram button therefore does not resume a denied native tool
turn, and the App does not claim transparent interception of arbitrary future
or user-installed plugin MCP tools. On a native permission denial, the bridge
may ask the same conversation once to re-plan with a proposal MCP, but it does
not approve or repeat the denied invocation. A Telegram side effect that
neither proposal can represent fails closed instead of falling back to a direct
tool.

Authenticated interactive Web/SSH work may use direct tools under native review
and AppArmor; it is not automatically converted to a Telegram card. The channels
still share HOME and OAuth identity but use different approval transports. Once
shared OAuth is authenticated, routine supported work can finish in Telegram.
Initial OAuth requires a controlling TTY, so an unauthenticated installation
must run `ha-antigravity-login` once through Web/SSH.

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

Telegram acknowledges an Approve/Choose/Deny callback and performs its basic
authorization checks immediately, but approved broker/executor execution remains
session-serialized in the same requester queue. Execution revalidates requester, chat, current session
generation, conversation, proposal digest, and expiry. `/new`, `/cancel`, restart,
expiry, and duplicate callbacks cannot execute stale approval state; the broker's
durable idempotency record admits the same mutation exactly once.

### Approval security

The Telegram model process receives neither the raw Supervisor token nor the
final execution socket; it can only create typed proposals. The bridge retrieves
the proposal from its coordinator or broker before displaying its preview.
Confirmation is bound to proposal ID, the same conversation, user and chat,
update/run nonce, preview/source digest, and a short TTL. The callback and sealed
result continue the original conversation in a new turn. An action reaches the
executor only after durable commit. If completion cannot be proved after commit,
the bridge stores `in_doubt` and never spawns it again. A changed preview or
precondition, or an expired approval, requires a new proposal.

Coordinator registration by a proposal MCP is not itself crash-durable. If the
bridge exits after registration succeeds but before sealing the encrypted
approval state and card/outbox, the user must repeat the original request to
create a new proposal. “Durable approval” applies only after that seal, and to
decisions/results or executions already accepted by the broker.

#### Multi-choice approval cards

Version 2.0.10 `multi_choice_service_call` is the broker operation for a driving
mode, brightness preset, ambiguous entity, or any other question where exactly
one action must be selected. A proposal contains one to 31 unique `choice_id`
values, display labels, and prevalidated Home Assistant service calls. Every
choice must pass one live `/api/services` snapshot plus the ordinary
`service_call` entity, `service_data`, precondition, verification, and size
limits before the card is created.

Telegram adds Cancel and renders at most 32 buttons, with no more than four per
row and eight rows. New cards use `v3c`/`v3d` choose/cancel callbacks while
legacy binary `v2a`/`v2d` Approve/Deny cards remain supported. Callback data
contains no HA domain, service, entity, or `service_data`. The bridge resolves a
short opaque token through its encrypted mapping, persists the selection before
authorization, then revalidates requester, chat, session generation,
conversation, preview digest, choice, capability, and idempotency with the
broker before executing exactly one choice.

Conversation binding, choice-token mapping, and the selected choice survive a
bridge restart. The body of an unstarted proposal remains only in
change-broker process memory, however, so an old card can be revalidated after a
bridge-only restart only while that broker remains alive. A full App or broker
restart that loses the proposal rejects the card and requires a new request. An
execution already accepted by the broker recovers a completed result or
`in_doubt` from durable idempotency/status state without sending the service
call again.

Version 2.0.11 `multi_choice_terminal` uses the same one-to-31-plus-Cancel grid
to choose one complete command or inline script. `question` returns a
side-effect-free label selection to the same conversation. Action cards use
binary `v4a`/`v4d` and choice `v4c` callbacks; they carry short opaque encrypted-
state tokens rather than command, script, cwd, or parameters. The executor
receives only the approved exact source digest, canonical cwd, and bounded
timeout, runs in the separate AppArmor command profile, and receives no
Supervisor token, bot token, or native OAuth. `/cancel` cancels pending or
approved actions but cannot roll back a committed action. TTL cleanup expires
only an untouched pending card; approved, answered, committed, or terminal
decisions remain until callback ACK.
Shell-visible background and daemon patterns are rejected on a best-effort
basis immediately before spawn. This is not cgroup containment for opaque
interpreter double-forks, so daemon jobs are unsupported and uncertain
completion is sealed as `in_doubt` without replay.

This is the managed protocol for HA, terminal, script, and question workflows,
not a universal native hook that automatically cardifies new plugin MCP side
effects. Unsupported calls fail closed. Real HAOS AppArmor enforcement, native
OAuth, live Bot API cards/callbacks, and real service/configuration/command E2E
remain `NOT RUN` until release evidence records them.

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
`http://127.0.0.1:8099/`. Telegram auto-allows only upstream `readOnly: true`
console-message, network-request, snapshot, and screenshot tools. Navigation,
back, tabs, hover, wait, resize, and close are mutation-capable and fail closed
until a typed approval adapter exists; do not assume Telegram can switch pages
or desktop/mobile viewports directly.

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

The `docker-default (enforce)` result in the 2.0.12 amd64 field report is a
custom-policy attachment `FAIL`, not an AppArmor PASS. Public 2.0.13 then
activated the custom policy but omitted the `/run/s6` and `/run/service`
directory entries required by S6, causing exit 111 on the next start. Public
2.0.14 passed that point but did not permit the resolved
`/usr/lib/bashio/bashio` execution target, so init exited 126; the S6 package
target resolved from `/command/with-contenv` also needs an exact init-profile
execute rule. Version 2.0.15 also confined the subsequently traced S6/execline
and Bash, account/nginx, Telegram pause, SSH accounting/OOM, Chromium-child,
and feedback-subtree accesses to their exact profiles and paths, but omitted
primary-profile `/dev/ptmx` access and caused PTY allocation EACCES on real
HAOS. Version 2.0.16 added exact `/dev/ptmx rw` and started the terminal and
Telegram transport, but the two interactive runtime profiles' exact
native-binary rules lacked executable `mmap` permission. The native process
therefore exited with SIGSEGV/status 139 on real HAOS, and kernel audit recorded
denied `file_mmap` permission `m`. Version 2.0.17 changes those two rules from
`r` to `rm` and adds only the full blank-auth trace's exact bootstrap identity
and runtime `/usr/share/ca-certificates/**` TLS trust-store reads to the two
transition chains. It adds no new broad `/etc/**` or `/usr/share/**` rule while
leaving existing runtime `/etc/** r`, required system-library mappings, and
proc/settings/credential denies unchanged. The next real-2.0.17 boundary showed
managed MCP failing because `change-proposal-client` could not read the exact
image-owned `supervisor-credential-fd.mjs` module. Version 2.0.18 grants only
that module read, not a directory-wide rule. Its two interactive launchers
preserve a complete five-value requester/run binding and reject a partial one;
no broad native-tool permission is added. Version 2.1.0 no longer applies that
historical exact-allow design to ordinary operations. Ordinary paths, commands,
MCPs, and bounded log projections inside supported mounts/APIs receive broad
AppArmor operational grants, while credential, storage, policy, and
process-integrity boundaries are explicitly blacklisted. Native raw file tools
remain denied and ordinary files go through `ha_files`; raw logs are unavailable
and known redaction does not guarantee classification of arbitrary unkeyed text.
This is not raw HAOS host access: unmounted host root,
other-App configuration, the Docker socket, and host PIDs remain unavailable.

After updating, check `/proc/self/attr/current` from the App terminal and
relevant service paths plus Supervisor state for an enforced
`antigravity_home_assistant` named profile, and review `s6-mkdir` failures and
unexpected `DENIED` events. Do not disable protection mode or AppArmor as a
workaround.

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
| `preserve` | Preserve OAuth and user settings/MCP/plugins; when Telegram is enabled, automatically reconcile the App-managed security fields, selected mode's sparse native shape, and known permission buckets to the exact policy; canonically security-refresh the App-owned HA plugin once per version |
| `refresh_managed` | Keep that preservation and plugin refresh, then root-only back up and merge ownership-recorded settings keys and permission rules |
| `reset_v2` | Explicit recovery mode: back up safely parseable settings and replace managed fields plus the selected mode's known permission buckets with exact image defaults, regardless of ownership state |

All three modes exclude `/config`, native OAuth, SSH keys, browser identity,
memory DB, and user-owned plugins and MCP servers from reset targets. `reset_v2`
also preserves user top-level settings outside `permissions` and an existing
global MCP file, but exactly resets managed fields and the known permission
buckets present in the selected mode. `request-review` records
`allow`/`deny`/`ask`; `always-proceed` records `allow`/`deny` and omits empty
`ask`. Explicit selection authorizes recovery even when prior ownership state is
absent or ambiguous; an unsafe regular file or invalid JSON still fails closed.
While `reset_v2` remains selected, each
startup repairs drift even within the same version, so return it to `preserve`
after recovery. Regardless
of mode, the App-owned `home-assistant` plugin is refreshed from the
canonical image copy once per App version when its ownership marker is safe. A
new install records the current version marker. An existing marker-less plugin
with that name is treated as a user-owned conflict and stops startup without
being overwritten. Other replaced files first receive a root-only backup under
`/data/antigravity-ha/backups/native-files/`.

Global `mcp_config.json` receives an empty `mcpServers` default only when missing;
an existing file is byte-preserved in every mode. HA MCP servers, rules, and
skills live inside the App plugin. `refresh_managed` limits re-execution with
per-App-version transaction state.
Telegram-enabled permission reconciliation uses the same journaled backup
transaction and is restart-idempotent once settings and ownership match.

Repository developers build source images with `tools/development/build-app`.
It removes only the project-owned, checkout-hashed Buildx builder/cache on exit,
never performs a global Docker prune, and keeps the two newest unreferenced local
images owned by that checkout. Reusable release builds use the stable
`antigravity-home-assistant` GHA cache scope. This does not manage the HAOS
Supervisor image lifecycle.

### HAOS images and storage

This App distributes a generic prebuilt multi-architecture GHCR container via
the `image:` field in `config.yaml`. That is the method recommended by Home
Assistant's [App publishing
guide](https://developers.home-assistant.io/docs/apps/publishing/): the HAOS
device downloads the final container and does not build App source or a BuildKit
cache. Supervisor owns cleanup of old App images after a successful update. An
image ID or layer still referenced by another App is retained until its last
consumer updates, so multiple tags in an image list are not automatically
duplicate reclaimable bytes.

This App does not request the Docker socket, `docker_api`, or `full_access`, and
those privileges must not be added for storage cleanup. It never runs `docker
image prune`, `docker builder prune`, or `POST /supervisor/repair` automatically
on update or startup. The official
[`/supervisor/repair`](https://developers.home-assistant.io/docs/api/supervisor/endpoints/#supervisorrepair)
operation broadly repairs stale containers/images, build cache, volumes,
networks, and Supervisor components. Use it only with separate explicit
administrator approval after logs and storage evidence show a failed/aborted
pull, cleanup error, or overlay failure.

When growth is suspected, first ask Telegram to run `ha_read_storage_usage`.
This read-only tool returns an allowlisted numeric projection from the fixed
official
[`GET /host/disks/default/usage`](https://developers.home-assistant.io/docs/api/supervisor/endpoints/#get-hostdisksdiskusage)
endpoint so system, App data/config, and backup growth can be distinguished.
Then inspect `ha_read_app_logs` and Supervisor logs for update cleanup errors
without copying tokens or option bodies. The endpoint does not provide a
per-Docker-image breakdown. Real before/after HAOS update image and storage
observation remains `NOT RUN`; this guidance does not claim the field symptom
has been automatically reproduced or repaired.

The App prunes backups only after recovery, update, or config transactions end
successfully or unchanged. Managed-plugin transactions under
`/data/antigravity-ha/backups/plugin-*`, native user-files refreshes under
`backups/native-files/refresh-*`, and config patches under
`change-broker/backups/*` each retain the two newest entries whose ownership
manifest and root-owned, symlink-free completed tree validate. Older eligible
entries are removed through atomic quarantine. Active journal/result backups
and manifest-less, unsafe, or symlinked trees are never auto-deleted.

`/data/antigravity-ha-memory/memory.sqlite3` is catalog provenance and verified
history, not a disposable cache. Unreferenced terminal `success`/`failed` rows
from the 15-minute refresh are bounded to the newest 64, while syncs referenced
by the current catalog, revisions, change records, metadata, or audit history
remain. A `running` row left by an abnormal mid-refresh exit is not auto-deleted
because no lease/PID safely distinguishes it from live work. Do not mistake
this exception or real semantic-history growth for host image cache.

### v1 migration cautions

- v1 managed-file refresh values map conservatively to `refresh_managed` and are
  never promoted automatically to `reset_v2`. The v2 schema accepts those two
  deprecated values only so Supervisor can start the upgraded container. After
  user-file and managed-plugin bootstrap succeeds, the App posts the full
  current option object back to the fixed Supervisor self-options endpoint with
  only this key changed to `refresh_managed`. An unavailable request leaves the
  legacy value intact and retries on the next App start.
  Telegram-enabled permission reconciliation is a separate startup boundary
  exception and does not change the selected mode.
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

In particular, do not treat 2.0.12 as an unconditional last-known-good,
lossless fallback. Its public image and tag exist, but custom 23-profile policy
attachment failed; narrow field success was amd64 under `docker-default`, and
aarch64 was `NOT RUN`. Supervisor does not support direct downgrade. Restoring
an exact 2.0.12 App backup replaces App `/data` and loses post-backup OAuth,
memory, approvals, outbox, and identities. Without that backup, do not uninstall
the App or manipulate Docker state. A future higher-version compatibility patch
that preserves current `/data` while intentionally reverting custom attachment
would be explicitly security-degraded and remains an audited `NOT RUN`
contingency.

## Troubleshooting

### App installation or startup fails

- Confirm the device is `amd64` or `aarch64`.
- Confirm the release tag, `config.yaml` version, and GHCR manifest agree.
- Inspect App/Supervisor logs for init and per-service errors without sharing
  tokens or response bodies.
- Never work around a failed AppArmor profile attach by disabling protection mode.
- On public 2.0.15, repeated `pty_spawn: 13` and ttyd restarts after Ingress HTTP
  200 and WebSocket 101 cannot be repaired by selecting Reconnect. Update to
  2.0.16 or later, then retest actual terminal input and reconnection.
- On public 2.0.16, if the Web terminal connects but `agy` or
  `antigravity --version` exits with `Segmentation fault` and status 139 while
  Telegram requests immediately become `worker_failed`, do not classify it as
  a session-reset or reconnect problem. Update to 2.0.17 or later, then verify
  `antigravity --version` status 0 before testing an interactive conversation
  and a Telegram worker. Do not disable AppArmor or protection mode.

### OAuth fails

- Confirm the Web terminal or SSH session provides a controlling TTY.
- Run `ha-antigravity-login` for the shared Web/SSH/Telegram identity, then
  follow the Google flow shown by the CLI.
- Do not use nonexistent login/status subcommands or arbitrary API-key
  environment variables.
- Never print or manually edit the OAuth directory.

### Telegram does not respond

- Check `telegram_enabled`, bot token format, and whether the App restarted.
- On public 2.1.0, if Web `agy` cannot atomically rename
  `settings.json.<uuid>.tmp` to `settings.json` and offers a default fallback,
  do not classify it as cross-device `EXDEV`: both paths are in the same
  `/data/home/.gemini/antigravity-cli` directory. In `request-review` mode,
  Antigravity 1.1.13 tried to remove non-canonical top-level `toolPermission`
  and `enableTerminalSandbox` on the first TUI start, while the intended
  AppArmor deny blocked final-settings replacement. Version 2.1.1 follows the
  native mode-specific shape: `request-review` omits top-level `toolPermission`,
  `always-proceed` retains exact `"toolPermission":"always-proceed"`, and both
  omit `enableTerminalSandbox`. It writes known permission buckets in native
  order, omits empty `ask` in `always-proceed`, and checks them against the
  expected App-option mode. Do not relax AppArmor or add a copy/unlink fallback.
- Telegram tokens and user/chat allowlists come from `/data/options.json`. The
  Bridge is a separate S6 service, not the Home Assistant Core `telegram_bot`
  integration, and its managed proposal MCP is `telegram_action`. Missing Core
  Telegram services or an MCP literally named `telegram` does not prove that
  the Bridge is inactive. Use the bounded `permission_boundary_ready`,
  `connected`, `request_accepted`, `session_ready`, and `request_failed` events
  in order to separate transport from native-worker failures.
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
- `permission_boundary_blocked` means a symlink, hardlink, non-root owner,
  oversized/unparsable file, or non-canonical native security boundary prevented
  automatic reconciliation. If public 2.0.15 `refresh_managed` reported this for
  a parseable settings file with a malformed permission bucket, update to 2.0.16
  or later. The bridge has not contacted
  the Bot API and remains alive without an S6 restart loop. Apply `reset_v2` or
  another safe settings recovery, then restart the App; never add broad allow
  rules to bypass this hold.
- If `request_failed` has `reason_class=authentication_required`, do not repeat
  Bot pairing. Run `ha-antigravity-login` from a trusted App Web terminal or SSH
  session.
- When `request_failed` includes a bounded native termination signal, use that
  class to distinguish a CLI crash from an ordinary exit. Never share stderr,
  prompts, OAuth material, or token text. The public-2.0.16 SIGSEGV cannot be
  repaired with `/new`, pairing, or reconnect.
- On public 2.0.17, when no-tool chat works but managed MCP or approval-card
  requests fail, do not classify it as prompt length, Bot API, or pairing.
  Update to 2.0.18 or later for the exact module-read and complete run-binding
  correction, then retest one read MCP, approval-card creation, and one approved
  bounded write in that order.
- On public 2.0.18, if Web commands return status 0 but interactive I/O stalls,
  or long requests all report validation failures after the first managed-tool
  error, do not turn those reused-session results into separate tool failures.
  Update to 2.1.0 or later and test no-tool, one read, one approval card, and one
  approved bounded write after `/new`. Version 2.1.0 quarantines a failed native
  conversation before the next request.
- `reason_class=headless_read_denied` on an ordinary 2.0.x question can identify
  the old narrow allowlist. Update to 2.1.0 or later. A 2.1.0 denial for a
  protected secret or policy path is intentional and must not be bypassed.
- If `reason_class=headless_permission_denied` repeats after proposal-first
  re-planning in `request-review`, use a supported HA or terminal/script/question
  proposal, or review the direct tool interactively in Web/SSH. An administrator
  who explicitly accepts autonomous operation may select `always-proceed` in the
  App option; the mandatory blacklist still applies.
- On public 2.1.1, if `/status` says `always-proceed` but an ordinary
  `run_command` turn is classified as `headless_permission_denied` and the
  repeated request fails proposal validation, do not infer either a directory/
  AppArmor failure or a native-policy denial. That classifier did not retain
  the tool/layer and also matched generic permission text. In an isolated
  public-2.1.1-image reproduction, the straight-ASCII-quote command succeeded;
  curly Unicode quotes also executed without a permission denial but corrupted
  the output to `‘TERMINAL-DIR-OKn’`. This is not HAOS evidence; avoid repeated
  execution and inspect the bounded 2.1.2 reason instead. Version 2.1.2 replans
  only an exact native command denial without a proposal in `request-review`,
  at most once; one exact same-run proposal continues through receipt checks.
  An `always-proceed` denial fails closed as the `unexpected_permission_denied`
  policy mismatch without an approval card. Native-file denial is separated as `headless_read_denied`
  with managed-`ha_files` guidance; an ordinary shell/AppArmor `Permission
  denied` is not mistaken for native approval denial.
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
- Version 2.0.11 permits `toolAction` and `toolSummary` string metadata of at
  most 1,024 UTF-8 bytes without NUL or non-whitespace control characters,
  alongside the required `Arguments`, `ServerName`, and `ToolName` receipt
  parameters for exact `ha_change_propose` or `telegram_action_propose` calls.
  Any other key or invalid metadata remains
  `proposal_result_invalid`.
- If terminal text alone is empty after exactly one completed valid proposal
  receipt, 2.0.11 uses a fixed safe acknowledgement and queues the approval
  card. A proposal-free empty response, non-string response, or response above
  32 KiB remains `terminal_response_invalid`.
- Never upload native CLI logs, OAuth URLs, tokens, or raw prompts. Do not guess
  or manually edit credential paths in the shared HOME.
- Never use `--dangerously-skip-permissions` to bypass the mandatory blacklist.
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

As of the repository state on 2026-08-21, static and component tests cover the
native CLI wrapper, read/change brokers, universal action
proposal/coordinator/executor, Telegram binding and replay, memory, browser
contracts, migration, AppArmor policy parsing, and a kernel-enforced startup
smoke. That smoke attaches the actual profile to the exact image and checks
cold start, fresh-container restart, S6 init, and read denial of a safely seeded
`/config/secrets.yaml` canary. It does not use the real options file for that
denial check, and it remains automated Linux-container evidence. It cannot mark
these items `VERIFIED`:

- Clean install on real HAOS amd64, and install/start/update on aarch64
- Native Antigravity OAuth and plugin discovery on both architectures
- Corrected 2.1.2 custom AppArmor profiles attached in enforce mode with
  successful native `--version`/conversation, first start, stop/start, restart,
  Web-terminal PTY/reconnect, broad operational read/write, managed read MCP,
  raw-unavailable bounded Host/Supervisor log projections with known-credential
  redaction, Telegram review/autonomous modes, and an
  approved bounded write on HAOS
- Actual pull of the public GHCR generic manifest and per-architecture digests
- End-to-end dashboard, live Telegram cards/callbacks/commands/HA actions, all
  migration modes, and rollback

The App therefore remains experimental. Check the release CI, Builder, GHCR
manifest, and HAOS acceptance record for each item. Do not interpret plans or
unit tests in these documents as validation on a real device.

The current narrow field record is: 2.0.12 amd64 Telegram reconcile/reconnect
and App restart/reconnect `PASS`, custom AppArmor attachment on that image
`FAIL`, public 2.0.13 S6 runtime startup `FAIL`, public 2.0.14 resolved Bashio
execute startup `FAIL`, public 2.0.15 Web-terminal PTY EACCES plus Telegram
`refresh_managed` ordering `FAIL`, public 2.0.16 native `file_mmap` denial plus
SIGSEGV/status 139 `FAIL`, and public 2.0.17 managed-MCP/Telegram-proposal
`FAIL` with approved write `NOT RUN`. Public 2.0.18 amd64 passed startup,
native version, and no-tool chat, but Web PTY I/O and the first managed tool
failed; tests 3 through 7 reused the failed conversation and are not independent
results, while approved write remained `NOT RUN`. Public 2.1.0 amd64 then
`FAIL`ed its first Web-TUI settings canonicalization with a same-directory
rename error and default fallback; a Telegram invocation also returned no user
response, but missing bounded Bridge events prevent classifying transport
versus worker failure. Subsequent public-2.1.1 Telegram checks on amd64 passed
transport, an exact no-tool response, a managed state read, and a confined file
listing, but failed the explicit-`always-proceed` direct command and its
mode-unaware proposal fallback. Version 2.1.1 telemetry did not identify the
tool/layer and cannot establish whether shell `/config` access or the AppArmor
command profile was reached, so both remain `NOT RUN`. The isolated
public-image straight-quote success and curly-quote output corruption are
automated reproduction, not HAOS evidence. Real-device 2.1.2 and all aarch64
acceptance also remain `NOT RUN`. The aarch64 waiver is
not a PASS and overall v2 acceptance remains `PARTIAL`. This does not pass the
complete HA-001 through HA-008 or AA-001 matrices.

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
