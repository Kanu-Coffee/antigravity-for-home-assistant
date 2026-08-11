import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  consumePairing,
  createPairing,
  hasPairingBootstrap,
  isPaired,
  listPairings,
  revokePairing,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-pairing.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "telegram-pairing-"));
  const managedRoot = join(root, "data", "antigravity-ha");
  const runRoot = join(root, "run", "antigravity-ha");
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  await chmod(managedRoot, 0o700);
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700);
  return {
    root,
    statePath: join(managedRoot, "telegram", "authorizations.json"),
    lockPath: join(runRoot, "pairing.lock"),
  };
}

test("pairing token is digest-only, one-time, and private-chat only", async () => {
  const paths = await fixture();
  try {
    const now = Date.now();
    const pairing = createPairing({ ...paths, ttlMs: 5 * 60_000, now });
    assert.match(pairing.token, /^[A-Za-z0-9_-]{32}$/u);
    assert.equal(hasPairingBootstrap({ statePath: paths.statePath }), true);
    const stored = await readFile(paths.statePath, "utf8");
    assert.equal(stored.includes(pairing.token), false);
    assert.equal((await stat(paths.statePath)).mode & 0o777, 0o600);

    assert.equal(consumePairing(pairing.token, "10001", "-20002", {
      ...paths,
      chatType: "group",
      now: now + 500,
    }), null);
    const authorization = consumePairing(pairing.token, "10001", "10001", {
      ...paths,
      chatType: "private",
      now: now + 1_000,
    });
    assert.match(authorization.authorization_id, /^[A-Za-z0-9_-]{20,64}$/u);
    assert.equal(isPaired("10001", "10001", {
      statePath: paths.statePath,
      chatType: "private",
    }), true);
    assert.equal(isPaired("10001", "10001", {
      statePath: paths.statePath,
      chatType: "group",
    }), false);
    assert.equal(isPaired("10002", "10002", {
      statePath: paths.statePath,
      chatType: "private",
    }), false);
    assert.equal(consumePairing(pairing.token, "10001", "10001", {
      ...paths,
      chatType: "private",
      now: now + 2_000,
    }), null);

    const listing = listPairings({ ...paths, now: now + 2_000 });
    assert.equal(listing.pending.length, 0);
    assert.equal(listing.authorizations.length, 1);
    assert.equal(revokePairing(authorization.authorization_id, paths), true);
    assert.equal(revokePairing(authorization.authorization_id, paths), false);
    assert.equal(isPaired("10001", "10001", {
      statePath: paths.statePath,
      chatType: "private",
    }), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("expired or malformed tokens reveal no pairing state", async () => {
  const paths = await fixture();
  try {
    const now = Date.now();
    const pairing = createPairing({ ...paths, ttlMs: 1_000, now });
    assert.equal(consumePairing(pairing.token, "10001", "10001", {
      ...paths,
      chatType: "private",
      now: now + 1_001,
    }), null);
    assert.equal(consumePairing("not-a-valid-token", "10001", "10001", {
      ...paths,
      chatType: "private",
    }), null);
    assert.equal(listPairings({ ...paths, now: now + 1_001 }).pending.length, 0);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
