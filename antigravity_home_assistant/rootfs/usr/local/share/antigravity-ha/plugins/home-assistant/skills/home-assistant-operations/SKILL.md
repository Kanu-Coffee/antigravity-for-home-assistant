---
name: home-assistant-operations
description: Inspect or safely operate the live Home Assistant instance through image-managed API and log helpers. Use for Home Assistant entities, configuration, registries, automations, logs, or Supervisor diagnostics.
---

# Home Assistant operations

Start with a bounded `memory_search` for the current question and named
subjects. Use the dedicated read and log helpers instead of constructing
authorization headers.
When MCP tools are available, prefer the bounded `ha_read_*` projections for
config, state, registry, history, trace, and logs. Use `ha_validate_config`
without activation and `ha_verify_state` for a fresh exact-state comparison.
For reports of HAOS storage growth, start with `ha_read_storage_usage`. Treat
its fixed `system`, `apps_data`, `apps_config`, `media`, `share`, `backup`,
`ssl`, and `homeassistant` byte categories as classification evidence, not as a
Docker image or build-cache inventory. Normal App updates use a prebuilt image,
and Supervisor owns old-image cleanup. Correlate unexplained `system` growth
with Supervisor update/cleanup logs. Never mount or query the Docker socket,
run a host-wide Docker prune, or invoke Supervisor repair automatically;
repair is a broad administrator recovery action, not per-update maintenance.

Keep diagnosis observational unless the user explicitly requests a change.
Telegram, Web terminal, and SSH use the same native HOME, global customization,
permission policy, and mandatory AppArmor blacklist. In a requester-bound
Telegram session using `request-review`, route every
Home Assistant service call and YAML configuration mutation through
`ha_change_propose`, so the bound user receives the broker preview and
confirmation card. Do not bypass that path with `ha-api`, `supervisor-api`, a
shell command, or a direct file write; the broker owns config checks, backup,
rollback, reload, and supported memory verification.

For any other `request-review` Telegram side effect, including a terminal
command, inline shell script, or a choice among prevalidated commands, use
`telegram_action_propose`. Use its `question` operation for a finite choice that
does not itself execute a Home Assistant change. A successful MCP response only
registers the action; it never authorizes execution. Wait for the bridge's
sealed continuation after the requester clicks the inline card. Direct
`run_command`, write, URL, interactive-browser, and mutation MCP calls are not
Telegram approval mechanisms and must not be used as fallbacks.

When the requested Telegram mutation has several mutually exclusive valid
answers, use one `multi_choice_service_call` proposal instead of asking the
user to type an unbound answer and then constructing a new change. The card may
contain up to 31 prevalidated choices plus one cancel button. Only the opaque
button token selected by the same requester/session is accepted; never derive
service parameters from callback text.
If the full App or change broker restarts before execution is accepted, the
in-memory proposal is gone and the old card must fail closed; ask for a new
request. Do not confuse this with a bridge-only restart while the broker remains
alive or with durable recovery of an execution the broker already accepted.

In an authenticated interactive Web-terminal or SSH session without a Telegram
requester binding, the proposal MCP cannot address a confirmation card. For an
exact mutation the user explicitly requested in the current conversation, use
the shared API helpers or file tools under the same native permission and
AppArmor policy. For YAML, preserve the exact prior bytes, write atomically, run
`ha-config-check`, and restore and recheck on failure. Never infer a mutation
from a diagnostic request.

The native nested-namespace sandbox is unavailable in an unprivileged HAOS
App. All channels instead share the mandatory AppArmor runtime/command
boundary. Never write native `settings.json` directly. For an exact user
request to change global Antigravity settings, obtain the current digest with
`agy-settings sha256` and pipe an object with `expected_sha256` and `patch` to
`agy-settings patch`. The helper rejects App-owned `permissions`,
`enableTerminalSandbox`, `allowNonWorkspaceAccess`, `toolPermission`, and
`artifactReviewPolicy` keys. It atomically updates only `altScreenMode`,
`clearScrollbackOnResize`, `colorScheme`, `disableSlashCommands`,
`modelProvider`, `showFeedbackSurvey`, and `showTips`; `enableTelemetry`
accepts only `false` for a privacy-strengthening opt-out. `null` may remove a
non-protected top-level stale setting except `enableTelemetry`. Unknown
non-null settings and object or array values are rejected.

If a `request-review` Telegram side effect cannot be represented by
`ha_change_propose` or `telegram_action_propose`, report that limitation and
stop. Never bypass its inline approval path with a generic Supervisor helper or
another direct tool. When the App is explicitly configured for
`always-proceed`, ordinary requested reads, writes, commands, URL operations,
and installed MCP tools may run directly; protected credential/policy paths and
`.storage` remain unavailable, and high-risk actions still require an explicit
current request.

Never expose secrets or directly edit `.storage`. Ask for explicit current
confirmation before safety-critical, destructive, restart, restore, update, or
removal operations.
