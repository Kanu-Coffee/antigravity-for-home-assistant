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
Respect Antigravity's native tool permission result; do not bypass a denial or
approval request through another helper. For an exact mutation explicitly
requested in the current conversation, use the supported API or file tools.
For YAML, preserve exact prior bytes, write atomically, run `ha-config-check`,
and restore and recheck on failure. Verify service calls and persistent changes
with a fresh read. Never infer a mutation from a diagnostic request.

The native nested-namespace sandbox is unavailable in an unprivileged HAOS
App. All sessions instead share the mandatory AppArmor runtime/command
boundary. Manage tool access with Antigravity's native permission interface;
never rewrite settings to bypass a denied or approval-required operation.

Never expose secrets or directly edit `.storage`. Ask for explicit current
confirmation before safety-critical, destructive, restart, restore, update, or
removal operations.
