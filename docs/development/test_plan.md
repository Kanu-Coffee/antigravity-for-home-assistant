# 3.0 test plan

## Evidence rules

Run the smallest applicable layer first: static contract, unit/component,
container, architecture packaging, then real HAOS. Record the exact command,
source revision, immutable image digest, architecture, environment, result, and
unverified scope.

Fixtures, containers, and emulation cannot satisfy real-HAOS acceptance.
Unperformed device checks are `NOT RUN`; incomplete coverage is `PARTIAL`.

## Recorded operational evidence

A user-provided, read-only self-check of one production App `3.0.0` instance at
`2026-08-31T23:22:00Z` reported all seven observed categories as `PASS`:

1. Remote connection;
2. `/config` workspace access;
3. managed Home Assistant read, validation, and file tools;
4. Ingress response and managed browser configuration;
5. persistent memory configuration;
6. no dependency on the retired Telegram or SSH channels; and
7. sensitive-path denial and the expected permission boundary.

This is valid operational evidence for exactly that reported instance and time.
The report does not state CPU architecture, immutable image digest, Git revision,
or HAOS, Core, and Supervisor versions. It also predates 3.0.2 and does not prove
every tool invocation, reboot persistence, or long-duration stability. Therefore
it does not satisfy an architecture-specific 3.0.2 release gate; those results
remain `NOT RUN` until separately recorded against the immutable release image.

## Source and component coverage

### Remote lifecycle

- `REM-01`: Valid and invalid instance-name boundaries.
- `REM-02`: Deterministic scan of `127.0.0.1:4400–4499`, collision handling,
  exhaustion failure, and no wildcard bind.
- `REM-03`: Missing authentication waits without failing Ingress; completed
  interactive login starts Remote without an App restart.
- `REM-04`: Process crash restarts within the S6 policy; persisted login starts
  after App/HAOS reboot.
- `REM-05`: Logs and status contain no code, token, account identifier, or
  authentication payload.
- `REM-06`: `amd64` and `aarch64` contain the exact pinned CLI version and
  digest, Remote flag support, and disabled self-update.

### Breaking reset and options

- `RST-01`: Fresh install and 2.1.3 upgrade both converge on the four-option
  schema and perform the reset exactly once.
- `RST-02`: The eight exact App-owned roots are removed; `/config`, `/share`,
  `/media`, and `/data/options.json` itself are preserved.
- `RST-03`: Interruption at every transaction boundary is safely retried and
  records completion only after success.
- `RST-04`: Symlink, resolved-path mismatch, foreign owner, and unexpected type
  fail closed without deleting the target.
- `RST-05`: Authentication, browser identity, memory, submission credentials,
  and customization start empty; discarded options cannot reappear.

### Retained capabilities and security

- `REG-01`: Ingress, configuration validation, HA reads, bounded file work,
  memory, browser auto-auth, and `/ha-feedback` pass focused regression suites.
- `SEC-01`: Supervisor credential ownership and process-environment canaries
  prove the ordinary model never receives it.
- `SEC-02`: AppArmor parser plus enforced smoke deny secrets, OAuth/token/key
  paths, database writes, out-of-scope links, and credential process data.
- `SEC-03`: Native permission precedence and Remote `ask` interaction work
  without a second approval database or execution path.
- `SEC-04`: Logs, status, browser artifacts, memory, and reports pass secret
  scanning and bounded-output checks.
- `DOC-01`: Active docs and configuration describe only Remote plus Ingress,
  the four options, exact reset, and current security model; internal links and
  Markdown lint pass.

## Image and architecture checks

- Build `linux/amd64` and QEMU `linux/arm64` images through the repository build
  helper.
- Verify the S6 service graph, image labels/version, App metadata, AppArmor
  compilation, executable modes, checksums, and source-rootfs manifest.
- Run the applicable Docker smoke suites on amd64 and emulated arm64 while
  labelling both as non-HAOS evidence.
- Run secret and supply-chain checks when release inputs, credentials, or
  dependencies change.

## Real HAOS acceptance

On both architectures where hardware is available, record separately:

1. Fresh 3.0 install, healthy Ingress, interactive login, Dashboard appearance,
   task start, native approval, and result review.
2. Public 2.1.3 → 3.0 upgrade, exact reset boundary, `/config` preservation, new
   option normalization, and required reauthentication.
3. App restart and HAOS reboot reconnect from stored authentication.
4. Configuration read/change/check, Core/Supervisor helper, memory, managed
   browser, and feedback regression.
5. Enforced AppArmor secret denies and optional read-only sensitive-data mode.
6. Network interruption/reconnect, invalid authentication recovery, rollback
   from a version-matched Home Assistant App backup, and clean uninstall.

Do not publish a successful support claim while any required scenario for that
claim remains `PARTIAL` or `NOT RUN`.
