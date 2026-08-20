# Changelog

All notable changes to this App are documented in this file.

## [2.1.1] - 2026-08-20

### Fixed

- Install Antigravity 1.1.13's mode-specific canonical top-level settings.
  `request-review` omits `toolPermission`, while `always-proceed` retains the
  exact `"toolPermission":"always-proceed"` value; both modes omit
  `enableTerminalSandbox`. On the reported first interactive `agy` launch in
  `request-review`, the native CLI canonicalized an otherwise valid 2.1.0 file
  by removing its non-canonical `toolPermission` and
  `enableTerminalSandbox`, then replacing it through a same-directory
  temporary file. The 2.1.0 native runtime correctly denied replacement of the protected
  `settings.json`, so the TUI reported an atomic rename failure and offered to
  continue with defaults. The temporary and destination paths share the same
  directory; this was not an `EXDEV` cross-device rename failure, and 2.1.1
  does not add a non-atomic copy/unlink fallback.
- Emit and migrate Antigravity 1.1.13-compatible canonical settings bytes:
  lexicographically sorted top-level keys, known `permissions` buckets in
  native canonical order, two-space JSON indentation, and one final newline.
  `request-review` emits `allow`, `deny`, and `ask`; `always-proceed` emits
  `allow` and `deny` and omits its empty `ask`. `preserve` recognizes the exact
  App-owned 2.1.0 layout, transactionally applies the mode-specific top-level
  shape, preserves unrelated
  top-level values semantically, and becomes byte-idempotent after migration.
  The selected Telegram mode remains an App option and the installed native
  permission buckets are validated against that explicit expected mode.
- Preserve native JSON number lexemes, including integers beyond JavaScript's
  safe range, negative zero, exponent spelling, and large-exponent syntax,
  while normalizing native 1.1.13's observed default omissions. Restrict
  `agy-settings patch` to the native-stable top-level scalar UI settings listed
  in the documentation; unknown non-null keys and object/array values now fail
  before the protected file changes instead of risking another native rewrite.
  A top-level unknown key may be set to `null` only to remove stale data left by
  an older helper.
- Keep the security boundary unchanged. Both native runtime profiles still
  deny writes, links, and locks on the final native `settings.json`; native
  `read_file`/`write_file`, command, shell, OAuth, credential, and MCP-policy
  denies remain in force. No AppArmor settings-write grant, protection-mode
  bypass, broad permission, or Docker/host mount is added.
- Correct the field diagnosis for Telegram. The bot token and allowlists come
  from `/data/options.json`; the Telegram Bridge is a separate S6 service, not
  a Home Assistant Core `telegram_bot` service, and its managed proposal MCP is
  named `telegram_action`. Absence of a Core Telegram service or an MCP named
  `telegram` does not prove that the bridge is inactive. Transport and worker
  failures must instead be classified from bounded Bridge events.

### Field evidence and limitations

- Public 2.1.0 on real HAOS exposed the Web TUI settings canonicalization and
  same-directory rename failure described above; a Telegram invocation did not
  return a user response. The submitted diagnostic report did not include the
  bounded Bridge events needed to distinguish a disconnected transport from a
  connected native-worker failure. Its browser timeout and stale memory report
  also remain separate symptoms without evidence that settings caused them.
- Source, component, exact-image container, and kernel-enforced results for
  2.1.1 are automated evidence only. Real-device 2.1.1 Web TUI, enforced
  AppArmor, authenticated Telegram delivery, browser, and memory acceptance on
  amd64 and aarch64 remain `NOT RUN` before installation testing; overall v2
  acceptance remains `PARTIAL` at publication.

## [2.1.0] - 2026-08-19

### Changed

- Replace the narrow operational allowlist with an explicit operational
  blacklist. Supported ordinary work now includes `/config`, `/share`,
  `/media`, non-credential persistent HOME paths, temporary workspaces,
  ordinary system commands, installed MCP servers, the supported Core and
  Supervisor manager APIs, and bounded Host/Supervisor log projections. Raw
  logs remain unavailable; the broker removes the exact App token and known
  credential-shaped lines/blocks without claiming that arbitrary unkeyed
  application text can always be classified as non-secret.
  This is a breaking permission-policy change and `2.1.0` is added to
  `breaking_versions`.
- Keep `request-review` as the safe default: ordinary reads and managed read,
  validation, memory, and proposal tools may proceed, while writes, commands,
  URL execution, and mutation-capable tools require native review or a
  requester-bound Telegram proposal. Restore explicitly selected
  `always-proceed` as an autonomous-administrator mode for ordinary operational
  read/write/command/URL and installed-MCP work. `strict` and
  `proceed-in-sandbox` remain legacy upgrade inputs and normalize to
  `request-review`.
- Retain mandatory native and AppArmor denies in both modes for
  `secrets.yaml`, `.storage`, OAuth and cloud credentials, App/Supervisor/
  Telegram/browser/SSH tokens and keys, App-owned permission and MCP policy,
  credential-bearing process introspection, Recorder writes, raw backup/SSL/
  other-App configuration mounts, and other protected credential stores.
  Optional sensitive-data access grants Recorder diagnostics read-only; it
  never grants Recorder writes or protected credential access.
- Deny the native `read_file` and `write_file` tools globally in both modes;
  their lexical-path decision can be bypassed by a symlink alias. Route
  ordinary file work through the confined `ha_files` MCP tools
  `ha_files_list`, `ha_files_read_text`, and `ha_files_write_text`. They serve
  only `/config`, `/share`, `/media`, ordinary `/data/home`, `/tmp`, and
  `/var/tmp`, bound UTF-8 files to 1 MiB and listings to 200 entries, reject
  symbolic or multiply linked files, and use same-directory atomic writes with
  optional `expected_sha256` conflict detection.
- Keep the App inside the Supervisor-supported container boundary. Version
  2.1.0 does not request `full_access`, `docker_api`, the Docker socket, a host
  root or host PID mount, privileged capabilities, or protection-mode disablement.
- Quarantine a native Telegram conversation after a worker failure before the
  next request, and durably acknowledge the failed update. This prevents later
  prompts from reusing a failed conversation and prevents replay of a mutation
  request whose delivery outcome is already terminal.

### Field evidence and limitations

- Public 2.0.18 on real HAOS 18.2 amd64 passed App startup, native
  `antigravity --version` with status 0, Telegram transport, and a no-tool chat.
  Web `agy`/`antigravity` interactive I/O failed: current kernel audit records
  the confined interactive profile denying inherited/open read-write access to
  `/dev/pts/0`. The first managed Telegram tool request ended in a terminal
  error. Tests 3 through 7 then reused that failed conversation and are not
  independent PASS/FAIL evidence. Approved write execution remained `NOT RUN`.
  Public 2.0.18 acceptance is therefore `FAIL` overall.
- Source, component, container, and kernel-enforced regression results for
  2.1.0 are automated evidence, not real HAOS evidence. Real-device 2.1.0
  acceptance on amd64 and aarch64 is `NOT RUN` before field testing; overall v2
  acceptance remains `PARTIAL` at publication.
- Version 2.0.12 is not a clean, automatic, or lossless fallback. Its custom
  AppArmor attachment failed, Supervisor does not support a direct downgrade,
  and restoring an exact 2.0.12 App backup replaces newer App `/data`, including
  later OAuth, memory, approval, outbox, and identity state. Do not present it
  as the normal repair for the 2.0.18 permission failure.

## [2.0.18] - 2026-08-19

### Fixed

- Restore the image-managed MCP boundary found broken by public 2.0.17 on real
  HAOS 18.2 amd64. App startup, Ingress/Web terminal, the native CLI and basic
  conversation, Telegram transport, and a no-tool Telegram reply passed, but a
  managed MCP request failed. The corresponding kernel audit records the
  `change-proposal-client` profile denying read access to the exact image-owned
  `/usr/local/share/antigravity-ha/supervisor-credential-fd.mjs` transitive
  module. Version 2.0.18 grants only that exact module read to that client; it
  does not add a directory-wide or broad application-library grant.
- Restore proposal-first Telegram writes. Both confined interactive launchers
  discarded the complete five-variable requester/run binding required by
  `telegram_action_propose`, so an approval card could not be created and an
  approved write was never reached. Each launcher now rejects a partial binding
  and preserves the complete validated binding as one unit. Direct unapproved
  native writes and commands remain blocked, and no broad AppArmor or native
  tool permission is added.
- Harden a rare `unsafe_storage` failure during concurrent memory daemon
  bootstrap and `ha-memory status`. The CI record did not preserve the observed
  link count, but its timing and path match a Linux cleanup race reproduced
  separately: link count zero can be returned after a transient SQLite `-shm`
  pathname is resolved while SQLite's last client unlinks it. The previous check
  reported every count other than one as "multiple hard links". Version 2.0.18
  treats only link count zero on SQLite auxiliary files as the same normal
  disappearance as `ENOENT`; the main database, symbolic links, wrong owner or
  mode, and every actual multiple-hard-link case remain fail-closed.
- Keep 2.0.13 as the sole breaking AppArmor security-boundary transition.
  Version 2.0.18 is a corrective patch within that boundary and is not added to
  `breaking_versions`.

### Verification and limitations

- Focused automated regressions cover the exact module-read rule, absence of a
  broad substitute grant, complete five-variable propagation through both
  launchers, partial-binding rejection, proposal coordinator behavior, SQLite
  auxiliary-file link-count-zero cleanup, and continued rejection of link count
  greater than one. These source/container checks are not HAOS evidence.
- Public 2.0.17 real-HAOS amd64 acceptance is `FAIL` overall: startup, Web
  terminal, native/basic conversation, Telegram transport, and no-tool chat
  passed; managed MCP and `telegram_action_propose` failed, and approved write
  execution is `NOT RUN`. Real-HAOS amd64 acceptance of 2.0.18 is `NOT RUN`
  before release. Real-device aarch64 remains `NOT RUN`; its owner waiver is
  risk acceptance, not a PASS. Overall v2 acceptance remains `PARTIAL`.
- Public 2.0.12 remains neither a direct nor lossless downgrade. Its custom
  AppArmor attachment failed, Supervisor direct downgrade is unsupported, and
  restoring an exact old App backup replaces newer App `/data`.

## [2.0.17] - 2026-08-19

### Fixed

- Restore the native Antigravity CLI under the two enforced interactive runtime
  profiles. Public 2.0.16 on real HAOS 18.2 amd64 started the full App service
  graph, authenticated Ingress terminal, and Telegram Bot API connection, but
  `agy` and `antigravity --version` immediately exited with SIGSEGV/status 139.
  Every accepted Telegram request reached `session_ready` and then failed within
  the worker with the same native crash; this was not an Ingress, Bot API,
  pairing, or conversation-reset failure.
