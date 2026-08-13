# Local source-development setup

The root `AGENTS.md` describes this host source checkout. A host Codex session
does not have `/config`, `/data`, a Supervisor token, or the image-installed
commands, so it must not claim those runtime capabilities. The guidance shipped
inside the App is the separate rootfs file at
`antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/AGENTS.md`.

The older Codex for Home Assistant project followed the same fundamental model:
memory and feedback were exercised inside built images and fixture-based smoke
tests rather than installed globally on the development host. Antigravity already
ships both implementations; this setup makes safe, limited equivalents available
to host development.

## Install

Requirements are Git, Docker, and Node.js. From the repository root, run:

```bash
tools/development/setup install
```

The command changes no Codex instructions or system configuration. It:

- populates Docker's image cache with a digest-pinned public 2.0.2 App image;
- creates a dedicated Docker volume for development memory; and
- probes the MCP over standard input/output with networking disabled.

It does not modify either `AGENTS.md`, global Git settings,
`~/.codex/config.toml`, system binaries, or Home Assistant data. Run
`tools/development/setup check` later to revalidate the development tools.

Start a **new Codex session** in the trusted repository after installation.
Codex discovers the root `AGENTS.md`, project `.codex/config.toml`, and project
skills at session startup.

## Development memory

The `ha_memory_development` MCP starts the shipped memory server in a hardened
container with no network, no capabilities, a read-only image filesystem, no
Supervisor credential, and no live HA mounts. Project configuration exposes only
the read-only `memory_search` and `memory_status` tools.

The dedicated volume is intentionally separate from real App memory. An empty or
stale development result is not a verified Home Assistant no-result. Do not use
this store as evidence for HAOS behavior or as a substitute for the App's
candidate/change verification workflow. Setup never deletes this volume; reset is
an explicit operator action.

## Development feedback

Use the repository helper rather than a nonexistent host system command:

```bash
tools/development/ha-feedback collect bug --input /private/path/input.json
tools/development/ha-feedback validate <report-path>
tools/development/ha-feedback render <report-path>
```

The input must satisfy the production helper's private-file checks. The wrapper
runs the current source in test mode with an empty environment and private local
state under `.codex-log/`. GitHub login, status, URL, and submission operations
are disabled, so this workflow cannot publish or use ambient credentials.

The helper mounts only the current feedback source, the selected private input,
and its dedicated output directory into the same hardened, networkless image.
Host `/run`, system binaries, Home Assistant data, and credentials are outside
that filesystem boundary. The `ha-feedback-development` project skill guides
natural-language bug and feature investigations through the same boundary.

## What still requires the App or HAOS

Container checks can validate packaging, schemas, MCP transport, persistence,
redaction, and report generation. They cannot prove live Core/Supervisor access,
AppArmor enforcement, browser authentication, OAuth, Telegram connectivity,
device behavior, migration, update, or rollback. Keep those results `NOT RUN` or
`PARTIAL` until their defined real-device evidence is collected.

Codex's project configuration and override behavior are documented in the
[official MCP guide](https://developers.openai.com/codex/mcp/) and
[AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md/).
