# 3.0 product specification

## Product goal

Antigravity for Home Assistant installs Google Antigravity inside HAOS so a
trusted administrator can inspect and change the real Home Assistant project
from the official browser-based Remote Control Dashboard. The product favors a
small, observable runtime over custom remote transport and approval machinery.

## Supported workflow

1. The administrator installs the App on `amd64` or `aarch64` HAOS/Supervised.
2. Ingress remains available for one-time authentication and recovery.
3. `ha-antigravity-remote-login` performs the official interactive URL/code
   Google sign-in.
4. The running service detects authentication and starts the Remote daemon;
   no restart is required.
5. The administrator uses the same Google Account at
   <https://antigravity.google.com/>, selects the instance, and manages tasks.
6. After an App or HAOS restart, valid stored authentication starts Remote
   automatically.

Missing authentication is a healthy waiting state, not an App startup failure.
The daemon binds only App-internal loopback and publishes no external port.

## User-visible capabilities

- Project work in `/config`, `/share`, and `/media`.
- Bounded Home Assistant Core/Supervisor reads and configuration validation.
- Managed browser inspection of dashboard desktop/mobile UI, console, and
  network behavior.
- Local verified memory for user-stated or evidence-backed HA context.
- `/ha-feedback` for read-only bug investigation and feature-report drafting.
- Ingress diagnostics and recovery when Remote is unavailable.

## Public options

| Option | Default | Contract |
| --- | --- | --- |
| `remote_control_name` | `home-assistant` | 1–63 lowercase letters, digits, or `-`, beginning and ending alphanumeric; applied on service start |
| `antigravity_sensitive_data_access` | `false` | Opt-in, read-only Recorder diagnosis; never permits DB writes |
| `home_assistant_browser_auto_auth` | `true` | Manage an App-local read-only dashboard identity |
| `log_level` | `info` | One of the App's schema-defined log levels |

No additional compatibility options are accepted in the 3.0 schema. Supervisor
options are normalized to these four defaults during the transition. Until the
credentialed Supervisor request succeeds, runtime services see only the four
defaults and the request is retried on a later start.

## 3.0 breaking reset

The first 3.0 start deletes these fixed App-owned roots once, without backup:

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

It preserves `/config`, `/share`, `/media`, and the `/data/options.json` file
itself. Before deletion, every target must resolve to the exact fixed path, must
not be a symlink, and must satisfy the expected ownership check. An unsafe
target stops startup. Completion uses an atomic marker; interruption safely
retries the same operation on the next start.

The reset intentionally removes all App-side authentication, customization,
browser identity, memory, and feedback submission state. The user authenticates
and configures retained features again from an empty state.

## Acceptance criteria

- An authenticated instance appears under its configured name and accepts a
  task from a browser without a published App port.
- A missing or expired login leaves Ingress usable and can be repaired with the
  interactive helper.
- A restart reconnects automatically from valid authentication.
- Native permission prompts and results are visible in Remote.
- `/config` and the other user mounts survive both fresh install and 3.0 reset.
- Browser, memory, feedback, read helpers, and configuration checks retain
  their bounded behavior.
- Secrets and privileged credentials remain inaccessible to the model process.
