# Antigravity Remote prompt examples

[Project README](../README.en.md) · [User guide](../antigravity_home_assistant/DOCS.en.md)

A Remote task can access the real `/config` project and Home Assistant APIs.
Start with read-only investigation and a plan. Review the backup, diff, and
validation method before a change.

## Configuration review

```text
Inspect the current /config project in read-only mode.
Find syntax errors, references to missing entities, and duplicate automation candidates.
Show the supporting file and line. Do not modify files or call services yet.
```

```text
Classify recurring Core log errors without exposing credentials.
Propose checks for the three highest-impact causes and label every inference.
```

## Controlled change

```text
Design an automation that turns on the kitchen light only after sunset and on motion.
First inspect current entities and automations and explain conflicts.
Before applying, show the exact diff and rollback method and wait for my approval.
After applying, run ha-config-check and verify fresh state.
```

```text
Preserve the current dashboard structure and propose a one-column mobile layout.
Inspect desktop and mobile views plus console and network failures.
Show only the screenshot summary and change plan first.
```

When Antigravity native permissions classify work as `ask`, Remote displays the
approval UI. Review the target, command, file, and scope before approving.

## Browser inspection

```text
Inspect the Home dashboard at desktop and mobile viewports in read-only mode.
Summarize overlap, clipping, empty cards, console errors, and failed network requests.
Do not infer real-device performance from browser evidence alone.
```

Names, locations, state, and screenshots can contain personal data. Review
redaction before publishing results.

## Memory

```text
Remember that “main kitchen light” means light.kitchen_main.
Check for conflicting memory first and summarize the stored provenance.
```

```text
Check memory health and show only stale or conflicting items.
Do not promote temporary state or log observations into durable memory.
```

User-stated aliases, purposes, and preferences can become explicit memory.
Discovered structure must collect evidence and pass verification before apply.

## Bug and feature feedback

`/ha-feedback` investigates a bug or feature request about this App in read-only
mode and prepares a public-safe report. The first request authorizes
investigation and report preparation, not external submission.

```text
/ha-feedback bug investigate why the Remote instance does not appear after an App reboot and describe the impact.
```

```text
/ha-feedback feature assess a single summary artifact for browser diagnostics.
```

The report should contain reproduction steps, expected and actual behavior,
impact, public-safe evidence, and checks performed. Candidate issue search and
external submission require a separate confirmation in the current turn. If
the evidence indicates a vulnerability, authentication bypass, or credential
exposure, stop every public candidate-search and submission and use
[private security reporting](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/security/advisories/new).

## 3.0 reset review

```text
Check the completed 3.0 transition in read-only mode.
Verify that /config, /share, and /media remain and only the four new options are present.
Do not print authentication-file contents or tokens.
```

Keep real HAOS results separate from source, container, and emulated evidence.
Record unperformed checks as `NOT RUN` and incomplete checks as `PARTIAL`.
