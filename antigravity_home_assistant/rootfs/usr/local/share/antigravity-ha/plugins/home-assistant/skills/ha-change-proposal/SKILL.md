---
name: ha-change-proposal
description: Create a bounded, short-lived Home Assistant change preview through the image-managed proposal-only MCP. Use for every mutation requested through the Telegram agent.
---

# Home Assistant change proposal

Use only `ha_change_propose` to describe a requested persistent configuration
change, persistent allowlisted on/off `service_call`, or transient
`device_test`. Do not supply or invent requester
fields: the image-managed bridge binds the authenticated Telegram user and
chat through the MCP process environment, outside model-controlled arguments.

Show the returned preview, risk, expiry, and preview digest without modifying
them. This MCP cannot authorize or execute a proposal. Never try to replace the
trusted bridge confirmation flow with a shell command, direct file write,
Home Assistant API call, or a second tool. If the broker rejects the proposal
or is unavailable, report that no change was made.

Use `device_test`, never `service_call`, when the user asks to briefly exercise
one `light`, `switch`, or `input_boolean`. Supply only `turn_on` or `turn_off`,
the exact entity ID, and a freshly read `expected_prior_state`. The requested
test state must differ from that prior state. Treat every device test as high
risk and show the broker-generated test and mandatory restore plan. Success is
valid only when the broker freshly verifies the test state, always calls the
prior-state restore service, and freshly verifies restoration. If restoration
is failed or uncertain, report the durable `rollback_failed`/`in_doubt` result;
never retry through a direct service call or claim the prior state was restored.

For an executable YAML proposal, v2 currently supports only a root-level file
referenced by the single canonical
`input_boolean: !include <file>.yaml` declaration. Supply
`activation: {"kind":"input_boolean_reload"}`. The broker accepts only its
restricted flat helper schema, derives the affected entity expectations itself,
calls `input_boolean.reload`, and requires `memory_begin_change` plus fresh API
`memory_verify_change`. Automation, script, scene, theme, package, inline, and
other YAML replacements may be previewed but have no executable activation
contract; do not describe them as applied.
