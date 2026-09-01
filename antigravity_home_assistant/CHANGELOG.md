# Changelog

All notable changes to this App are documented in this file. Detailed pre-3.0
development history remains available in Git tags, commits, and published
releases; it is not current implementation guidance.

## [3.0.2] - 2026-09-01

### Changed

- Record the sanitized scope of a user-provided, read-only production self-check
  for App `3.0.0`. All seven observed categories were reported as `PASS`:
  Remote connection, `/config` access, managed Home Assistant tools, Ingress and
  browser configuration, memory configuration, removal of Telegram/SSH
  dependencies, and sensitive-path isolation.
- Remove the obsolete pre-3 implementation plans, channel-specific operations
  guide, old release procedure, and unreferenced terminal captures. Condense the
  pre-3 changelog while retaining the 2.1.3-to-3.0 upgrade boundary required by
  the current reset regression.
- Keep all active bilingual installation, troubleshooting, security, test, and
  release documentation focused on the official Antigravity Remote architecture.

### Evidence limits

- The supplied production report covers one `3.0.0` instance at
  `2026-08-31T23:22:00Z`. It does not state CPU architecture, immutable image
  digest, Git revision, or HAOS/Core/Supervisor versions, and it predates 3.0.2.
  It is therefore operational evidence for the reported instance, not
  architecture-qualified 3.0.2 release acceptance.
- Automated source, exact-digest container, and multi-architecture Candidate
  gates remain distinct from real HAOS evidence. Architecture-specific 3.0.2
  device results remain `NOT RUN` until recorded against the immutable release.

## [3.0.1] - 2026-09-01

### Fixed

- Serialize the interactive Remote login process with authenticated background
  startup so both Antigravity processes never share the same persistent state
  concurrently. Keep the persistent Remote name on the background service only.
- Document recovery from a stale Remote Dashboard project selection after the
  one-time 3.0 reset. A deleted project ID can make the first conversation fail
  with HTTP 500 `file does not exist`; selecting a new `/config` project or
  clearing the Dashboard site data restores conversation creation.

## [3.0.0] - 2026-09-01

### Changed

- Make official Google Antigravity Remote Control the only external control
  surface. Add the interactive `ha-antigravity-remote-login` URL/code flow,
  automatic authenticated startup after App/HAOS reboot, the configurable
  `remote_control_name` defaulting to `home-assistant`, and a loopback-only
  `4400–4499` launcher with no published external port. Ingress remains
  available for authentication, diagnostics, and recovery.
- Pin the `amd64` and `aarch64` Antigravity CLI to `1.1.22` and disable runtime
  self-update so the image and checksums own the installed binary.
- Reduce public configuration to `remote_control_name`,
  `antigravity_sensitive_data_access`, `home_assistant_browser_auto_auth`, and
  `log_level`.
- Use Antigravity native `deny > ask > allow` permissions and Remote approval UI
  as the single interactive permission contract. Preserve the AppArmor ceiling,
  model/Supervisor credential separation, bounded Home Assistant helpers,
  managed browser, verified memory, and `/ha-feedback`.

### Removed

- Remove the Telegram bridge, pairing/session/outbox state, approval cards,
  proposal MCP, channel options, and channel-specific policy translation.
- Remove the SSH server, published port, key options, persisted host-key state,
  and the 2.x proposal, permission, terminal, session, and migration-mode stack.

### Breaking reset

- On the first 3.0 start, delete `/data/home`, `/data/antigravity`,
  `/data/antigravity-ha`, `/data/antigravity-ha-memory`, `/data/browser-auth`,
  `/data/github-cli`, `/data/ssh`, and `/data/tmux` once, without an App-side
  backup. Preserve `/config`, `/share`, `/media`, and `/data/options.json`
  itself, then normalize Supervisor options to the four new defaults.
- Fail closed before deletion when a reset target is a symlink, resolves outside
  its literal path, or has unexpected ownership. Record completion atomically
  and safely retry an interrupted reset on the next start.
- Require Antigravity Remote/Google and GitHub authentication again after the
  reset. Managed browser identity, verified memory, and Antigravity
  customization also restart empty.

### Verification status

- At publication, source, component, container, and emulated-architecture
  results were not real-HAOS evidence. Fresh install, public 2.1.3 upgrade/reset,
  enforced AppArmor, Remote task/approval/reconnect, retained-feature regression,
  and rollback were `NOT RUN` on each real architecture.

## Pre-3.0 migration context

- `2.1.3` is the last 2.x public image used by the immutable upgrade regression.
  Its architecture-specific source image digests remain pinned in
  `tests/v3-upgrade-smoke.sh`; the test proves the exact one-time 3.0 reset and
  preservation boundary.
- Releases before 3.0 used Telegram, SSH, custom proposal/approval state, and a
  much larger option surface. None is a supported compatibility path in 3.x.
- Do not mix pre-3 and 3.x App-owned runtime data. Upgrade through the documented
  reset or restore a Home Assistant App backup made for the exact target version.
  Historical implementation details remain recoverable from Git tags, commits,
  and published releases.
