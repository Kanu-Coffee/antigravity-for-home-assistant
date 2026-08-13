---
name: ha-feedback-development
description: Validate Antigravity for Home Assistant bug or feature feedback from a source checkout without live HAOS access. Use when investigating an App issue locally, building a sanitized feedback fixture, or checking report validation and rendering before real-device reproduction.
---

# HA Feedback Development

Use the repository-scoped `tools/development/ha-feedback` helper. It invokes the
current image-managed feedback implementation in isolated test mode, so local
validation stays aligned with the shipped format without pretending the host is
a live Home Assistant App.

## Workflow

1. Classify the request as a bug or feature and inspect only the relevant source,
   tests, and sanitized evidence.
2. Create a private input JSON file with mode `0600`. Use synthetic identifiers;
   never copy credentials, entity IDs, chat IDs, prompts, or raw HAOS logs into a
   fixture.
3. Collect a managed local report:

   ```bash
   tools/development/ha-feedback collect bug --input /private/path/input.json
   ```

   Replace `bug` with `feature` when appropriate.
4. Validate and render using the path returned by collect:

   ```bash
   tools/development/ha-feedback validate <report-path>
   tools/development/ha-feedback render <report-path>
   ```

5. Report the local checks separately from anything that remains unverified on
   real HAOS. Test mode metadata is never live-device evidence.

## Boundaries

- GitHub operations are disabled and rejected by the development helper. Do not
  substitute another CLI or API to publish a report.
- The helper supports only `collect`, `validate`, and `render`.
- It receives no Supervisor token, Home Assistant configuration, live App data,
  or ambient GitHub credentials.
- Security reports remain private and require the runtime review workflow.
- When actual HAOS behavior is material, keep the result `NOT RUN` until tested
  in the installed App.
