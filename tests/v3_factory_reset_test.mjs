import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FactoryResetError,
  RESET_MARKER_NAME,
  RESET_TARGET_NAMES,
  runFactoryReset,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/v3-factory-reset.mjs";

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "antigravity-v3-reset-"));
  const requiredUid = (await lstat(dataRoot)).uid;
  return { dataRoot, requiredUid };
}

test("factory reset removes only the exact App-owned roots and is idempotent", async () => {
  const { dataRoot, requiredUid } = await fixture();
  await writeFile(join(dataRoot, "options.json"), '{"keep":true}\n');
  const configRoot = join(dataRoot, "config-canary");
  await mkdir(configRoot);
  await writeFile(join(configRoot, "configuration.yaml"), "keep\n");
  for (const name of RESET_TARGET_NAMES) {
    await mkdir(join(dataRoot, name), { recursive: true });
    await writeFile(join(dataRoot, name, "private"), name);
  }

  const first = runFactoryReset({ dataRoot, requiredUid });
  assert.equal(first.status, "reset");
  assert.equal(first.removed.length, RESET_TARGET_NAMES.length);
  for (const name of RESET_TARGET_NAMES) {
    await assert.rejects(lstat(join(dataRoot, name)), { code: "ENOENT" });
  }
  assert.equal(await readFile(join(dataRoot, "options.json"), "utf8"), '{"keep":true}\n');
  assert.equal(await readFile(join(configRoot, "configuration.yaml"), "utf8"), "keep\n");
  assert.equal((await lstat(join(dataRoot, RESET_MARKER_NAME))).mode & 0o777, 0o600);

  assert.deepEqual(runFactoryReset({ dataRoot, requiredUid }), {
    status: "already_complete",
    removed: [],
  });
});

test("factory reset rejects a symlink target before deleting anything", async () => {
  const { dataRoot, requiredUid } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "antigravity-v3-outside-"));
  await writeFile(join(outside, "keep"), "safe\n");
  await mkdir(join(dataRoot, "home"));
  await writeFile(join(dataRoot, "home", "keep"), "home\n");
  await symlink(outside, join(dataRoot, "ssh"));

  assert.throws(
    () => runFactoryReset({ dataRoot, requiredUid }),
    FactoryResetError,
  );
  assert.equal(await readFile(join(dataRoot, "home", "keep"), "utf8"), "home\n");
  assert.equal(await readFile(join(outside, "keep"), "utf8"), "safe\n");
});

test("factory reset rejects an invalid completion marker", async () => {
  const { dataRoot, requiredUid } = await fixture();
  const marker = join(dataRoot, RESET_MARKER_NAME);
  await writeFile(marker, "{}\n", { mode: 0o600 });
  await chmod(marker, 0o600);
  assert.throws(
    () => runFactoryReset({ dataRoot, requiredUid }),
    FactoryResetError,
  );
});
