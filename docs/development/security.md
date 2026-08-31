# 3.0 security contract

## Trust model

Remote is an administrator control surface. Anyone who can use the authenticated
instance can ask Antigravity to read or change the Home Assistant project within
the enforced boundary. Ingress is available only through Home Assistant
authentication and exists for login, diagnostics, and recovery.

The design uses three complementary controls:

1. Google/Antigravity authenticates the Remote session.
2. Antigravity native fine-grained permissions decide `deny`, `ask`, or `allow`
   for tools, commands, files, URLs, and MCP operations. Precedence is
   `deny > ask > allow`.
3. AppArmor and scoped helpers impose a non-bypassable local ceiling regardless
   of a prompt or native permission decision.

## Mandatory protections

- The model process never receives the raw Supervisor token, browser token,
  OAuth material, authorization headers, private keys, or App runtime secrets.
- `secrets.yaml`, `.storage`, backup/SSL credentials, cloud credentials, and
  credential-bearing process data remain denied.
- Home Assistant/Recorder database writes remain denied. Optional sensitive
  access is diagnostic and read-only.
- Docker socket, host root/PID mounts, broad host networking, and disabling
  protection are outside the product contract.
- Project helpers reject symlinks, unexpected hardlinks, non-regular files,
  path traversal, and out-of-scope targets; writes are bounded and atomic.
- Logs, browser artifacts, memory, feedback reports, and status output must not
  contain authentication artifacts or raw tokens.
- Remote binds only `127.0.0.1`; the App publishes no Remote port.

Native permission configuration is the sole interactive approval contract.
App-managed hard denies remain image-owned. A new transport-specific approval
database, callback token, replay store, or execution broker must not be added.

## Credential separation

The startup controller writes Supervisor authorization to a root-owned runtime
file. Only the narrowly profiled helper may read it. The helper validates input,
uses fixed API routes or allowlisted operations, caps response size, redacts
known credential shapes, and returns no raw authorization headers.

Remote login requires a controlling TTY and uses the official printed URL/code
flow. Authentication files must be regular, single-link, correctly owned, and
private. Status messages may report only states such as missing, waiting,
authenticated, or invalid—not paths derived from secrets, token fragments,
account identifiers, or OAuth response bodies.

## Reset safety

The breaking reset has deletion authority only over the eight literal roots in
the product specification. It must:

- reject symlink, ownership, or resolved-path mismatch before deletion;
- never accept a user-supplied path, wildcard, or unresolved variable;
- preserve `/config`, `/share`, `/media`, and `/data/options.json` itself;
- be idempotent after interruption; and
- write its completion marker atomically only after all required steps succeed.

This is a no-backup reset. User documentation must present that warning before
upgrade and must not imply App-side recovery of deleted runtime data.

## Reporting

Security evidence uses sanitized reason classes and counts. Never publish raw
Core/Supervisor logs, browser screenshots, database rows, options, environment,
or authentication state. Suspected vulnerability, authentication bypass, or
credential exposure leaves the public `/ha-feedback` path and uses private
security reporting.