- Reproduce the fault with the exact public 2.0.16 image under its custom
  AppArmor profiles. Kernel audit records `file_mmap` permission `m` denied for
  `/usr/local/libexec/antigravity-real` under `interactive-runtime-restricted`;
  `interactive-runtime-sensitive-read` contains the same `r`-only rule.
  Version 2.0.17 changes those two existing exact native-binary rules from read
  (`r`) to read plus executable memory-map (`rm`). The full blank-auth worker
  trace also requires exact bootstrap nsswitch/passwd identity reads and runtime
  `/usr/share/ca-certificates/**` TLS trust-store reads, which are added only to
  the two interactive transition chains. It adds no new broad `/etc/**` or
  `/usr/share/**` rule, preserves existing runtime `/etc/** r` and required
  system-library mappings, and leaves proc, native settings, credentials, and
  sensitive-path denies unchanged.
- Preserve the Telegram native termination signal in bounded bridge diagnostics
  so a SIGSEGV is no longer flattened into an unexplained `worker_failed` event.
  No stderr, prompt, OAuth material, token, or user content is added to logs.
- Keep 2.0.13 as the sole breaking AppArmor security-boundary transition.
  Version 2.0.17 is another corrective patch inside that boundary and is not
  added to `breaking_versions`.

### Verification and limitations

- The exact public 2.0.16 image reproduces status 139 under the project custom
  AppArmor policy. With only the two exact `r` to `rm` changes, the local
  kernel-enforced regression reaches status 0 for `antigravity --version`.
  The complete corrected profile, including the trace-derived exact identity
  and TLS trust-store reads, also lets a blank-auth worker traverse its bounded
  startup while new-broad-rule negative assertions and the existing proc/settings
  deny canaries remain unchanged. These automated Linux-container results are
  not HAOS evidence.
- Real-HAOS acceptance of 2.0.16 is `FAIL`. Real-HAOS 2.0.17 first start,
  stop/start, restart, native OAuth/session, Web terminal, and Telegram worker
  acceptance were `NOT RUN` at publication. Subsequent real-HAOS 18.2 amd64
  evidence passed startup, Web terminal, native/basic conversation, Telegram
  transport, and a no-tool reply, but managed MCP and Telegram approval-proposal
  requests failed. Approved write execution was therefore `NOT RUN`, making
  public 2.0.17 acceptance `FAIL` overall. Real-device aarch64 testing is also
  `NOT RUN`; the owner waiver is risk acceptance, not an aarch64 `PASS`. Overall
  v2 acceptance remains `PARTIAL`.
- Public 2.0.12 is not an automatic or issue-free rollback. Its exact image and
  tag exist, but the custom 23-profile policy was rejected; the narrow field
  success was amd64 under `docker-default`, while aarch64 remained `NOT RUN`.
  Supervisor direct downgrade is unsupported. Restoring an exact 2.0.12 App
  backup replaces App `/data` and loses post-backup OAuth, memory, approvals,
  outbox, and identities. Without that backup, do not uninstall the App or
  manipulate Docker state. A future higher-version compatibility fallback that
  preserves current `/data` while intentionally reverting custom attachment
  would be security-degraded and remains an audited `NOT RUN` contingency.

## [2.0.16] - 2026-08-19

### Fixed

- Restore the Ingress Web terminal under the enforced custom AppArmor boundary.
  On public 2.0.15 on real HAOS 18.2 amd64, authenticated Ingress HTTP and token
  requests returned 200 and the WebSocket upgraded with 101, but ttyd could not
  allocate a PTY: `pty_spawn` returned EACCES and S6 repeatedly restarted ttyd.
  The primary profile now grants only the exact `/dev/ptmx` read/write access
  needed for PTY allocation; sensitive files, credentials, and broader device
  paths remain denied.
- Repair Telegram-enabled `refresh_managed` for a safe, parseable settings file
  whose existing `permissions.ask` value is malformed. Version 2.0.15 validated
  the stale bucket as a string array before the Telegram-safe replacement could
  canonicalize it, so refresh failed and the bridge correctly remained at
  `permission_boundary_blocked`. Version 2.0.16 canonicalizes all three managed
  permission buckets before typed merge validation, then applies the exact
  29 allow/0 ask/33 deny policy while preserving unrelated top-level settings,
  global MCP, plugins, OAuth, and `/config`.
- Preserve fail-closed handling for symlink, hardlink, non-root-owned,
  oversized, and invalid-JSON settings. This recovery does not broaden which
  files are eligible for automatic repair and does not bypass the bridge's
  effective permission-boundary check.
- Keep 2.0.13 as the sole breaking AppArmor security-boundary transition.
  Version 2.0.16 is a corrective patch inside that boundary and is not added to
  `breaking_versions`.

### Verification and limitations

- Regression coverage requires an actual PTY allocation through the enforced
  primary profile and supported Telegram `refresh_managed` fixtures with
  malformed allow/ask/deny bucket shapes, while retaining unsafe-file negative
  cases and exact permission-policy assertions.
- A sanitized real-HAOS 18.2 amd64 report records public 2.0.15 acceptance as
  `FAIL`: the App service graph reached ready state, but the Web terminal could
  not create a PTY and Telegram refresh stopped before safe policy
  normalization, leaving the bridge blocked. This is neither an Ingress
  transport outage nor a Telegram Bot API outage.
- Real-HAOS acceptance of the corrected 2.0.16 image is `NOT RUN` at this source
  cutoff. Automated Linux-container gates are not HAOS evidence. Real-device
  aarch64 testing also remains `NOT RUN`; the project owner's experimental
  deployment waiver is a risk acceptance, not an aarch64 `PASS`. Overall v2
  acceptance remains `PARTIAL`.

## [2.0.15] - 2026-08-19

### Fixed

- Correct App initialization under the project custom AppArmor policy after the
  public 2.0.14 amd64 HAOS update failed at `antigravity-ha-init`. AppArmor
  evaluates the resolved `/usr/bin/bashio` target `/usr/lib/bashio/bashio`, so
  the prior `/usr/bin/**` execute permission did not cover it and S6 reported
  `unable to exec bashio: Permission denied` before the init service exited
  126. The init transition also resolves `/command/with-contenv` to
  `/package/admin/s6-overlay-3.2.2.0/command/with-contenv`.
- Close the complete cold-start trace rather than stopping at the observed
  Bashio denial. Exact, profile-scoped execute rules cover resolved Bashio,
  S6/execline (`execline`, `s6-envdir`, `with-contenv`, and Telegram's
  `s6-pause`), Debian's resolved `/usr/bin/bash`, the shell's architecture-bound
  `utempter`, Chromium's main and crashpad child binaries, and the interpreted
  Playwright wrapper/runtime after their profile transitions. Browser reads are limited to
  the traced font/config metadata, and its fontconfig lock/temp/replace lifecycle
  is limited to `/var/cache/fontconfig`. Other narrow mutation rules cover only
  init's passwd/shadow locks and nginx PID/temp state, sshd's own OOM score plus
  shell login accounting, and the HA feedback report subtree. The change adds no
  new broad `/usr/lib/**` or `/package/admin/**` execute, no new broad `/etc/**`
  write, and preserves the existing credential and sensitive-data denies.
- Keep 2.0.13 as the sole breaking AppArmor security-boundary transition.
  Versions 2.0.14 and 2.0.15 are corrective patches inside that boundary and
  are not added to `breaking_versions`.

### Verification and limitations

- Add a kernel-enforced AppArmor startup smoke instead of relying only on policy
  parsing or a container running under `docker-default`. It loads the custom
  profile, attaches the exact built or Candidate image, verifies the PID 1
  profile and full S6 init, exercises cold start and fresh-container restart,
  rejects a safely seeded `/config/secrets.yaml` read-denial canary, and fails
  on S6 mkdir/exec fatals or an unexpected kernel denial. Source contracts
  separately pin every trace-derived read, execute, and mutation exception to its
  intended profile. The normal CI amd64 image and exact Candidate amd64/aarch64
  images must pass this automated Linux-container gate.
- A sanitized real-HAOS 18.2 amd64 report records public 2.0.14 startup as
  `FAIL`: after S6 reached `antigravity-ha-init`, the resolved Bashio execution
  was denied, the service exited 126, and the container stopped. This is an
  AppArmor startup failure, not a Telegram transport failure.
- Real-HAOS acceptance of the corrected 2.0.15 image is `NOT RUN` at this source
  cutoff. The automated kernel-enforced smoke is not HAOS evidence. Real-device
  aarch64 testing also remains `NOT RUN`; the project owner's experimental
  deployment waiver is a risk acceptance, not an aarch64 `PASS`. Overall v2
  acceptance therefore remains `PARTIAL`.

## [2.0.14] - 2026-08-18

### Fixed

- Restore S6 Overlay startup while the project custom AppArmor profile is
  enforced. The public 2.0.13 policy allowed descendants of the S6 runtime
  trees but omitted the directory entries that S6 must create and traverse,
  so the next container start could fail at `/run/s6` and `/run/service` with
  `Permission denied` and `s6-overlay-suexec` exit code 111. Version 2.0.14
  grants only the required S6 runtime-directory, container-exit-result, and
  nginx PID-file access; it does not broaden Home Assistant secrets, native
  OAuth, Supervisor credentials, SSH keys, broker state, or Recorder access.
- Keep 2.0.13 in `breaking_versions` because it is the release that activates
  the intended custom security boundary. Version 2.0.14 is a corrective patch
  within that boundary and is not added as a separate breaking migration.

### Real-device evidence and limitations

- A sanitized real-HAOS 18.2 amd64 update report for public 2.0.13 recorded an
  orderly stop after healthy Telegram activity, followed by the S6
  `/run/s6`/`/run/service` permission failures and exit code 111 on the new
  container start. This is an AppArmor/S6 startup `FAIL`, not a Telegram
  transport failure.
- Real-HAOS acceptance of the corrected 2.0.14 image is `NOT RUN` at this source
  cutoff. It must verify first start, stop/start and restart, named-profile
  enforcement, zero unexpected AppArmor denials, and all required services
  before the startup defect can be closed on a device.
- Real-device aarch64 testing remains `NOT RUN` because hardware is unavailable.
  The project owner's experimental-release waiver is a deployment risk
  acceptance, not an aarch64 `PASS`.

## [2.0.13] - 2026-08-18

### Fixed

- Make the custom least-privilege AppArmor policy installable by Home Assistant
  Supervisor 2026.07.5. The 2.0.12 policy contained 23 unindented top-level
  `profile` declarations, while Supervisor accepts exactly one `^profile[ ]`
  declaration in an App policy. Supervisor therefore rejected that custom file
  and the observed amd64 App ran under `docker-default (enforce)`. Version
  2.0.13 leaves only the slug primary declaration at column zero and indents
  the other 22 independent global profile declarations so Supervisor's primary
  scanner sees exactly one declaration. The AppArmor parser still loads the
  same 23 names, `Px` transitions, and path restrictions; all targets remain
  independent global profiles rather than nested subprofiles.
- Mark 2.0.13 as a breaking security-boundary transition. Workloads that were
  accidentally permitted by the generic Docker profile can now receive the
  intended project-specific denial, so administrators should review sanitized
  AppArmor denials after updating instead of disabling protection or granting
  broader App privileges.
