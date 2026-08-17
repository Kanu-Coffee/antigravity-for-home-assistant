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

Keep diagnosis observational. Telegram, Web terminal, and SSH use the same
native HOME, global customization, permission policy, and mandatory AppArmor
runtime/command boundary; only their approval transport differs. In a
requester-bound Telegram session, route every
Home Assistant service call and YAML configuration mutation through
`ha_change_propose`, so the bound user receives the broker preview and
confirmation card. Do not bypass that path with `ha-api`, `supervisor-api`, a
shell command, or a direct file write; the broker owns config checks, backup,
rollback, reload, and supported memory verification.

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
`artifactReviewPolicy` keys and commits other settings atomically.

The broker does not currently implement destructive Supervisor lifecycle
operations such as Core/host restart, update, restore, App removal, or backup
deletion. Use a generic Supervisor helper for one of those only when the
authenticated user explicitly requested that exact operation in the current
conversation, and disclose that this path has no separate inline approval card.
Otherwise stop and ask for current confirmation.

Never expose secrets or directly edit `.storage`. Ask for explicit current
confirmation before safety-critical, destructive, restart, restore, update, or
removal operations.
