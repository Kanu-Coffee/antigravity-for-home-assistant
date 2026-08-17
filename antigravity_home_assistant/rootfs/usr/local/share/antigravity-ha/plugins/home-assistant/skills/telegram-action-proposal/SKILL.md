---
name: telegram-action-proposal
description: Register a requester-bound terminal command, script, multi-choice command, or finite question for Telegram confirmation. Use whenever a Telegram request needs a non-Home-Assistant side effect or inline choice.
---

# Telegram action proposal

In a requester-bound Telegram session, use only
`telegram_action_propose` for terminal commands, inline shell scripts,
mutually exclusive terminal actions, and finite questions. Do not call
`run_command`, a native write tool, URL execution tool, interactive browser
tool, or mutation-capable MCP first. The native headless permission failure is
not an approval request and cannot be resumed.

Choose exactly one operation:

- `terminal_command` for one complete `command` or inline `script`, a canonical
  approved `cwd`, and a bounded timeout.
- `multi_choice_terminal` for 1 to 31 fully specified command/script choices.
  Every `choice_id` and label must be unique; every choice is validated and
  digest-bound before the card is sent.
- `question` for 1 to 31 informational choices that require no side effect.

Keep the summary and card labels concise. Never include credentials, tokens,
authorization headers, secret paths, environment dumps, or values from
`secrets.yaml` or `.storage`. Do not use a command or script to read or modify
those protected locations.

The MCP only registers a proposal and returns an opaque proposal ID and public
preview. That response does not mean the user approved or the action ran. End
the proposal turn without executing a second tool. The trusted bridge binds the
proposal to the Telegram requester, session generation, update, Antigravity
conversation, exact source digest, and expiry; it then renders the inline card.

After a button click, continue only from the bridge-provided sealed result. Do
not infer a choice from callback text, accept new parameters, recreate a shell
command, or dispatch a committed action again. Report `denied`, `expired`,
`failed`, or `in_doubt` exactly; never claim completion from intent or partial
output. If the proposal tool rejects the operation or the bridge cannot
represent it, report that no action ran and do not bypass the approval path.