- Remove package-install-generated SSH host private keys from the immutable
  image. Runtime SSH continues to create and use its isolated persistent keys
  under `/data/ssh`; no baked host identity is retained in an image layer.

### Real-device evidence and limitations

- On a real HAOS 18.2 amd64 host, the public 2.0.11 to 2.0.12 `preserve`
  update passed Telegram permission reconciliation, Bot API reconnection,
  message delivery, and App restart/reconnect checks. The same observation
  failed the custom AppArmor attachment check because the active profile was
  `docker-default (enforce)`, not the App's named least-privilege policy.
- Real-device aarch64 testing remains `NOT RUN`. The project owner explicitly
  waived that missing device result for this experimental deployment; the
  waiver is a recorded risk acceptance and is not an aarch64 `PASS` or
  evidence-complete release claim.
- The corrected 2.0.13 AppArmor attachment and positive/negative matrix remain
  `NOT RUN` on HAOS until the new image is installed and observed. The App
  remains experimental.

## [2.0.12] - 2026-08-18

### Fixed

- Reconcile the effective native permission boundary transactionally before a
  Telegram-enabled startup. A root-owned, single-link regular, parseable
  `settings.json` of at most 256 KiB now receives the five canonical App-managed
  security values and exact 29 allow/0 ask/33 deny policy even when
  preserve mode cannot prove legacy ownership or a previously current file has
  drifted. The transaction backs up the prior settings, preserves unrelated
  top-level settings and the existing global MCP, OAuth, plugins, and `/config`,
  hardens the file mode to 0600, and is restart-idempotent.
- Share one permission-boundary validator between the user-file updater and the
  Telegram bridge so updater output cannot silently diverge from the startup
  gate. Missing/extra allow/ask/deny rules are not carried into the headless Telegram
  runtime; the two requester-bound proposal MCPs remain the only managed
  side-effect entry points.
- Keep an unrecoverable Telegram permission boundary fail-closed without
  repeatedly exiting the supervised process. The bridge records one sanitized
  `permission_boundary_blocked` event, makes no Bot API connection, and waits
  for an administrator to repair the unsafe or unparsable settings and restart
  the App.

### Security and limitations

- Enabling Telegram now explicitly claims the managed native permission
  security keys and permission buckets even in `preserve` mode. This is a breaking
  compatibility correction: unknown custom allow/ask/deny rules are removed, while
  native settings outside those five security keys,
  global MCP configuration, OAuth, plugins, and Home Assistant configuration
  remain preserved. Keep Telegram disabled if those custom native permission
  rules must remain byte-preserved.
- A later sanitized real-HAOS amd64 report verified the repaired 2.0.12 public
  update, automatic permission reconciliation, live Bot API reconnection,
  delivery, and App restart/reconnect. It also found that Supervisor 2026.07.5
  had rejected the multi-top-level custom AppArmor file, leaving
  `docker-default (enforce)` active; custom AppArmor acceptance therefore
  failed. Real-device aarch64 remained `NOT RUN` under an explicit owner waiver,
  and OAuth, the complete Telegram matrix, and the unsafe-boundary hold were
  not promoted to `PASS`.

## [2.0.11] - 2026-08-18

### Added

- Add a proposal-first universal Telegram approval path for managed terminal
  commands, bounded inline scripts, mutually exclusive command choices, and
  finite questions. The proposal MCP registers an exact digest-bound action;
  it cannot execute the action. Telegram renders durable Approve/Deny or
  choose/cancel cards, commits the selected action before dispatch, runs it in
  a credential-free executor and AppArmor command profile, and returns a
  sealed result to the same Antigravity conversation.
- Add encrypted durable state for Telegram action approvals and opaque callback
  tokens. One to 31 choices plus Cancel fit the existing four-column,
  eight-row keyboard bound. Duplicate callbacks are idempotent; a committed
  action whose completion cannot be proved is reported `in_doubt` and is never
  spawned again.
- Expire only untouched pending action cards by TTL. Durable approved, answered,
  denied, committed, and terminal result records survive until callback input
  acknowledgement so an App outage cannot erase a decision.

### Changed

- Make `request-review` the new-install native permission default. The former
  2.0.9/2.0.10 App-owned broad allow layout is migrated to bounded native reads
  plus the exact `ha_change_propose` and `telegram_action_propose` entry points.
  Legacy `always-proceed` and `proceed-in-sandbox` options normalize to
  `request-review`; user-owned rules and stronger denies remain preserved.
- Route requester-bound Telegram Home Assistant mutations through the existing
  HA change broker, and managed terminal/script/question workflows through the
  new action proposal broker. A bounded automatic re-plan converts a native
  headless permission denial into guidance to use the appropriate proposal
  MCP; it does not treat the denial as an approval or retry the denied tool.
- Keep release version, source revision, and rootfs digest metadata after the
  large dependency-install layer, and decouple the private Playwright dependency
  bundle version from the App version. Unchanged dependencies now share their
  layer across numeric releases instead of making each HAOS pull retain another
  release-unique copy while Supervisor completes old-image cleanup.
- Document the official HAOS ownership boundary: this prebuilt App creates no
  device-side BuildKit cache, Supervisor cleans old App images after successful
  updates, shared image IDs are retained, and `/supervisor/repair` is a broad
  explicitly approved recovery action rather than an update hook. Add bounded
  `ha_read_storage_usage` diagnostics without Docker socket or `full_access`.
- Remove apt/npm/browser build residue from the final image and reset ephemeral
  Playwright home/output directories on each App initialization. Bound
  unreferenced terminal HA-memory refresh rows to the newest 64 while retaining
  every catalog, revision, change, metadata, and audit reference.

### Fixed

- Generalize the stream receipt validator to accept only the two managed
  proposal MCPs and the pinned CLI's bounded display metadata, so a valid action
  receipt reaches Telegram without weakening unknown-key, malformed-result, or
  multiple-receipt fail-closed checks.
- Cancel pending or approved Telegram action proposals with `/cancel` while
  preserving terminal and already-committed records for idempotent recovery.

### Security and limitations

- The fixed Antigravity CLI 1.1.13 `--print --output-format stream-json` mode
  cannot export and later resume native permission prompts. Consequently the
  bridge does not claim transparent interception of arbitrary future or
  user-installed plugin MCP tools. Supported managed HA, terminal, script, and
  question actions use proposal-first approval; unsupported side effects fail
  closed instead of bypassing Telegram confirmation.
- Initial native OAuth still requires the trusted Web terminal or SSH when the
  shared App identity has not already been authenticated. Local contracts and
  fixtures cover the new protocol; real HAOS AppArmor enforcement, live Bot
  API cards/callbacks, native OAuth, and real-device HA actions remain
  `NOT RUN` until release evidence records them.

## [2.0.10] - 2026-08-17

### Added

- Add broker-bound `multi_choice_service_call` proposals with up to 31 unique
  choices. Each choice reuses the full registered-service, entity,
  `service_data`, precondition, verification, size, depth, redaction, and
  preview-digest validation applied to an ordinary service call. Telegram adds
  Cancel as at most the 32nd button and keeps the keyboard within four buttons
  per row and eight rows.
- Render durable Telegram choice grids with an explicit cancel action and
  backward-compatible binary approval buttons. The encrypted approval record
  maps short opaque callback tokens to broker choice IDs, persists the selected
  choice before authorization, and recovers across a bridge-only restart while
  the broker still holds the proposal. A full App or broker restart rejects an
  unstarted in-memory proposal; an execution already accepted by the broker
  recovers durable status/result without executing a different or duplicate
  service call. Duplicate taps, `/new`, `/cancel`, and delivery retry remain
  fail-closed or idempotent as appropriate.

### Fixed

- Accept the pinned Antigravity stream's required managed-MCP routing fields
  with optional bounded `toolAction` and `toolSummary` display metadata, while
  continuing to reject unknown keys, invalid states, malformed output, multiple
  proposal receipts, or non-broker tools.
- Preserve a valid single Home Assistant proposal when Antigravity completes
  its tool turn with an empty final text response. The bridge substitutes one
  fixed assistant acknowledgement so the durable approval card is queued;
  proposal-free empty responses and oversized or non-string terminal results
  remain fail-closed.
- Report proposal parameter-shape and metadata failures through bounded,
  privacy-safe reason classes instead of retaining raw stream keys, values,
  proposal previews, prompts, or stderr.

### Security

- Bind the selected choice through the broker authorization capability,
  execution request, idempotency record, persisted status, requester, session
  generation, conversation, and complete proposal preview digest. Telegram
  callback data never carries executable Home Assistant parameters.

## [2.0.9] - 2026-08-17

### Changed

- Make `always-proceed` the new-install native permission default and give
  Telegram the same operational `/config`, global plugin/agent/skill/rule,
  URL, command, and MCP access as Web/SSH. Exact denies still protect
  `secrets.yaml`, `.storage`, App-owned runtime tokens/options, SSH/private keys,
  and named standard cloud-auth paths. Spawned command/stdio tools also cannot
  read the native OAuth backend. User-authored plugin/MCP inline credentials are
  an explicitly trusted extension boundary. Existing user-owned rules remain
  preserved. Raw writes to native
  `settings.json` stay denied, while the new digest-bound `agy-settings patch`
  helper atomically updates ordinary global settings and rejects the App-owned
  `permissions`, `enableTerminalSandbox`, `allowNonWorkspaceAccess`,
  `toolPermission`, and `artifactReviewPolicy` keys.
- Retire Antigravity's native nested `--sandbox`, which cannot create namespaces
  in a non-privileged HAOS App. Web, SSH, and Telegram instead transition every
  spawned command or stdio tool into the discrete
  `antigravity_home_assistant-command` AppArmor profile without adding host
  privileges. The legacy `antigravity_terminal_sandbox` option is a deprecated
  no-op; either value normalizes to `false`, and native sandbox flag overrides
  are rejected.
- Expand brokered Home Assistant changes to every live-validated service
  domain/service with bounded `service_data`, and to ordinary `/config` YAML
  patches with expected digest, atomic backup/write, configuration validation,
  exact rollback, and supported reload or explicit `restart_required` reporting.
- Classify every App-managed broker `service_call` and `config_patch` as a
  high-risk durable Telegram approval operation. Native headless permission
  prompts remain non-resumable; trusted user/global native tools and direct
  command/API helpers retain CLI-equivalent administrator authority and are not
  transparently intercepted by the broker.
- Scope local multi-architecture builds to a project-owned per-checkout
  `antigravity-ha-local-<checkout-hash>` Buildx builder. The helper removes only
  its own stale and completed BuildKit state, never runs a global prune, and
  retains at most the two newest unreferenced, project-labelled local images.
- Give reusable release builds one stable `antigravity-home-assistant` GHA cache
  scope. Independently bound verified, completed App-owned managed-plugin,
  native user-files refresh, and change-broker config backups to the two newest
  entries after successful recovery/update/transaction; active, unowned,
  malformed, or unsafe backup trees remain untouched.

### Fixed

