import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONVERSATION_TTL_MS,
  MAX_SEALED_UPDATE_ENTRIES,
  acknowledgeUpdate,
  clearConversation,
  commitUpdateOffset,
  getConversation,
  loadBridgeState,
  loadSealedUpdates,
  registerSealedUpdateBatch,
  setConversation,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-state.mjs";

const BOT_TOKEN = `123456:${"A".repeat(35)}`;
const WRONG_BOT_TOKEN = `654321:${"B".repeat(35)}`;

function normalizedMessage(updateId, text = `update ${updateId}`) {
  return {
    updateId,
    kind: "message",
    value: {
      updateId,
      message_id: updateId + 1,
      from: { id: "10001" },
      chat: { id: "-20002", type: "private" },
      text,
    },
  };
}

function sealedRecord(updateId, text) {
  return { update_id: updateId, normalized: normalizedMessage(updateId, text) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "telegram-state-"));
  const managedRoot = join(root, "data", "antigravity-ha");
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  await chmod(managedRoot, 0o700);
  return { root, path: join(managedRoot, "telegram", "bridge-state.json") };
}

test("offset and opaque conversation binding persist without prompt or response content", async () => {
  const paths = await fixture();
  try {
    const now = Date.now();
    commitUpdateOffset(41, paths);
    setConversation("10001", "-20002", "conversation.abc-123", { ...paths, now });
    assert.equal(loadBridgeState(paths.path).update_offset, 41);
    assert.equal(getConversation("10001", "-20002", { ...paths, now: now + 1_000 }), "conversation.abc-123");
    assert.equal(getConversation("10002", "-20002", { ...paths, now: now + 1_000 }), null);
    const raw = await readFile(paths.path, "utf8");
    assert.equal(raw.includes("prompt"), false);
    assert.equal(raw.includes("response"), false);
    assert.equal((await stat(paths.path)).mode & 0o777, 0o600);
    assert.equal(clearConversation("10001", "-20002", paths), true);
    assert.equal(clearConversation("10001", "-20002", paths), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("conversation expires after 24 idle hours and update offset never moves backwards", async () => {
  const paths = await fixture();
  try {
    const now = Date.now();
    setConversation("10001", "-20002", "conversation-expiring", { ...paths, now });
    assert.equal(getConversation("10001", "-20002", {
      ...paths,
      now: now + CONVERSATION_TTL_MS + 1,
    }), null);
    commitUpdateOffset(100, paths);
    assert.throws(() => commitUpdateOffset(99, paths), /cannot move backwards/u);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("durable acknowledgement ledger commits only an observed completed prefix", async () => {
  const paths = await fixture();
  try {
    const registered = registerSealedUpdateBatch(
      [100, 102, 103].map((updateId) => sealedRecord(updateId)),
      BOT_TOKEN,
      paths,
    );
    assert.equal(registered.update_offset, 0);
    assert.equal(registered.transport_offset, 104);
    assert.deepEqual(registered.entries.map((entry) => entry.acknowledged), [false, false, false]);

    assert.equal(acknowledgeUpdate(102, paths), 0);
    const afterOutOfOrderCompletion = loadBridgeState(paths.path);
    assert.equal(afterOutOfOrderCompletion.update_offset, 0);
    assert.deepEqual(afterOutOfOrderCompletion.update_ledger, [
      { update_id: 100, acknowledged: false },
      { update_id: 102, acknowledged: true },
      { update_id: 103, acknowledged: false },
    ]);
    assert.throws(
      () => commitUpdateOffset(103, paths),
      /cannot pass an unacknowledged update/u,
    );

    assert.deepEqual(
      loadSealedUpdates(BOT_TOKEN, paths).map((update) => update.updateId),
      [100, 103],
    );
    assert.equal(acknowledgeUpdate(100, paths), 103);
    assert.deepEqual(loadBridgeState(paths.path).update_ledger, [
      { update_id: 103, acknowledged: false },
    ]);
    assert.equal(acknowledgeUpdate(103, paths), 104);
    assert.deepEqual(loadBridgeState(paths.path).update_ledger, []);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("version 3 acknowledgement state migrates without losing a later completed update", async () => {
  const paths = await fixture();
  try {
    await mkdir(join(paths.root, "data", "antigravity-ha", "telegram"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(paths.path, `${JSON.stringify({
      version: 3,
      update_offset: 0,
      update_ledger: [
        { update_id: 100, acknowledged: false },
        { update_id: 102, acknowledged: true },
      ],
      conversations: [],
    })}\n`, { encoding: "utf8", mode: 0o600 });
    const migrated = registerSealedUpdateBatch(
      [sealedRecord(100, "legacy pending")],
      BOT_TOKEN,
      paths,
    );
    assert.equal(migrated.transport_offset, 101);
    assert.equal(loadBridgeState(paths.path).version, 4);
    assert.equal(acknowledgeUpdate(100, paths), 103);
    assert.equal(loadBridgeState(paths.path).transport_offset, 103);
    assert.deepEqual(loadBridgeState(paths.path).sealed_updates, []);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("normalized updates are fsynced as sealed records before transport acknowledgement", async () => {
  const paths = await fixture();
  const canary = "SEALED_PROMPT_CANARY_DO_NOT_PERSIST_IN_PLAINTEXT";
  try {
    const result = registerSealedUpdateBatch(
      [sealedRecord(200, canary)],
      BOT_TOKEN,
      paths,
    );
    assert.equal(result.transport_offset, 201);
    assert.equal(loadBridgeState(paths.path).transport_offset, 201);
    const raw = await readFile(paths.path, "utf8");
    assert.equal(raw.includes(canary), false);
    assert.equal(raw.includes(BOT_TOKEN), false);
    assert.equal(loadSealedUpdates(BOT_TOKEN, paths)[0].value.text, canary);

    assert.equal(acknowledgeUpdate(200, paths), 201);
    const acknowledged = loadBridgeState(paths.path);
    assert.deepEqual(acknowledged.sealed_updates, []);
    assert.deepEqual(acknowledged.update_ledger, []);
    assert.equal((await readFile(paths.path, "utf8")).includes("ciphertext"), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("sealed spool rejects a wrong bot token and authenticated-record tampering", async () => {
  const paths = await fixture();
  try {
    registerSealedUpdateBatch([sealedRecord(300, "tamper canary")], BOT_TOKEN, paths);
    assert.throws(
      () => loadSealedUpdates(WRONG_BOT_TOKEN, paths),
      (error) => error?.code === "ETELEGRAMSPOOL",
    );

    const document = JSON.parse(await readFile(paths.path, "utf8"));
    const ciphertext = document.sealed_updates[0].ciphertext;
    document.sealed_updates[0].ciphertext = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
    await writeFile(paths.path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    assert.throws(
      () => loadSealedUpdates(BOT_TOKEN, paths),
      (error) => error?.code === "ETELEGRAMSPOOL",
    );
    assert.equal(loadBridgeState(paths.path).transport_offset, 301);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("sealed spool enforces independent entry and ciphertext byte bounds", async () => {
  const entryPaths = await fixture();
  try {
    registerSealedUpdateBatch(
      Array.from({ length: 100 }, (_, index) => sealedRecord(400 + index)),
      BOT_TOKEN,
      entryPaths,
    );
    assert.throws(
      () => registerSealedUpdateBatch(
        Array.from(
          { length: MAX_SEALED_UPDATE_ENTRIES - 99 },
          (_, index) => sealedRecord(500 + index),
        ),
        BOT_TOKEN,
        entryPaths,
      ),
      /ledger is full|spool is full/u,
    );
  } finally {
    await rm(entryPaths.root, { recursive: true, force: true });
  }

  const bytePaths = await fixture();
  try {
    const fullPrompt = "X".repeat(16 * 1024);
    registerSealedUpdateBatch(
      Array.from({ length: 100 }, (_, index) => sealedRecord(1_000 + index, fullPrompt)),
      BOT_TOKEN,
      bytePaths,
    );
    assert.throws(
      () => registerSealedUpdateBatch(
        Array.from({ length: 28 }, (_, index) => sealedRecord(1_100 + index, fullPrompt)),
        BOT_TOKEN,
        bytePaths,
      ),
      /byte limit/u,
    );
  } finally {
    await rm(bytePaths.root, { recursive: true, force: true });
  }
});
