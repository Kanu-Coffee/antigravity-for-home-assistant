<p align="right">
  <a href="DOCS.md">한국어</a> · <strong>English</strong>
</p>

# Antigravity for Home Assistant user guide

This App runs the Google Antigravity Remote daemon inside HAOS. Use the official
Remote Control Dashboard for normal work; use the Home Assistant Ingress
terminal for initial authentication, diagnostics, and recovery.

> [!WARNING]
> Antigravity can read and write `/config` and can use bounded Home Assistant
> administrator APIs. Protect the Google Account and browser session used for
> Remote like administrator credentials. Before important changes, create a
> Home Assistant backup and review the plan and diff.

## Requirements and installation

- Home Assistant OS or Supervised with Supervisor
- `amd64` or `aarch64`
- Internet access and a Google Account for Antigravity

1. In **Settings → Apps → App store → Repositories**, add:

   ```text
   https://github.com/Kanu-Coffee/antigravity-for-home-assistant
   ```

2. Install and start **Antigravity for Home Assistant**.
3. Open **OPEN WEB UI**. This Ingress terminal is available only after Home
   Assistant authentication.
4. Run:

   ```bash
   ha-antigravity-remote-login
   ```

5. Open the printed HTTPS URL in a trusted browser, sign in with the intended
   Google Account, and paste the displayed code into the terminal. Never put
   the code or authentication files in logs, screenshots, or issues.
6. Wait for the helper's authentication-complete message. The running service
   starts Remote automatically after the login process has fully exited; no
   App restart is required.