- Persist Telegram approval records and revalidate requester, chat, current
  session generation/conversation, proposal digest, expiry, and idempotency at
  the execution boundary. Callback acknowledgement and authorization checks are
  immediate, while approved broker execution remains serialized in the requester
  queue. `/new`, `/cancel`, restart, expiry, and duplicate callbacks cannot execute
  a stale proposal or dispatch a mutation twice; stale-session and queued-cancel
  outcomes are cleaned up and delivered through the existing durable outbox.

### Security

- Keep `secrets.yaml` and `.storage` directly unreadable and unwritable even when
  diagnostic sensitive-data access is enabled; that option now broadens only
  Recorder database diagnostic reads. This default-permission and trust-boundary
  change is declared in `breaking_versions` for 2.0.9.
- Keep OAuth and App-managed settings in the interactive Antigravity profile but
  deny them to command/tool descendants through a discrete `Px` transition.
  Generic container contracts cover the policy and functional command path;
  enforce-mode AppArmor and live Telegram/OAuth E2E on HAOS remain `NOT RUN`.

## [2.0.8] - 2026-08-17

### Fixed

- Return Telegram chat replies from Antigravity's native free-text terminal
  `result.response` instead of requiring the model to invoke a generated
  `finish` tool and serialize an App-specific JSON schema.
- Accept a Home Assistant change proposal only from an exact completed
  `ha_change/ha_change_propose` tool receipt and revalidate its proposal ID,
  requester and live proposal metadata through the trusted change broker before
  showing or executing it.
- Separate a working Telegram Bot API transport from Antigravity terminal-result
  failures in `/status` and bounded logs. Missing, unsuccessful, malformed,
  conversation-mismatched, and invalid-proposal results now have safe reason
  classes without retaining prompts, raw model output, or stderr.
- Upgrade the pinned Antigravity CLI runtime from 1.1.11 to 1.1.13, including
  architecture-specific immutable artifact verification.

## [2.0.7] - 2026-08-17

### Changed

- Treat Telegram as a trusted primary Antigravity channel: it now uses the same
  persistent `/data/home`, `/config` project, native OAuth identity, permission
  policy, and user-managed global/workspace plugins, agents, rules, and MCP
  configuration as Web terminal and SSH instead of maintaining a second
  Telegram-only Antigravity installation and login flow.
- Remove the channel-specific `telegram_access_mode` option. Telegram now follows
  the global `antigravity_tool_permission`, `antigravity_terminal_sandbox`, and
  `antigravity_sensitive_data_access` settings; a legacy value is accepted only
  as ignored migration input. This is an intentional trust-model change while
  the App remains experimental.
- Adopt gateway invariants found in established bot implementations without
  copying their code: one durable conversation per authorized user/chat, an
  explicit `/new` rotation boundary, serialized per-session work, and outbound
  delivery state that survives transient transport failures.
- Bind a newly allocated conversation before its first Antigravity execution,
  keep approvals attached to that same conversation, and persist encrypted
  pending replies for bounded retry until Telegram acknowledges delivery.
- Journal each validated Antigravity terminal result before proposal inspection
  or execution, so crash recovery reuses the same model result instead of
  creating another turn; make callback execution and reply delivery idempotent.
- Preserve existing v2 local-pairing authorization during upgrade while
  resetting only conversation IDs that belonged to the retired Telegram-only
  HOME, so the first 2.0.7 request binds a valid shared-runtime conversation.
- Migrate App-owned 2.0.6 permission rules even in `preserve` mode and normalize
  the retired Supervisor option once, while leaving user-owned rules and other
  settings unchanged.

### Security

- Document Telegram as an administrator-equivalent control plane. Pairing and
  static allowlists remain access controls, but Telegram intentionally inherits
  the same user customization and `/config` authority as the CLI; operators must
  protect the bot account, token, authorized chats, and Telegram devices as
  administrator credentials.

## [2.0.6] - 2026-08-15

### Changed

- Roll forward the Telegram headless response-delivery and conversation-reuse
  corrections in a new immutable App version so Home Assistant OS detects the
  update from affected installations.

## [2.0.5] - 2026-08-14

### Fixed

- Keep Telegram prompts on non-TTY stdin and let Antigravity 1.1.11 select
  print mode automatically, avoiding the value-taking `--print` flag consuming
  the following worker argument as the prompt.
- Parse Antigravity 1.1.11's actual top-level `event` stream discriminator and
  require a matching conversation ID, successful terminal status, and exact
  managed response schema before replying to Telegram.
- Allow reads of only the three image-managed Telegram skill instruction files
  needed by the headless agent, and classify the exact empty-output permission
  denial without exposing raw stderr or broadly bypassing tool permissions.

## [2.0.4] - 2026-08-14

### Fixed

- Classify only the native Antigravity authentication-required signature as a
  Telegram OAuth failure and return an actionable `ha-telegram-login` message;
  keep all other worker failures bounded and free of raw stderr.
- Accept Antigravity 1.1.11's known-safe normalization of the image-managed
  Telegram settings while continuing to reject any other policy drift.
- Route web-terminal and SSH sessions into the ordinary shell AppArmor profile,
  with narrow transitions for Telegram pairing and dedicated OAuth login.

## [2.0.3] - 2026-08-14

### Fixed

- Raise the Telegram-only Node network-family address-attempt timeout from the
  250ms runtime default to 1.5 seconds. This prevents a valid high-latency IPv4
  connection from being abandoned just before completion when the following
  IPv6 route is unavailable, while preserving dual-stack auto-selection.

## [2.0.2] - 2026-08-13

### Fixed

- Keep Telegram startup inside the bridge when `deleteWebhook` or `getMe`
  encounters a transient DNS, transport, timeout, rate-limit, or upstream
  failure. The bridge now uses bounded exponential backoff instead of entering
  an S6 restart and fatal-log loop; non-retryable 4xx responses remain
  fail-closed.
- Preserve a bounded, allowlisted Telegram transport code without logging the
  Bot API URL, token, or underlying error message.
- Hold non-retryable Telegram 4xx failures in one fail-closed process state so
  S6 cannot turn an invalid or revoked Bot token into a request and log loop.
- Separate `ha-memoryd` stdout and stderr so Node SQLite warnings can no longer
  hide the structured Home Assistant failure reason behind the generic
  `ha_unavailable` code. Raw diagnostics remain private and the last-known-good
  memory catalog remains unchanged while retrying.
- Keep the temporary structured memory diagnostic under a dedicated AppArmor
  path in `/run`; Telegram profiles cannot read or modify it.

## [2.0.1] - 2026-08-12

### Fixed

- Keep an enabled Telegram bridge quietly fail-closed while it waits for both
  static allowlists or a new local private pairing, instead of exiting into an
  unbounded S6 restart and fatal-log loop.
- Detect a newly created local pairing without restarting the App; no Bot API
  request is made before an authorization bootstrap exists.

## [2.0.0] - 2026-08-11

### Added

- Add the image-managed Home Assistant Antigravity plugin, native settings and MCP presets, bounded Core/Supervisor read helpers, validated memory workflow, and canonical loopback dashboard browser path.
- Add `amd64` and `aarch64` native build targets with pinned architecture-specific Antigravity, GitHub CLI, ttyd, Chromium, base-image, and package-lock inputs.
- Add an evidence-bound release-candidate workflow: unique architecture staging tags, exact generic candidate digest, native arm64 feasible smoke suites, per-leaf SPDX files, and a separate HAOS evidence finalizer.

### Changed

- Rebuild the App around the native Antigravity CLI settings, plugin, agent, and MCP contracts.
- Replace the legacy Telegram runner with an allowlisted, queued, non-shell bridge and explicit access modes.
- Add enforced AppArmor separation for Home Assistant secrets, Supervisor credentials, Telegram, and browser processes.
- Replace direct numeric-tag rebuild/publish with candidate-digest promotion. Numeric architecture and generic tags are carbon copies of exact staged digests and support absent/same/conflict resume without overwriting conflicts.

### Security

- Keep the Telegram bridge disabled until an explicit static allowlist or local pairing is valid, isolate its native Home/workspace, and route all Home Assistant changes through typed, expiring, replay-resistant broker capabilities.
- Enforce the custom AppArmor profile by default. The optional sensitive-data setting selects a read-only, discrete top-level interactive execution profile through a `Px` transition; it does not disable AppArmor or relax Telegram, browser, credential-broker, or high-risk confirmation boundaries.
- Require an annotated numeric tag to bind source SHA, candidate run/attempt, final evidence run/attempt/name, and the GitHub artifact archive SHA-256.
- Require public anonymous access to the exact candidate before any numeric tag is created. Registry API 403, 404, network, and malformed responses fail closed instead of being treated as an absent tag.
- Recheck an API-absent numeric tag against the authenticated registry immediately before promotion, and require a new GitHub Release source to be contained in the default branch with an identical workflow tree instead of broadening the workflow token.
- Sign immutable subjects with the exact `builder.yaml@refs/tags/<version>` keyless Cosign identity and verify issuer, workflow SHA/ref/repository/trigger plus retrievable provenance and leaf SPDX predicates.

### Migration

- Preserve `/config`, native OAuth, SSH identity, browser identity, memory, and user-owned settings/plugins. Managed settings and the image-managed Home Assistant plugin use ownership-aware, journaled transactions with verified backup and rollback paths.
- Support conservative `preserve`, `refresh_managed`, and `reset_v2` modes. Deprecated v1 options are migration inputs only and never restore legacy auto-approval, shell execution, token injection, or Codex-style configuration.
- Accept retained v1 `refresh_agents` and `refresh_all` values through Supervisor's pre-container update validation, map them to `refresh_managed`, and persist only that normalization through the fixed self-options API after safe bootstrap; unavailable persistence warns and retries on the next start.
- Pin Antigravity runtime updates to App releases and force `AGY_CLI_DISABLE_AUTO_UPDATE=true` through native launch boundaries.

### Release status

- Local amd64 full image suites and QEMU arm64 packaging/Telegram-isolation evidence exist, while real HAOS amd64/aarch64 install/update, AppArmor enforcement, live Telegram/OAuth, rollback, native updater, public candidate visibility, and post-publish repository installation remain **NOT RUN**.
- The release evidence template therefore remains fail-closed and the v2 release is **PARTIAL**. The numeric `2.0.0` image and prerelease were subsequently published from the exact automated Candidate; post-publish real-device acceptance remains separate.

## [1.0.4] - 2026-08-08

### Added

- **Deep Diagnostic Logging**: Add real-time PTY pane character count, preview snippets, and extraction status logging directly into the add-on container output for instant troubleshooting.

## [1.0.3] - 2026-08-08

### Fixed

- **Direct Runner Execution**: Run Antigravity CLI prompts via dedicated temporary runner scripts inside tmux, eliminating nested shell quoting issues and ensuring complete, non-truncated AI response capture.
- **Strict Turn Isolation & Clean Output**: Isolate the current conversation turn and thoroughly strip terminal banners, prompt echoes, tool progress traces, and thought blocks before transmitting to Telegram.


## [1.0.2] - 2026-08-08

### Fixed

