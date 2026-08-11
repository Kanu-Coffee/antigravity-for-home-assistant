---
name: home-assistant-operations
description: Inspect or safely operate the live Home Assistant instance through image-managed API and log helpers. Use for Home Assistant entities, configuration, registries, automations, logs, or Supervisor diagnostics.
---

# Home Assistant operations

Start with a bounded `memory_search` for the current question and named
subjects. Use `ha-api` for Core, `supervisor-api` for Supervisor, and the
dedicated log helpers instead of constructing authorization headers.
When MCP tools are available, prefer the bounded `ha_read_*` projections for
config, state, registry, history, trace, and logs. Use `ha_validate_config`
without activation and `ha_verify_state` for a fresh exact-state comparison.

Keep diagnosis observational. Before a persistent configuration, registry, or
automation mutation, record the affected subjects and supported expectations
with `memory_begin_change`. After the edit and any required reload, run
`ha-config-check` and verify fresh API state with `memory_verify_change`.

Never expose secrets or directly edit `.storage`. Ask for explicit current
confirmation before safety-critical, destructive, restart, restore, update, or
removal operations.
