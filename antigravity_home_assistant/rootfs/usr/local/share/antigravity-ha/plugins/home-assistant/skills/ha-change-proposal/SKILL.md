---
name: ha-change-proposal
description: Create a bounded, short-lived Home Assistant change preview through the image-managed proposal-only MCP. Use for broker-confirmed mutations requested through the authenticated Telegram transport.
---

# Home Assistant change proposal

Use only `ha_change_propose` to describe a requested persistent configuration
change, a currently registered Home Assistant `service_call`, or transient
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

For a `service_call`, supply the exact currently registered domain/service,
optional `entity_id`, and bounded plain-JSON `service_data`. Use
`return_response: true` when that service requires REST response data. Use
`expected_state` plus `verify_state` only when one entity has an exact state
precondition and postcondition. Other services are reported as completed only
after the Home Assistant REST call returns; do not invent a state verification.
Every service proposal requires confirmation through the bound Telegram card.
Credential-like service fields remain executable when the requested service
needs them, but the broker redacts their values from the card and binds the
complete payload into the approval digest.

YAML replacements are executable after Telegram confirmation when their fresh
expected SHA matches. The broker creates an atomic backup, writes atomically,
runs the Home Assistant configuration check, and restores and rechecks the
exact prior bytes on failure. Supply `input_boolean_reload` for the canonical
input_boolean include contract with semantic verification, or
`automation_reload`, `script_reload`, or `scene_reload` when that exact reload
is appropriate. Omit activation when no safe reload is known; a successful
checked write then reports `restart_required`. Never target `secrets.yaml`,
`.storage`, hidden/sensitive directories, or a non-YAML file.