- **PTY Execution with Full Environment**: Execute CLI prompts inside a dedicated detached tmux session with `/usr/local/lib/antigravity-ha/environment.sh` and `/run/antigravity-ha/runtime.env` sourced, ensuring `HOME=/data/home` and `ANTIGRAVITY_HOME=/data/antigravity` are active for zero-hang prompt execution.
- **Telegram Connection Bootstrap**: Add a 60s startup retry loop for Telegram `getMe` connection, preventing `fetch failed` errors during container network initialization.
- **Interactive Inline Approval**: Support dynamic Telegram Inline Keyboard approval prompts with `tmux send-keys` callback queries and real-time message state updates.


## [0.9.9] - 2026-08-08

### Added

- **Hermes-Style Heartbeat & Typing Loop**: Send recurring `sendChatAction("typing")` signals every 4s and periodic 30s status progress checks to maintain uninterrupted connectivity without timeout freezes.
- **Interactive Inline Keyboard Approvals**: In `on-request` or `untrusted` approval modes, present Telegram Inline Keyboard buttons (`[✅ 승인 (Approve)]` / `[❌ 거부 (Deny)]`) and route callback queries directly to the agent process stdin.
- **Markdown-Safe Code Block Chunking**: Split long messages (>3900 chars) along paragraph/line breaks while automatically preserving triple-backtick code block boundaries across chunks.

### Fixed

- **Subprocess Isolation**: Execute CLI prompts via direct subprocess spawning rather than tmux terminal scrollback scraping, eliminating 10,000+ char transcript dumps and thought leaks.


## [0.9.8] - 2026-08-08

### Fixed

- **Full-Auto CLI Approval Passthrough**: Pass `-c "approval_policy=..."` and `-c "sandbox_mode=..."` flags from add-on options to the underlying `antigravity` CLI binary, enabling full-auto operation without manual confirmation prompts when `approval_policy: never` is configured.
- **Daemon Tmux Autostart**: Pre-create the background tmux session (`antigravity-ha`) during add-on container initialization (`antigravity-ha-init`), eliminating session conflicts and `Conversation already open` warnings when using Telegram, SSH, or opening the Web UI.
- **Telegram Response Isolation & Pacing**: Filter terminal escape codes, system banners, and previous conversation history in `telegram-bridge.mjs` to send strictly the latest assistant response, auto-respond to interactive confirmation prompts, and cleanly chunk messages within safe Telegram API limits (3900 chars).


## [1.0.1] - 2026-08-08

### Added

- **NATIVE GOOGLE ANTIGRAVITY CLI (v1.1.11)**: Migrate base image to official Home Assistant Debian Bookworm base (`ghcr.io/home-assistant/amd64-base-debian:bookworm`) with Node.js 22.x.
- Install native Google Antigravity binary (v1.1.11) with full native **Google Account OAuth 2.0 Headless Browser Authentication** support.
- `ha-antigravity-login` launches native OAuth 2.0 device flow directly in web terminal & SSH.


## [0.8.1] - 2026-08-07

### Fixed

- Update Gemini CLI authentication helper (`ha-antigravity-login`) with clear guidance for Google AI Studio API key authentication.
- Export both `GEMINI_API_KEY` and `ANTIGRAVITY_TOKEN` environment variables in runtime.env, SSH environment, and wrapper script when `antigravity_token` add-on option is set.
- Add interactive terminal prompt fallback to `ha-antigravity-login` for on-the-fly API key entry during a terminal session.


## [0.8.0] - 2026-08-07

### Changed

- **BREAKING**: Install real Google Gemini CLI (`@google/gemini-cli`) via npm replacing the previous mock shell script. The CLI is now a real LLM-powered AI agent.
- Add `gcompat` and `libstdc++` Alpine packages for glibc binary compatibility.
- Multi-strategy CLI installation with graceful fallback: npm → official install script → mock.
- Add `antigravity_token` add-on option (`password?`) for headless token-based authentication via the HAOS settings UI.
- Inject `ANTIGRAVITY_TOKEN` from add-on options into runtime.env and SSH environment for seamless headless auth.
- Update `ha-antigravity-login` to use `auth login --no-browser` (Antigravity headless device OAuth flow).
- Flexible version verification in Dockerfile build for compatibility with real CLI output formats.


## [0.7.3] - 2026-08-07

### Fixed

- Fix REPL command parser to handle login / auth commands without accidentally matching "log" in substring matches.
- Add explicit authentication status handler for login, auth, ha-antigravity-login, antigravity login, and agy login commands.


## [0.7.2] - 2026-08-07

### Added

- Add /usr/local/bin/agy executable CLI alias for antigravity.
- Implement rich interactive Antigravity CLI REPL Shell for interactive Web Terminal (ttyd + tmux) sessions, supporting status, ha-config-check, logs, memory, help, exit, and natural language queries.


## [0.7.1] - 2026-08-07

### Fixed

- Remove prebuilt GHCR image directive from config.yaml to allow Home Assistant OS Supervisor to build the custom add-on locally from source upon installation, resolving Supervisor registry 401/403/500 denied installation errors.


## [0.7.0] - 2026-08-07

### Added

- Add official Google Antigravity & Home Assistant combined minimalist vector logo (icon.png 128x128 RGBA and logo.png 250x250 RGBA).
- Update default SSH port mapping to 2224/tcp.
- Update Home Assistant OS App manifest version to 0.7.0 for HAOS Supervisor update discovery.


## [0.6.0] - 2026-07-16

### Added

- Add the image-managed `$ha-feedback` Skill with explicit `bug` and `feature` modes. It guides antigravity through read-only investigation, honest `PASS`/`FAIL`/`NOT_TESTED`/`NOT_RUN` boundaries, structured privacy review, and bilingual report preparation.
- Add the Node-based `ha-feedback` helper for allowlisted environment collection, schema validation, Markdown rendering, private report storage, GitHub authentication status/login/logout, random short-lived single-use submission previews, confirmed issue creation, and a short prefilled Issue Form fallback.
- Add bilingual bug and feature Issue Forms, copyable Korean/English presets, and a manual reporting route for failures where antigravity or the Skill cannot start.
- Bundle the official GitHub CLI `2.93.0` linux amd64 archive with pinned SHA-256 verification.

### Changed

- Add feedback routing to both the new-installation base `AGENTS.md` and image-managed system developer instructions, so normal updates gain the route without replacing preserved user antigravity files.
- Store reports under `/config/antigravity-workspace/feedback` with private directory/file permissions. Store optional GitHub CLI credentials under `/data/github-cli`; this location can be included in Home Assistant App backups.

### Security

- Keep feedback investigation read-only: it never authorizes Home Assistant changes, service calls, reloads, restarts, updates, recovery, or restoration. Possible vulnerabilities stop before public issue search or submission and use GitHub private vulnerability reporting.
- Collect only allowlisted version, architecture, and non-secret App option fields. Reject control/ANSI sequences, token and key patterns, cookies, long base64 blobs, URLs/IPs, and identifying Home Assistant values before public rendering or `gh` execution; logs and screenshots remain opt-in and are never uploaded automatically.
- Remove `GH_TOKEN` and `GITHUB_TOKEN` from the GitHub CLI child environment, fix the destination repository and labels in code, and reject unsafe report/config links. Require a cryptographically random, payload-bound, 10-minute, single-use preview token after the user reviews the exact repository, title, label, and body.
- Fail closed when candidate or remote report-ID duplicate search is unavailable. Pass the already validated Markdown to `gh issue create --body-file -` over stdin, serialize concurrent submissions with an exclusive claim, and retain a hidden `.submission.lock` after an uncertain external result so direct submission cannot retry automatically.

### Upgrade notes

- Normal update from `0.5.0` preserves antigravity authentication/configuration/AGENTS, SSH identity, browser identity, memory, and Home Assistant files. Start a new antigravity session to discover `$ha-feedback` and the new image-managed routing.
- GitHub sign-in is optional. Before `ha-feedback github login`, review that `/data/github-cli` credentials may be present in App backups; use `ha-feedback github logout` to remove the persisted login.

### Testing

