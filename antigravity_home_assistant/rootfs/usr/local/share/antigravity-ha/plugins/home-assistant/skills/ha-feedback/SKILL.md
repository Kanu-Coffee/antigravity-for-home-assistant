---
name: ha-feedback
description: Prepare privacy-safe, evidence-based bug reports and feature proposals for Antigravity for Home Assistant. Use when the user reports an App bug, proposes an App feature, or invokes /ha-feedback.
---

# Home Assistant App feedback

Use the native Antigravity slash command `/ha-feedback bug <symptom>` or
`/ha-feedback feature <request>` for the matching workflow. For a natural
language request, infer bug or feature only when the intent is clear.

Keep validation observational. Never modify Home Assistant configuration,
registries, dashboards, devices, automations, or App data as part of feedback
collection. Do not reload, restart, update, restore, install, remove, or call a
Home Assistant service. A finding is not authorization to repair.

Use `/usr/local/bin/ha-feedback` as the only report and GitHub workflow helper;
never call `gh` directly. Put structured input in a private `0600` temporary
JSON file, not a command argument. Run exactly one matching collection command:

```text
/usr/local/bin/ha-feedback collect bug --input <private-json-path>
/usr/local/bin/ha-feedback collect feature --input <private-json-path>
```

Remove the temporary input after collection. Validate and render the returned
report with the helper. Separate observed facts from inference, explicitly mark
unknown and unexecuted checks, and never invent versions, reproduction,
evidence, or results. Never collect or attach raw logs, screenshots,
configuration, credentials, URLs, IPs, entity identifiers, or other private
Home Assistant data by default.

If the report may involve a vulnerability, authentication or authorization
bypass, credential exposure, or unsafe cross-user access, mark it as a security
issue and stop every public candidate-search, preview, URL, and submission
step. Direct the user to the repository's private vulnerability reporting
path.

For a safe public report, first run `github status`, then run `github submit`
without `--confirm` to generate a preview. Show candidate issues and the exact
final repository, title, label, and complete body. Require explicit
confirmation of that exact payload in the current user turn. Only then may you
pass the helper's private, short-lived token to:

```text
/usr/local/bin/ha-feedback github submit <report> --confirm <token>
```

Never retry an uncertain or failed direct submission automatically. If direct
submission is unavailable, use the helper's Web Form URL only after the same
payload confirmation and let the user perform the final browser submission.
