# 3.0 architecture

## Runtime shape

```text
Remote Control Dashboard
          │ official authenticated connection
          ▼
Antigravity Remote daemon ── native permissions ── agent/tool processes
          │                                      │
          │                                      ├─ /config, /share, /media
          │                                      ├─ scoped HA read/validate helpers
          │                                      ├─ verified memory
          │                                      └─ managed dashboard browser
          │
          └─ 127.0.0.1:4400–4499 only

Home Assistant Ingress ── terminal ── login / diagnostics / recovery
Supervisor token ── root-only runtime file ── scoped credentialed helper
```

The App supervisor starts independent S6 services. Failure of optional browser,
memory, or Remote authentication must not hide Ingress. Required service
crashes use bounded restart behavior and leave a non-secret diagnostic reason.

## Remote lifecycle

- The launcher validates `remote_control_name`, selects one available loopback
  port from `4400–4499`, and starts the pinned Antigravity CLI Remote mode.
- It never binds a wildcard address or adds a Home Assistant published port.
- Without a valid authentication artifact, it waits while the rest of the App
  stays healthy.
- `ha-antigravity-remote-login` requires an interactive TTY and runs the
  official URL/code sign-in. The service polls for the completed artifact and
  starts Remote immediately.
- Authentication and instance names are never included in diagnostic payloads.
- Automatic CLI self-update is disabled; the image owns the exact CLI binary
  and digest for both architectures.

## Data ownership

| Data | Owner and behavior |
| --- | --- |
| `/config`, `/share`, `/media` | Home Assistant/user-owned mounts; never reset by the App |
| Antigravity authentication/settings | App-owned, private, reset at the 3.0 boundary |
| Browser identity | App-owned local read-only account material |
| Memory database | App-owned verified HA context, not a copy of current state |
| Supervisor credential | Root-owned ephemeral runtime material, consumed only by scoped helper |
| Image-managed plugin | Replaced from the image; user customization outside its managed area is not merged during reset |

At first start, defaults are created only when user files do not exist. Later
starts preserve valid user files and update only image-managed plugin content.
There are no user-selectable refresh/reset modes after the one-time 3.0 reset.

## Home Assistant access

The ordinary agent receives project mounts but not the Supervisor token. A
credentialed helper obtains only the Core/Supervisor data required for its
bounded operation and returns capped, redacted output. Mutation follows native
permission decisions plus the OS policy; there is no second approval state
machine.

The managed browser uses an App-local read-only Home Assistant identity when
enabled. Browser authentication, memory, and feedback are separate failure
domains so one degraded component does not erase or reset another.

## Upgrade transactions

The transition uses two independent idempotent transactions. First, the data
reset resolves each fixed path, checks type/ownership, deletes only the approved
roots, and atomically records data-reset completion. It is safe across an
interrupted deletion prefix. Second, the option reset submits the fixed
four-option document through the Supervisor API and writes its own atomic marker
only after Supervisor accepts it. If that credentialed request is unavailable,
the App exposes only default values internally and retries the option reset on a
later start. Neither transaction expands a glob, follows a symlink, or derives a
deletion target from user input.
