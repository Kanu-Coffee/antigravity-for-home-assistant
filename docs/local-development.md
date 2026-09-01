# Local source-development setup

The root `AGENTS.md` describes this host source checkout. A host Codex session
does not have `/config`, `/data`, a Supervisor token, or the image-installed
commands, so it must not claim those runtime capabilities. The guidance shipped
inside the App is the separate rootfs file at
`antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/AGENTS.md`.

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

## HAOS VM development

The checkout-scoped VM helper can boot the pinned HAOS 18.2 OVA QCOW2 image on
the host's KVM/libvirt stack, run fixed sanitized HA CLI probes, and stage the
exact local App build in that disposable guest. It verifies the download's
pinned size and SHA-256 digest before preparing the base image.

The pin covers the HAOS 18.2 OS asset only. On a fresh boot, HAOS downloads the
then-current stable Supervisor, Core, and HA CLI components, so two fresh VMs
created from that asset are not necessarily byte-for-byte identical full
stacks. `status --json` records its observation time and the guest OS,
Supervisor, and Core versions it can observe; use those fields when comparing
runs instead of inferring the whole stack from the OS asset version.

First validate the host, fetch the image, and explicitly acknowledge the VM's
network access before creating it:

```bash
tools/development/haos-vm check
tools/development/haos-vm image-fetch
tools/development/haos-vm up --allow-outbound-network
tools/development/haos-vm wait --timeout 1800
tools/development/haos-vm status
tools/development/haos-vm status --json
```

`up` defaults to 4096 MiB and two vCPUs; use `--memory-mib` and `--vcpus` to
change them. It uses the system libvirt `default` NAT network. That network is
shared NAT, **not an isolated test network**: guest outbound traffic can reach
the host, LAN, and Internet. The required `--allow-outbound-network` flag is an
acknowledgement of that boundary, not a firewall or isolation control.

The helper provisions a checkout-dedicated debug SSH key without printing it.
`guest` accepts only the fixed, sanitized probes below; it is not an arbitrary
guest shell:

```bash
tools/development/haos-vm guest ha-info
tools/development/haos-vm guest os-info
tools/development/haos-vm guest supervisor-info
tools/development/haos-vm guest core-info
tools/development/haos-vm guest jobs
```

After `wait` succeeds, App staging requires a separate acknowledgement because
it loads an image and changes Supervisor state inside the disposable guest:

```bash
tools/development/haos-vm app-stage --allow-guest-mutation
tools/development/haos-vm app-smoke
```

If a staging attempt was interrupted after its exact image was recorded, retry
without rebuilding only after the helper revalidates the current Git revision,
source-rootfs digest, image ID, and image labels:

```bash
tools/development/haos-vm app-stage --allow-guest-mutation --reuse-exact-image
```

The source App relies on Home Assistant's default automatic boot behavior, so
Supervisor restarts it after a VM reboot. After `wait`, use `app-stage` only
when the exact checkout needs to be installed or refreshed, then run
`app-smoke`. `app-smoke` verifies the running App but never starts or changes it.

`app-stage` uses `tools/development/build-app` to build the exact checkout for
`linux/amd64`, then binds the source revision, source-rootfs digest, image tag,
and image ID. It pipes `docker image save` for only that image through the
dedicated debug SSH connection to guest `docker image load`. The checkout tree
is not copied or mounted into HAOS, and neither the host Docker socket nor an
App data directory is exposed to the guest.

Inside HAOS, the helper writes only its exact checkout marker and derived
`config.yaml` under
`/mnt/data/supervisor/apps/local/antigravity_home_assistant/`; it refuses an
existing directory whose marker does not match this checkout. Because
Supervisor deliberately pulls image-backed Apps during installation, the helper
briefly runs a digest-pinned OCI registry bound only to guest host loopback
(`127.0.0.1:5000`). Its exact container and volume carry the checkout marker;
foreign same-name resources are preserved and rejected. The helper pushes the
already verified image to that registry, reloads the Supervisor store, installs
or updates and starts `local_antigravity_home_assistant`, then removes the exact
temporary registry container and volume. The pinned registry image and exact App
tag may remain in the disposable guest image cache.

`app-smoke` verifies that the expected version is started and that both the
guest image tag and running `app_local_antigravity_home_assistant` container bind
to the same image ID produced on the host. These commands return whitelisted
status fields and build identifiers; they do not collect raw App logs,
Supervisor tokens, ingress credentials, or authorization headers.

Lifecycle operations validate the checkout identity, libvirt metadata, domain
UUID, and exact disk paths before acting:

```bash
tools/development/haos-vm stop
tools/development/haos-vm start
tools/development/haos-vm destroy
```

If graceful shutdown times out for this disposable VM, repeat `stop` or
`destroy` with `--force`. `destroy` removes only the exactly matched domain and
its per-run overlay, CONFIG disk, NVRAM, SSH key, and state. It preserves the
digest-verified base-image cache for reuse and refuses cleanup when ownership
checks do not match; it never performs a shared libvirt or QEMU prune.

Private state lives under ignored `.codex-log/haos-vm/`. QEMU-accessible disks
and the retained base-image cache live under a checkout-specific directory in
`/var/tmp`. This host's `systemd-tmpfiles` policy treats `/var/tmp` as 30-day
temporary storage, so those runtime files can be collected after 30 days of
inactivity and must not be treated as durable artifacts.

`status --json`, `guest`, `app-stage`, and `app-smoke` label their output with
`environment_kind: "haos_vm"`, `real_haos_device: false`, and
`release_evidence_eligible: false`. A successful VM result is useful operational
development evidence, but it is not real-device evidence and cannot satisfy an
HAOS release gate that requires physical-device results.

## What still requires the App or HAOS

Container checks can validate packaging, schemas, MCP transport, persistence,
redaction, and report generation. They cannot prove live Core/Supervisor access,
AppArmor enforcement, browser authentication, Antigravity OAuth/Remote connectivity,
device behavior, migration, update, or rollback. Keep those results `NOT RUN` or
`PARTIAL` until their defined real-device evidence is collected. HAOS VM checks
remain separately classified from real-device release evidence as described
above.

Codex's project configuration and override behavior are documented in the
[official MCP guide](https://developers.openai.com/codex/mcp/) and
[AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md/).