7. Sign in to the [Remote Control Dashboard](https://antigravity.google.com/)
   with the same account, then select the default `home-assistant` instance and
   a new/default project rooted at `/config`.

Remote supports starting work, monitoring progress, reviewing plans and
artifacts, and providing user input or approval. On mobile, you can optionally
install the dashboard to the home screen and use notifications provided by
Antigravity. See the
[official Remote Control documentation](https://antigravity.google/docs/remote-control/)
for upstream behavior.

Missing or expired authentication does not fail the whole App. Remote waits and
Ingress remains available so the helper can be run again. The App and Remote
daemon start automatically again after a HAOS reboot.

## Configuration

Version 3.0 exposes only four public options.

| Option | Default | Meaning |
| --- | --- | --- |
| `remote_control_name` | `home-assistant` | Instance name shown in the Remote Dashboard |
| `antigravity_sensitive_data_access` | `false` | Permit read-only Recorder DB access only in the diagnostic profile |
| `home_assistant_browser_auto_auth` | `true` | Manage an App-local, read-only dashboard identity |
| `log_level` | `info` | App service log level |

Use 1–63 lowercase letters, digits, or `-` for `remote_control_name`, starting
and ending with a letter or digit. Restart the App after changing an option.

`antigravity_sensitive_data_access` does not grant general privilege or permit
Recorder writes. Enable it temporarily only when necessary for diagnosis, and
assume results can contain personal data.

## Workspace and tools

The default workspace is `/config`; `/share` and `/media` are also available
inside the App. The image-managed Home Assistant plugin provides:

- bounded reads of states, services, registries, traces, logs, and system info;
- `ha-config-check` and validation helpers;
- bounded ordinary project-file reads and writes;
- dashboard browser inspection;
- verified memory; and
- `/ha-feedback` report preparation.

Start by requesting inspection and a plan only. Review the diff and validation
method before allowing changes. See the [prompt examples](../docs/examples.en.md).

### Dashboard browser

With `home_assistant_browser_auto_auth: true`, the App creates or reuses a
browser-only, local read-only Home Assistant identity. It does not replace a
normal user account or the Remote Google Account.

```bash
ha-browser-auth-status
ha-browser-auth-remove
```

Disabling the option shows the normal Home Assistant login page in the next
browser session. Run `ha-browser-auth-remove` to delete the managed identity.
Screenshots, console output, network output, and entity state can be sensitive;
do not attach them unchanged to public reports.

### Verified memory

Memory is stored in `/data/antigravity-ha-memory/memory.sqlite3`. It does not
automatically retain current state or logs. Only user-stated aliases, purposes,
and preferences, or Home Assistant structure supported by evidence, move
through the candidate → verify → apply flow.

```bash
ha-memory status
ha-memory search 'kitchen'
```

`empty`, `stale`, and `degraded` are distinct. Check status first, then compare
the App log with Core state from the same time.

### Feedback

Use `/ha-feedback` from a Remote task or Ingress for App bugs and feature
requests. The initial request authorizes read-only investigation and preparation
of a public-safe report, not external submission.

```text
/ha-feedback bug describe the reproducible symptom and impact in one or two sentences
/ha-feedback feature describe the needed behavior and use case in one or two sentences
```

Review the generated report for personal data and credentials. If investigation
indicates a security issue, stop public search and submission and use
[private vulnerability reporting](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/security/advisories/new).

## Permissions and security

Antigravity native fine-grained permissions are the single approval UI. Rules
are evaluated in `deny > ask > allow` order. An `ask` operation waits for a user
decision in Remote; the App does not add a channel-specific approval protocol.
Review native behavior in the
[official permissions documentation](https://antigravity.google/docs/cli/permissions/).

AppArmor is an independent final OS boundary and cannot be disabled by an App
option. It enforces:

- protection of Home Assistant `secrets.yaml`, `.storage`, backups, SSL, and
  credential paths;
- no model access to Google OAuth, App runtime tokens, browser tokens, or
  private keys;
- no writes to Recorder or Home Assistant databases;
- no Docker socket, host root/PID namespace, or unprotected mode;
- no broker bypass through symlinks, hardlinks, or out-of-scope paths.

The Supervisor token stays in a root-owned runtime path and is used only by a
scoped helper. It is not passed to the ordinary Antigravity model, browser, or
memory processes. API helpers return only bounded, redacted results.

The Remote daemon binds one available port in `4400–4499` on App-internal
`127.0.0.1`. The App publishes no external Remote port. Ingress is also a
recovery surface behind Home Assistant authentication, not the normal external
control channel.

## 3.0.0 transition

Version 3.0.0 is an intentional breaking upgrade. On its first start, it resets
fixed App-owned paths **once and without a backup**.

The exact deletion targets are:

```text
/data/home
/data/antigravity
/data/antigravity-ha
/data/antigravity-ha-memory
/data/browser-auth
/data/github-cli
/data/ssh
/data/tmux
```

It does not delete:

- `/config`, `/share`, or `/media`;
- the `/data/options.json` file itself; or
- Home Assistant Core data or another App's data.

Supervisor options are normalized to the four new defaults, removing retired
options. If the Supervisor request is temporarily unavailable, runtime uses only
the four defaults and retries option normalization on a later start. Data-reset
completion is recorded with an atomic marker. If interrupted, the next start
safely retries the same fixed targets. If a target is a symlink or has
unexpected ownership, the App stops instead of deleting it.

After reset, run `ha-antigravity-remote-login` again. GitHub connection,
managed browser identity, local memory, and Antigravity customizations also
start empty. Automations, dashboards, and user files under `/config` remain,
but create a Home Assistant backup before upgrading anyway.

Downgrading from 3.0 is not an automatic, lossless recovery path. Restore an
App backup made by the target version if needed; do not combine runtime data
from different versions.

## Troubleshooting

### The first conversation fails with `file does not exist`

The one-time 3.0 reset also removes App-owned Antigravity project files. If the
Remote Dashboard keeps sending a project selection from before the reset, the
first conversation can fail with HTTP 500 `file does not exist`.

1. Do not delete the OAuth token or `/data`; close the failed conversation.
2. If this follows first authentication, restart the App once and wait 5–10
   seconds for the instance to come online. This separates the login instance
   from the persistent instance, but it does not clear the saved project choice.
3. Explicitly select the intended instance and a newly created valid project,
   or start a new conversation outside the old project. Do not resume the old
   project or failed conversation.
4. A normal refresh preserves the selection in browser local storage. If the
   UI cannot switch to a valid project, reset the Remote Dashboard's stored
   site data, then start again in a new project rooted at `/config`.

Memory refresh warnings in the App log and the
`home_assistant_browser_auto_auth` option are unrelated to this Remote project
error. Do not inspect or share authentication files, codes, or token contents.

### Remote instance is missing

1. Confirm the App is running and has Internet access.
2. Confirm the dashboard and helper use the same Google Account.
3. Rerun `ha-antigravity-remote-login` in Ingress.
4. After success, inspect only non-secret status messages in the App log.
5. Confirm `remote_control_name` is valid and distinguishable from other
   instances.

During a temporary network interruption, running work can continue while the
host process remains alive. The dashboard reconnects when connectivity returns.

### Ingress does not open

- Recheck the App state and Ingress URL in Home Assistant.
- Inspect the first failure in the App log. If reset safety checks rejected a
  target, do not delete paths manually; prepare a public-safe diagnostic report.
- Do not bypass the problem by disabling protection or adding host mounts.

### Browser or memory fails

- Use `ha-browser-auth-status` and `ha-memory status` to distinguish
  `disabled`, `empty`, `stale`, and `degraded`.
- Restart the App and use a new browser session after changing the related
  option.
- Keep real HAOS evidence separate from container-fixture results.

## Updates and support

Before updating, read release notes for breaking versions, reset behavior,
architectures, and HAOS evidence. Source tests, container smoke, and emulated
architectures are not real HAOS evidence. Unperformed device checks remain
`NOT RUN`; incomplete checks remain `PARTIAL`.

See [SUPPORT.md](../SUPPORT.md) for support, [CHANGELOG.md](CHANGELOG.md) for
public changes, and [development documentation](../docs/development/README.md)
for the implementation contract.
