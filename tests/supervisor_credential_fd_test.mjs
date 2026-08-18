import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { consumeSupervisorCredentialFromInheritedFd } from
  "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/supervisor-credential-fd.mjs";

const CHILD_MODE = process.env.SUPERVISOR_FD_TEST_CHILD === "1";

if (CHILD_MODE) {
  const descriptor = Number(process.env.ANTIGRAVITY_HA_SUPERVISOR_FD);
  try {
    const token = consumeSupervisorCredentialFromInheritedFd({
      environment: process.env,
      requiredUid: Number(process.env.SUPERVISOR_FD_TEST_UID),
    });
    let descriptorClosed = false;
    try {
      fstatSync(descriptor);
    } catch (error) {
      descriptorClosed = error?.code === "EBADF";
    }
    process.stdout.write(`${JSON.stringify({
      token,
      descriptorClosed,
      fdEnvironmentRemoved: !Object.hasOwn(
        process.env,
        "ANTIGRAVITY_HA_SUPERVISOR_FD",
      ),
      tokenEnvironmentRemoved: !Object.hasOwn(process.env, "SUPERVISOR_TOKEN"),
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}

async function credentialFixture(value, mode = 0o400) {
  const root = await mkdtemp(join(tmpdir(), "supervisor-fd-"));
  const path = join(root, "credential");
  await writeFile(path, value, { mode });
  await chmod(path, mode);
  const handle = await open(path, "r");
  return { handle, path, root };
}

if (!CHILD_MODE) {
  test("anonymous pipe credential is consumed, closed, and removed from the environment", () => {
    const bashScript = String.raw`
exec {credential_fd}< <(/usr/bin/printf '%s' "$1")
writer_pid=$!
wait "$writer_pid"
exec /usr/bin/env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  SUPERVISOR_TOKEN=hostile-environment-token \
  ANTIGRAVITY_HA_SUPERVISOR_FD="$credential_fd" \
  SUPERVISOR_FD_TEST_CHILD=1 \
  SUPERVISOR_FD_TEST_UID="$2" \
  "$3" "$4"
`;
    const result = spawnSync(
      "/bin/bash",
      [
        "-ceu",
        bashScript,
        "supervisor-fd-fixture",
        "FD_CREDENTIAL_CANARY_123456789",
        String(process.getuid()),
        process.execPath,
        fileURLToPath(import.meta.url),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      token: "FD_CREDENTIAL_CANARY_123456789",
      descriptorClosed: true,
      fdEnvironmentRemoved: true,
      tokenEnvironmentRemoved: true,
    });
  });

  test("regular-file credential descriptors fail closed and are still consumed", async () => {
    const fixture = await credentialFixture("unsafe-regular-file-canary", 0o400);
    const environment = {
      ANTIGRAVITY_HA_SUPERVISOR_FD: String(fixture.handle.fd),
      SUPERVISOR_TOKEN: "must-be-deleted",
    };
    try {
      assert.throws(
        () => consumeSupervisorCredentialFromInheritedFd({
          environment,
          requiredUid: process.getuid(),
        }),
        /descriptor is unsafe/u,
      );
      assert.deepEqual(environment, {});
      await assert.rejects(fixture.handle.readFile(), /file closed|EBADF/iu);
    } finally {
      await fixture.handle.close().catch(() => {});
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

}