- Add schema/render/privacy fixtures, Skill and Issue Form contracts, fake-GitHub-CLI submission boundaries, and packaging/update persistence checks. A real GitHub test issue is intentionally **NOT RUN** without separate explicit approval.
- Merge [PR #33](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/pull/33) as `8404f8e61394021d0acb08a67a021cf2ca641f3b`; [main CI 29498705500](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/runs/29498705500) passed before publication.
- Verify the exact public image with feedback, browser-policy, full browser/gateway/Core WebSocket/ttyd/SSH, memory lifecycle/privacy/MCP/persistence, managed-auth, user-file, and public `0.5.0` to public `0.6.0` update smokes; all passed without creating an external issue.
- Keep actual installed-HAOS natural-language Skill discovery, report generation, preview, fallback, and confirmed live submission explicitly **NOT RUN** until operating-environment acceptance.

### Release evidence

- Publish the annotated `0.6.0` tag at `2026-07-16T12:39:01Z`; [Builder 29498965561](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/runs/29498965561) published the GHCR images, and the verified [GitHub prerelease](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/releases/tag/0.6.0) was published at `2026-07-16T12:51:51Z`.
- The generic and per-architecture tags share OCI index digest `sha256:5c8dd2c1a1f96c9a994178b6077d82a7ab582d946ee95bdb61575587292ed845`; the linux/amd64 runtime manifest digest is `sha256:4c4efdf797a77393f6ac2ab85d41f404b86171665c3bf583ff33943cd3708911`.
- Confirm anonymous generic/per-architecture manifest access and pull, the expected version/architecture/source labels, the absence of a mutable `latest` tag, and enabled private vulnerability reporting for security findings.

## [0.5.0] - 2026-07-16

### Added

- Add `memory_remember_explicit` and the matching `ha-memory remember` fallback. One unambiguous durable fact stated directly by the user now runs the existing audited pending→verified→applied transitions in a single tool call, fixes provenance to `user_explicit`, rejects transient values, obvious temporal/uncertainty wording, noncanonical home subjects, and canonical HA relationships, resumes an existing pending/verified duplicate, and returns applied/already-applied/conflict explicitly.
- Add bounded `memory_list_candidates` and `memory_reject_candidate` MCP tools, including exact-subject filtering, so a pending or conflicted candidate can be followed up or withdrawn in a later request without dumping the store.
- Make repeated unresolved corrections return the existing candidate/conflict without adding duplicate rows, and normalize lower-authority provenance upgrades to the compound tool's stable `applied` result while retaining the detailed application result.
- Add an installed-image smoke that launches the image-managed `ha-memoryd` run contract against an empty store and waits for the first catalog without a manual refresh.

### Changed

- Require model-visible memory guidance to search a small relevant subset first, disclose empty/degraded/stale status, finish direct explicit-user learning in the same request, keep entity data out of all AGENTS files, and report applied/conflict outcomes. Add a bounded `ha-memory remember` fallback when the optional MCP is unavailable and forbid weak existence/name checks as proof of unsupported automation logic changes.
- Require supported pre-change expectations and post-reload fresh API verification for persistent Home Assistant configuration, registry, and automation mutations. Reads, diagnostics, catalog refreshes, and transient device-service tests remain outside that ledger; unsupported or unavailable verification leaves semantic memory unchanged and is disclosed before mutation.
- Advance the released-image update regression to public `0.4.0` so the new memory tools are verified without losing the existing catalog/applied memory, user antigravity files, authentication, SSH, browser identity, or browser approval policy.

### Fixed

- Wait up to five seconds for transient SQLite `BUSY`/`LOCKED` contention, retry only `search_fts`-scoped FTS5 diagnostics when `data_version` proves another connection committed during the check, serialize new schema initialization in one immediate transaction, and tolerate only normal WAL/SHM/journal disappearance during auxiliary-file inspection. Concurrent first catalog bootstrap and `ha-memory status` no longer report a healthy WAL/FTS5 store as `database_corrupt` or fail with `ENOENT`; malformed, unsafe, or stable integrity failures remain fail-closed.

### Security

- Keep the compound explicit-memory path on the same transient-value, source authority, canonical-relationship, conflict, audit, and rollback validators as the separate candidate tools. It does not add a listener, permission, raw transcript field, or path for state/API/config payload persistence.

### Upgrade notes

- This is a MINOR user-flow release. Normal App update preserves `/data/antigravity-ha-memory`, user antigravity configuration, AGENTS files, authentication, SSH, and browser identity. Restart the App and start a new antigravity session so the image-managed MCP tool list and developer guidance include the new memory workflow.
- A retained `refresh_agents` or `refresh_all` selection applies its selected target once for `0.5.0`; choose `preserve` before update if that reset is not wanted.

### Testing

- Merge [PR #29](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/pull/29) as `110edf3aba42c5f33c011d75e9d05e4dd05b50f1`; [main CI 29465342591](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/runs/29465342591) passed before publication.
- Pass ten Node/SQLite memory tests covering writer-lock wait, concurrent FTS5 commits, deterministic and stressed auxiliary-file cleanup, malformed databases, and stable FTS5 corruption; pass the full Python, App, YAML, Markdown, ShellCheck, Hadolint, manifest, and diff checks.
- Verify the exact public image with browser-policy, full browser/gateway/Core WebSocket/ttyd/SSH, memory bootstrap/lifecycle/privacy/MCP/persistence, managed-auth, user-file, and public `0.4.0` to public `0.5.0` update smokes; all passed.
- Keep actual HAOS natural-language same-request learning, new-task recall, and safe persistent-change fresh verification explicitly **NOT RUN** until the installed App is retested. Automation logic-only changes remain outside the supported expectation schema.

### Release evidence

- Publish the annotated `0.5.0` tag at `2026-07-16T01:59:38Z`; [Builder 29465483772](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/runs/29465483772) then published the GHCR images, and the verified [GitHub prerelease](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/releases/tag/0.5.0) was published at `2026-07-16T02:13:17Z`.
- The generic and per-architecture tags share OCI index digest `sha256:193cfc7a7b678660b99f7017b6ac0f4261af59ba57832f8bdd82356ee982956a`; the linux/amd64 runtime manifest digest is `sha256:d360419231ad1aa9140821dd95dda6c4ce74122439726c503c5f30083e682fd5`.
- Confirm anonymous generic/per-architecture tag access and pulls, the expected version/architecture/source labels, and the absence of a mutable `latest` tag.

## [0.4.0] - 2026-07-15

### Added

- Add the `browser_approval_policy` Home Assistant App option with `safe` (default), `never`, and `always` modes. `safe` automatically approves browser navigation and inspection while retaining prompts for clicks, form input, key presses, selections, and typing; `never` suppresses MCP prompts for the current restricted Playwright allowlist; `always` requests approval for each allowed browser tool.

### Changed

- Apply the selected browser policy on every antigravity CLI and app-server launch through image-managed CLI overrides without rewriting the user's `config.toml` or `AGENTS.md`.
- Change the Playwright server fallback from annotation-dependent `writes` behavior to an explicit `prompt` default plus reviewed per-tool modes. Future tools therefore prompt until they are deliberately added to the image allowlist and policy helper.
- Advance the released-image update regression from public `0.3.1` to public `0.3.2` and preserve an older `options.json` without inserting the new key; its missing value resolves to `safe` at runtime.

### Security

- Keep the existing 16-tool Playwright proxy allowlist unchanged. The new full-auto choice does not enable code evaluation, arbitrary file upload, PDF/file output paths, unrestricted network tools, or any additional Home Assistant permission.
- Keep `antigravity_approval_policy` as the umbrella command policy. When it is `never` under a full-write permission profile, antigravity may automatically approve MCP prompts globally, so `safe` or `always` cannot force a browser popup in that combination. Home Assistant device mutations still require authorization from the user's current request and remain subject to the App operating guidance.

### Upgrade notes

- New and existing installations that do not yet have `browser_approval_policy` use `safe`. Save a different mode in the App Configuration UI, restart the App, and start a new antigravity session to apply it.
- The existing per-target App-version behavior applies to `0.4.0`: a retained `refresh_agents` or `refresh_all` selection refreshes its selected target once after the update. Select `preserve` before updating if that is not wanted.

### Testing

- Add exact static parity checks across the system MCP configuration, runtime policy helper, and proxy allowlist, including the 11 safe and 5 interactive tools.
- Add a disposable-container wrapper smoke covering missing, `safe`, `never`, `always`, invalid enum, invalid type, CLI argument pass-through, and pinned antigravity TOML parsing, plus public `0.3.2` update preservation.
- Merge [PR #26](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/pull/26) as `bca612661692e3d66d239c06b57b52921ea56af6`; [main CI 29408206017](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/runs/29408206017) passed before publication.
- Verify the exact public image with browser-policy, full browser/gateway/Core WebSocket/ttyd/SSH, memory, managed-auth, user-file, and public `0.3.2` to public `0.4.0` update smokes; all passed.
- In the subsequent actual HAOS `never`-mode acceptance run, 14 allowed Playwright tools completed with zero MCP approval prompts, including desktop/mobile rendering, automatic dashboard authentication, console/network inspection, and non-mutating click/input paths. `select_option` had no safe target and `close` was not reported, so both remain **NOT TESTED** and the overall approval matrix remains **PARTIAL**.
- Keep `safe`, `always`, top-level global-never precedence, blocked-tool rejection, Configuration UI/default behavior, confirmed AppArmor status, user-file/identity preservation, and live update detection explicitly **NOT RUN**. A legacy Bubble Card module YAML returned one 404 warning/error pair without preventing either viewport from rendering.

### Release evidence

- Publish the annotated `0.4.0` tag at `2026-07-15T10:32:08Z`; [Builder 29408467932](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/actions/runs/29408467932) then published the GHCR images, and the verified [GitHub prerelease](https://github.com/Kanu-Coffee/antigravity-for-home-assistant/releases/tag/0.4.0) was published at `2026-07-15T10:42:35Z`.
- The generic and per-architecture tags share OCI index digest `sha256:758837276c4247a304c58791bddab5912977d3445801dcd832a638f9a2af9342`; the linux/amd64 runtime manifest digest is `sha256:b586727e9a2ca724f32f8255f692cd32104aeed45bc0e65b8c12cb3cc151373b`.
- Confirm anonymous generic/per-architecture tag access and pulls, the expected version/architecture/source labels, and the absence of a mutable `latest` tag.

## [0.3.2] - 2026-07-15

### Fixed

- Keep Home Assistant's official `search/related` automation request shape while isolating only the observed Core result envelope `success: false`, `error.code: unknown_error` for the affected automation. Its successful `automation/config` remains indexable, direct area/device/entity references are extracted locally, and the missing related enrichment becomes a bounded `automation_related_unavailable` warning instead of aborting every catalog bootstrap.
- Distinguish the observed Core `unknown_error` from server `timeout`, `unauthorized`, `invalid_format`, `home_assistant_error`, client timeout, transport, WebSocket close, protocol, malformed envelope, and malformed successful-result failures. Only the exact observed related error is degradable; all other incomplete-snapshot paths remain fail closed and preserve the last-known-good catalog.
- Record each normalized automation relationship with its actual `search_related` or `automation_config` provenance instead of treating an empty related object as the source of config-derived references.
- Surface only the persisted warning count through `ha-memory status` and daemon success logging so operators can distinguish a complete base catalog with missing optional enrichment without logging automation identifiers.

### Security

- Do not persist or return the Core error message/body when related enrichment is unavailable. The warning contains only a fixed prefix and the already allowlisted automation entity identifier, and the snapshot warning list is capped at 100 entries.

### Upgrade notes

- Public `0.3.1` was verified byte-for-byte on a real HAOS/Core `2026.7.2` installation, but catalog refresh failed because 2 of 30 automation-related searches returned Core `unknown_error`. Core restart reconnection and privacy checks passed or partially passed as documented; candidate/change/App restart/update tests were not run.
- The existing per-target App-version behavior applies to `0.3.2`: a retained `refresh_agents` or `refresh_all` selection refreshes its selected target once after the update. Select `preserve` before updating if that is not wanted.
- At release time, the published `0.3.2` image passed anonymous pull, exact-image memory/full/managed-auth/user-file and public `0.3.1` update regression; actual HAOS retesting remained separate.

### Testing

- Reproduce the live `unknown_error` boundary with source and installed-image WebSocket tests, assert the exact official automation payload, and verify combined null-config/related warnings without retaining the remote response.
- Add negative coverage proving server `timeout`/`unauthorized`/`invalid_format`/`home_assistant_error`, client timeout, malformed result envelopes, and array results still reject the snapshot, plus normalization coverage for config fallback references and exact provenance.
- In the subsequent public `0.3.2` HAOS/Core `2026.7.2` self-audit, the same related `unknown_error` appeared for 2 of 30 automations and was isolated as designed. Catalog/DB/CLI/MCP/privacy/candidate lifecycle, the post-restart forced fresh sync, and App restart persistence passed. The overall audit remained **PARTIAL with zero FAIL items** because the actual runtime OCI digest was unavailable and no Core disconnect/failed refresh was observed, so reconnect and the transient LKG stale/degraded state were not observed; null config was also not observed and fault injection/version-tagged update were not run.

## [0.3.1] - 2026-07-15

### Fixed

- Accept Home Assistant's successful `automation/config` response with `config: null` for an unavailable automation. The automation entity and its `search/related` graph remain indexable with an empty config and a bounded warning instead of aborting the entire catalog snapshot.
- Use the image-pinned `ws` runtime for the memory client with a handshake timeout, 32 MiB payload cap, disabled compression, and normal TLS verification, matching the App's other privileged WebSocket helpers.
- Preserve closed, machine-readable token, DNS, transport, timeout, authentication, protocol, command, and snapshot failure reasons in sync status and change verification. The daemon logs only an allowlisted reason code and never the captured command output.
- Reject valid JSON frames that are not protocol objects without crashing, and clear all pending parallel command timers before the transport closes after a partial failure.

### Security

- Remove the `HA_WS_URL` environment override so a caller cannot redirect the runtime Supervisor credential to an arbitrary WebSocket endpoint. Programmatic test endpoints require an explicit test credential and the production path remains fixed at the documented Supervisor proxy.
- Keep Supervisor authentication in the first WebSocket `auth` frame; do not add the credential to the HTTP Upgrade headers or send it to a direct-Core fallback.

### Upgrade notes

- The existing per-target App-version behavior applies to `0.3.1`: a retained `refresh_agents` or `refresh_all` selection refreshes its selected target once after the update. Select `preserve` before updating if that is not wanted.
- The supplied 0.3.0 read-only HAOS audit established the failure boundary but discarded the original WebSocket error. Automated tests cover the legal null-config response and diagnostic stages; actual HAOS catalog/restart/candidate verification remains separate until the published image is re-tested.

### Testing

- Add unit coverage for unavailable automation config, token/auth/DNS/protocol/timeout/command diagnostics, non-object frames, pending-request cleanup, remote-message and credential suppression, and rejection of environment endpoint redirection.
- Add an installed-image Supervisor-style WebSocket handshake/snapshot test using the actual pinned `ws` package, plus container checks for failed-refresh diagnosis, last-known-good preservation, and recovery.

## [0.3.0] - 2026-07-15

### Added

- Add a persistent, root-only SQLite/FTS5 Home Assistant memory store with a normalized index of areas, devices, entities, automations, and their registry/automation relationships.
- Add the non-blocking `ha-memoryd` S6 refresh service, the `ha-memory` administration CLI, and an optional image-managed `ha_memory` MCP server with bounded search and exact-subject tools.
- Add provenance-aware semantic memory candidates for aliases, purposes, preferences, relationships, and notes. Candidates must move through separate pending, verified, and applied states; repeated observations, explicit user evidence, fresh HA structure, and verified antigravity changes have distinct verification rules.
- Add pre-change subject and expectation-digest records, fresh post-change Home Assistant API verification against the same contract, conflict tracking, bounded audit history, and dependency-safe compensating rollback for semantic-memory events.

### Security

- Store only allowlisted registry and automation metadata plus typed semantic values and structured provenance labels. Raw current/history state values, timestamps, automation actions/templates, conversations, API responses, and credentials are excluded from durable memory; state may be compared during fresh verification, but only expectation/predicate digests, checked field names, and match booleans are retained. A verified change can validate a relationship candidate only through the exact source/relation/target existence predicate.
- Protect `/data/antigravity-ha-memory` as root-only storage, reject unsafe links/ownership/schema, use atomic WAL transactions and integrity checks, preserve the last-known-good catalog on refresh failure, and cap every normal search by query length, result count, relationships, applied memories, conflicts, and serialized bytes.
- Keep Home Assistant structural facts under fresh Core API authority and explicit user explanations above observations or model inference. Conflicts remain visible instead of silently replacing equal/higher-authority memory.

### Upgrade notes

- The new memory database is created automatically and survives normal App replacement through `/data`. Unsafe memory links/files fail closed without being followed or blocking the main App init. Initial Core indexing runs in a separate retrying service, so an unavailable Core or memory database does not block Web UI, SSH, antigravity, or browser startup.
- Existing user `config.toml` and `AGENTS.md` remain subject to `antigravity_user_files_update_mode`. The image-managed system config still supplies the optional memory MCP and its operating rules; start a new antigravity session after updating to discover it.
- A retained `refresh_agents` or `refresh_all` selection runs once again for its selected targets at version `0.3.0`. Select `preserve` before updating if that reset is not wanted.

### Testing

- Add fixture-driven Node/SQLite lifecycle coverage for bootstrap, state/entity-registry automation union including disabled registry-only entries, normalized relationships, raw/transient byte exclusion, candidate verification/application, exact change-predicate binding, stronger-provenance deduplication, source precedence, conflicts, precommitted fresh change success/mismatch, bounded search, dependency-safe history/rollback, and concurrent atomic refresh failure.
- Add static packaging/S6/MCP/schema contracts and a container smoke covering unsafe and broken init/SQLite auxiliary links, root-only permissions, CLI and real MCP tool calls, active-automation detail failure, persistence across replacement, and raw sentinel exclusion.

## [0.2.4] - 2026-07-14

### Changed

- Publish a validation/evidence patch with no runtime feature or security-policy changes relative to public `0.2.3`.
- Record the user's successful Home Assistant Configuration UI/Supervisor normal update on public `0.2.3`.
- Record the user's successful authenticated `http://127.0.0.1:8099` dashboard verification on real HAOS with AppArmor enabled, covering desktop/mobile rendering, console, network/static resources, and the Core WebSocket path.

### Upgrade notes

- The existing per-target App-version behavior still applies even though this is an evidence-only patch. Installations that leave `antigravity_user_files_update_mode` set to `refresh_agents` or `refresh_all` will refresh the selected target once again when the App version changes to `0.2.4`.
- To avoid that reapplication, save `antigravity_user_files_update_mode: preserve` in the Home Assistant Configuration UI **before** updating to `0.2.4`.

### Testing

- Keep the public `0.2.3` HAOS user confirmation separate from the automated `0.2.4` candidate regression and release checks.
- Do not infer or publish an HAOS version, screenshots, or detailed execution logs that the user did not provide. Existing automated negative tests continue to cover token redaction, hostile environment handling, managed-auth lifecycle, and unsafe user-file targets; those checks are not claimed as part of the new HAOS user confirmation.

## [0.2.3] - 2026-07-14

### Added

- Add the `home_assistant_browser_auto_auth` App setting, enabled by default, to create or reuse the dedicated local-only `system-read-only` browser identity without a terminal setup step.
- Add `ha-browser-auth-ensure` so App initialization and each new Playwright MCP process converge on the configured managed or manual authentication source.
- Add `antigravity_user_files_update_mode` with `preserve` (default), `refresh_agents`, and `refresh_all` choices so Home Assistant Web UI updates can optionally reset the image-managed base guidance or both guidance and the current App-option-based default antigravity configuration.
- Add root-only pre-refresh backups, crash-recovery metadata, and per-target App-version state for selected user-file updates.

### Changed

- Treat a missing automatic-auth option as enabled so existing installations gain the new default after a normal update; disabling it takes effect for the next App/MCP browser session and preserves the managed identity for later reactivation.
- Inject an image-managed antigravity developer instruction and Playwright navigation-tool guidance that direct Home Assistant dashboard checks immediately to `http://127.0.0.1:8099/` instead of first searching for another browser skill or probing Core/external URLs.
- Keep the manual `home_assistant_browser_token` as an explicit override only while automatic authentication is enabled; OFF suppresses all automatic token injection.
- Treat a missing user-file update option as `preserve`, so a normal public `0.2.2` to `0.2.3` update changes no existing `config.toml` or `AGENTS.md`. Users may choose a refresh after the new Configuration field appears and restart the App.
- Apply each selected target at most once per App version. Keeping a refresh mode selected applies it once again on the next version; returning to `preserve` makes the selection one-off.
- Preserve `AGENTS.override.md` at its higher precedence and exclude antigravity authentication/sessions, SSH and browser identities, App options, and the entire Home Assistant `/config` tree from user-file refreshes.

### Security

- Continue to validate the exact local-only/read-only user and single managed LLAT before browser injection; automatic provisioning does not add trusted networks, change authentication providers, edit `.storage`, or expose the Supervisor credential to Chromium.
- Do not delete the Home Assistant user or persistent recovery material when the setting is turned off. Complete identity deletion remains an explicit `ha-browser-auth-remove` operation.
- Require automatic authentication to be OFF before `ha-browser-auth-remove` can delete the identity, preventing the next automatic ensure from silently recreating what the user intended to remove permanently.
- Warn that `refresh_all` resets user MCP, model, provider, trust, endpoint, and other antigravity settings; preserve the original bytes in `0700`/`0600` backup storage that must itself be treated as a credential.
- Preflight every selected target and fail closed without following symbolic links, overwriting multiply linked files, or mutating non-regular/unsafe paths. Commit replacements atomically only after all targets and backups verify.

### Testing

- Cover default-ON fresh/update behavior, automatic creation, restart reuse, OFF/ON preservation and reactivation, ON-state removal refusal, OFF-state removal, manual override suppression, and OFF-state setup refusal in the managed authentication smoke suite.
- Verify the 8099 route in model-visible `antigravity debug prompt-input` output and in the filtered Playwright `browser_navigate` tool description, alongside the existing desktop/mobile, console, network, update, and credential-redaction checks.
- Cover the default/missing preserve path, agents-only and all-target refreshes, per-version/per-target one-shot behavior, private byte-exact backups, restart idempotency, crash recovery, and unsafe symlink/hardlink/non-regular rejection without changing protected identities or `/config`.
- Keep the actual Home Assistant Configuration UI/Supervisor update and HAOS/AppArmor dashboard path explicitly **NOT RUN** until verified on a real installation.

## [0.2.2] - 2026-07-14

### Added

- Add `ha-browser-auth-setup` to create a dedicated active, local-only `system-read-only` Home Assistant browser user, complete the official local login flow, mint its long-lived token, and activate it without asking the user to copy a token.
- Add `ha-browser-auth-remove` for policy-checked identity cleanup and `ha-browser-auth-refresh` for automatic revalidation and reuse after App restart or update.

### Changed

- Prefer a validated manual `home_assistant_browser_token` when explicitly configured; otherwise reuse the App-managed credential stored privately under `/data/browser-auth`.
- Revalidate the managed identity, exact single-token invariant, and credential-free user at App initialization and before every Playwright MCP launch.
- Verify the internal Home Assistant HTTPS upstream against the image CA bundle and the `homeassistant` hostname; certificate, DNS, TLS, or Core outages now disable runtime auto-login without destroying recovery state.

### Security

- Use only official Home Assistant admin/user WebSocket commands and login/token/revoke HTTP endpoints; do not edit `configuration.yaml`, `.storage`, auth-provider order, `trusted_networks`, or `trusted_proxies`.
- Journal setup state and the managed LLAT in root-only `0700`/`0600` storage, remove the temporary password credential and OAuth refresh token automatically, and keep non-ready state unavailable to Chromium.
- Serialize setup/removal with a kernel `flock`, verify self-revocation by reconnecting, preserve ambiguous `local_only` rejections, and fail closed on policy, credential, ownership, TLS, or transport mismatches.

### Testing

- Add a Home Assistant 2026.7.1-compatible auth fixture covering setup, reuse, App replacement, token rotation, exact token cleanup, ambiguous source rejection, concurrent operations, Core/provider failures, policy mutation, removal, and rollback without logging credentials.
- Run managed-auth smoke in CI alongside the existing real Chromium desktop/mobile screenshot, console, network, Core REST/WebSocket, loopback isolation, SSH, ttyd, and persistence smoke suite.
- Verify update replacement from public `0.2.1` to the `0.2.2` candidate while preserving `/data`, `/config`, antigravity credentials/configuration, App options, operating guidance, and SSH identity.

## [0.2.1] - 2026-07-14

### Added

- Add `ha-browser-network-info` to report the current App socket source, Home Assistant peer and Supervisor-reported App address without exposing credentials or changing Home Assistant configuration.
- Add a masked optional browser token setting, exact read-only/local-only user validation, and runtime authentication status diagnostics.
- Add supported WebSocket-based helpers for creating a dedicated `system-read-only` user and removing its temporary password credential after a long-lived token is configured.

### Changed

- Send frontend, authentication, REST and WebSocket traffic through the same direct Core upstream so the dedicated user's permissions apply to the whole dashboard session.
- Disable Home Assistant dashboard auto-login when the dedicated credential is absent, invalid, inactive, over-privileged, not local-only, or belongs to more than the read-only group.

### Security

- Do not add the dynamic App `/32`, the Docker App pool, or a synthetic forwarded address to `trusted_networks` or `trusted_proxies`; a released App address can be reassigned to another App after recreation.
- Keep the existing `homeassistant` authentication provider untouched, never edit `configuration.yaml` or `.storage`, and fail closed instead of falling back to the Supervisor/system credential.
- Exclude the Supervisor token from antigravity MCP `env_vars`; use it only in the launcher to revalidate the dedicated user at App initialization and each MCP launch, then remove it before the Node proxy and browser child start.
- Reject inherited browser token, WebSocket endpoint, `BASH_ENV`, and `ENV` values; hard-code policy checks to the internal Supervisor Core WebSocket, inject only the revalidated dedicated-user token at the two loopback browser origins, and clear forwarded-client identity headers on the Core gateway.
- Do not enable Playwright `--secrets`, whose form-input substitution could disclose the browser token to a page; redact exact token text in the managed proxy instead and test the path with a reflection fixture.
- Start the system MCP through a clean `env -i` boundary, remove inherited `PLAYWRIGHT_MCP_*`, `NODE_OPTIONS` and `NODE_PATH` before validation, and give the Playwright child only a fixed environment allowlist.

### Testing

- Cross-check Docker's App address, the browser gateway socket source, Supervisor self report and the Chromium/Core fixture's observed peer, and reproduce reuse of a released container address by another container.
- Exercise direct Core REST/WebSocket authentication with a dedicated read-only token, reject broader user policies and inherited environment tokens, and capture the internal gateway itself at desktop/mobile sizes with console, network, loopback isolation and secret-redaction coverage.
- Verify a public `0.2.0` to candidate update preserves `/data`, `/config`, SSH identity and the masked browser token option.
- Keep live HAOS `8099` dashboard rendering explicitly unverified until the candidate is updated on the user's App and tested inside that container namespace.

## [0.2.0] - 2026-07-14

### Added

- Add an image-pinned Microsoft Playwright MCP runtime and headless Chromium so antigravity can navigate, inspect, interact with, and capture real Web UIs without a runtime browser download.
- Register Playwright as an image-managed antigravity system MCP with desktop/mobile viewport resizing, screenshots, DOM snapshots, console messages, and network/resource status tools.
- Add a loopback-only Home Assistant browser gateway at `http://127.0.0.1:8099/` that combines frontend assets with the supported Core REST and WebSocket proxy paths.

### Changed

- Extend the default Home Assistant operating guidance with a rendered UI validation loop and browser-specific safety boundaries.
- Keep browser sessions isolated, force generated files under `/run`, and cap managed browser output with a 50 MiB eviction limit.

### Security

- Preserve the existing `/data/antigravity/config.toml` and install the browser server in lower-precedence `/etc/antigravity/config.toml`, so a normal update neither overwrites user settings nor requires a new antigravity login.
- Reuse the protected runtime environment to pass the Supervisor token to the MCP process, register a root-only ephemeral secrets file for exact-value redaction, and inject the token only for the loopback Home Assistant origin.
- Expose a browser tool allowlist that omits arbitrary page-code execution, unrestricted file access, file upload, persistent profiles, and externally listening browser ports.

### Testing

- Add policy coverage for the pinned MCP lockfile, system antigravity configuration, browser tool allowlist, loopback gateway, ephemeral secret handling, and forbidden privilege regression.
- Add a real stdio MCP smoke flow covering desktop and mobile screenshots, console errors, successful and failed resource requests, and token redaction.
- Exercise the loopback Home Assistant gateway against mock Supervisor/Core services, including authenticated REST, frontend rendering, WebSocket upgrade, external reachability denial, and runtime-output cleanup.
- Replace the public `0.1.3` container with the candidate on the same named `/data` and `/config` volumes, preserving antigravity settings, an authentication marker, operating guidance, Home Assistant configuration, and SSH identity while enabling the new MCP.
- Keep actual HAOS/AppArmor execution and authenticated live dashboard rendering as explicit post-update E2E checks rather than claiming them from a standalone Docker test.

## [0.1.3] - 2026-07-13

### Added

- Publish an amd64 image and preferred generic manifest at `ghcr.io/kanu-coffee/antigravity-for-home-assistant:0.1.3` with the official Home Assistant builder actions.
- Add a My Home Assistant one-click App repository button and clarify that Supervisor Apps are not a supported HACS repository type.

### Changed

- Promote the HAOS-validated `0.1.3-dev` payload to the first non-dev release while retaining `stage: experimental` and amd64-only support.
- Download the pre-built public GHCR image during install/update instead of building the Dockerfile on the Home Assistant host.
- Gate registry publishing on an exact numeric Git tag and refuse to overwrite an existing generic or per-architecture GHCR version tag.

### Security

- Publish with the repository-scoped GitHub Actions token and explicit `contents: read`, `packages: write`, and `id-token: write` permissions; no long-lived registry credential is stored.
- Keep the transition update-only and non-destructive: the runtime, options, `/data` format, antigravity credentials, and SSH host keys are unchanged.

### Testing

- Confirm HAOS auto-start false/true, device-code login, restart credential persistence, SSH host identity persistence, and reversible Core notification create/dismiss calls.
- Require the public generic manifest to resolve anonymously as linux/amd64 and pass the full container smoke test before release completion.

## [0.1.3-dev] - 2026-07-13

### Added

- Add transparent Home Assistant `icon.png` and `logo.png` assets derived without distortion from the user-provided project mark, and display the logo in the public GitHub README.
- Extend the real ttyd WebSocket smoke test to prove terminal resize propagation and reattachment to the same tmux session, pane, and process within one running App container.
- Record the user-confirmed HAOS Web UI, authenticated antigravity, update-path credential persistence, and mobile Remote-to-SSH project workflow.

### Fixed

- Negotiate `text/x-log` in `ha-core-logs` and `ha-addon-logs` instead of sending the JSON-only `Accept` header that failed against live Core and App log endpoints.

### Security

- Allowlist API helper response media types so the new `--accept` option cannot inject arbitrary HTTP headers.
- Keep this release update-only and non-destructive: no migration or reset touches persistent `/data` content.

### Testing

- Add regression coverage for default JSON negotiation, log media negotiation, malformed Accept values, wrapper arguments, and Home Assistant brand asset dimensions.
- Confirm on HAOS that direct `text/x-log` requests and both log helpers return rc 0 with nonempty responses and no negotiation error.
- Confirm functional Web UI reconnection, conversation recovery, resize, and no recurring `clear` error on HAOS; the local real WebSocket smoke separately proves identical tmux session, pane, and process IDs.

## [0.1.2-dev] - 2026-07-13

### Added

- Add default global Home Assistant operating guidance at `/data/antigravity/AGENTS.md` when neither a global base nor override file exists.
- Separate diagnostic findings from authorization to modify automations, permissions, integrations, updates, restarts, or devices.

### Security

- Guide antigravity to protect secrets, prefer supported APIs over direct `.storage` edits, open Recorder databases read-only, run `ha-config-check` after configuration changes, and require explicit authorization for high-risk operations.
- Preserve existing `AGENTS.md`, `AGENTS.override.md`, empty files, and symbolic links without changing their content or permissions.
- Document that model guidance is defense in depth rather than an enforcement boundary.

### Testing

- Verify default guidance creation, mode, safety content, init/restart persistence, and existing override preservation in policy and amd64 container smoke tests.
- Record the user's successful HAOS Web UI and authenticated antigravity execution, `/config` write, and selected Supervisor information/log/config-check endpoints without overstating untested service calls or restart operations.

## [0.1.1-dev] - 2026-07-13

### Fixed

- Restore `TERM=xterm-256color` after S6 `with-contenv` removes ttyd's per-PTY value, preventing tmux from exiting with `terminal does not support clear`.
- Preserve tmux's own `TERM=tmux-256color` in the session shell instead of rebuilding its environment through `with-contenv`.
- Force all `rootfs` files to LF in Git so Windows checkouts cannot produce broken container shebangs.

### Testing

- Added a dependency-free real ttyd WebSocket handshake and shell command smoke test that requires `/config` and a non-dumb TERM.
- Reproduced the failure and verified the fix with S6, ttyd 1.7.7, tmux 3.6b, and headless Chrome.
- HAOS public repository install/start and Ingress HTTP/token/WebSocket transport were confirmed; the fixed `0.1.1-dev` terminal UI still requires user retest on HAOS.

## [0.1.0-dev] - 2026-07-13

### Added

- amd64 Home Assistant App manifest with admin-only Ingress, `/config` read-write mapping, Core API access, and Supervisor `manager` role.
- OpenAI antigravity CLI 0.144.1 from the official x86_64 musl release archive with a pinned SHA-256 check.
- Persistent `HOME=/data/home` and `ANTIGRAVITY_HOME=/data/antigravity`, file credential storage, and `ha-antigravity`/`ha-antigravity-login` commands.
- A non-destructive `antigravity` wrapper that applies current approval/sandbox App options to CLI and Remote app-server launches.
- Ingress terminal using nginx, ttyd, and a shared tmux session, including optional one-time antigravity auto-start.
- Public-key-only OpenSSH on container port 22 with default Network mapping 2223, persistent host keys, and disabled SSH when no valid authorized key is configured.
- Core and Supervisor REST helpers with HTTP/result error handling and token redaction, plus config-check and log commands.
- English and Korean App option/Network translations and operator documentation.
- Public Home Assistant App repository metadata and direct App Store repository URL installation instructions.

### Security

- Kept AppArmor enabled and omitted Supervisor `admin`, Docker API, `full_access`, and host networking.
- Applied `0700` to secret directories, `0600` to antigravity credentials, authorized keys and SSH private keys, and `0644` to SSH public host keys.
- Documented that `/config` read-write and runtime API access are intentional high-risk capabilities.

### Known limitations

- No registry `image` is configured; this public development repository installs by building its Dockerfile on the amd64 Home Assistant host.
- Local Docker verification covers public-key SSH, password rejection, host-key/config persistence, degraded no-key operation, API helper error/redaction behavior, and the complete lint suite.
- Actual HAOS amd64 installation, Ingress/WebSocket behavior, device-auth persistence, Network port mapping, Windows SSH, direct ChatGPT mobile Remote SSH to the bundled antigravity app server on Alpine/musl, real Core service calls, and Supervisor `manager` endpoints remain unverified M2 work.
- Only amd64 is declared. aarch64 is not supported or claimed.
