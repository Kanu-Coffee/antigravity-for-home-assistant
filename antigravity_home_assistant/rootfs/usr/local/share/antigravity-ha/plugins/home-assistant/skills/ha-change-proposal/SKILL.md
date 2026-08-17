---
name: ha-change-proposal
description: Create a bounded, short-lived Home Assistant change preview through the image-managed proposal-only MCP. Use for broker-confirmed mutations requested through the authenticated Telegram transport.
---

# Home Assistant change proposal

Use only `ha_change_propose` to describe a requested persistent configuration
change, a currently registered Home Assistant `service_call`, a mutually
exclusive `multi_choice_service_call`, or transient `device_test`. Do not
supply or invent requester
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

Use `multi_choice_service_call` when one requester-bound Telegram turn needs a
finite choice among mutually exclusive service calls, for example selecting an
entity, climate mode, temperature preset, light preset, or scene. Provide 1 to
31 choices. Give each choice a unique stable `choice_id` matching
`[A-Za-z0-9_-]{1,24}`, a concise UTF-8 label of at most 64 bytes, and one exact
service-call payload. Keep the prompt bounded and make every choice actionable;
do not use this mutation protocol for a purely informational question. The
broker validates and digest-binds every choice before the card is sent. The
Telegram callback contains only an opaque token, never service parameters, and
the broker executes exactly the prevalidated choice selected by the bound
requester. Never treat text in a callback or a model response as a choice ID or
execution capability.

Do not claim that an unstarted proposal survives a full App or change-broker
restart. The encrypted choice mapping can recover from a bridge-only restart
while the broker still holds the proposal; if that in-memory proposal is gone,
tell the user to make a new request instead of clicking the old card. An
execution already accepted by the broker may recover only its durable
status/result and must not be dispatched again.

YAML replacements are executable after Telegram confirmation when their fresh
expected SHA matches. The broker creates an atomic backup, writes atomically,
runs the Home Assistant configuration check, and restores and rechecks the
exact prior bytes on failure. Supply `input_boolean_reload` for the canonical
input_boolean include contract with semantic verification, or
`automation_reload`, `script_reload`, or `scene_reload` when that exact reload
is appropriate. Omit activation when no safe reload is known; a successful
checked write then reports `restart_required`. Never target `secrets.yaml`,
`.storage`, hidden/sensitive directories, or a non-YAML file.
