import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ChangeBroker,
  sha256Digest,
} from "/usr/local/share/antigravity-ha/ha-change-broker.mjs";

const TOKEN = "installed-change-broker-token-canary";
const REQUESTER = {
  surface: "telegram",
  user_id: "10001",
  chat_id: "-20002",
};

function response(status, value) {
  return {
    status,
    async text() {
      return JSON.stringify(value);
    },
  };
}

const root = await mkdtemp(join(tmpdir(), "installed-change-broker-"));
const configRoot = join(root, "config");
const dataRoot = join(root, "data");
const target = join(configRoot, "input_boolean.yaml");
const original = "installed_guard:\n  name: Blue Installed\n";
const replacement = "installed_guard:\n  name: Green Installed\n";
let activeName = "Blue Installed";
const calls = [];

try {
  await mkdir(configRoot, { mode: 0o700 });
  await chmod(configRoot, 0o700);
  await writeFile(
    join(configRoot, "configuration.yaml"),
    "input_boolean: !include input_boolean.yaml\n",
    { mode: 0o600 },
  );
  await writeFile(target, original, { mode: 0o600 });

  const fetchImpl = async (url, options = {}) => {
    assert.equal(options.headers?.Authorization, `Bearer ${TOKEN}`);
    calls.push({ url, method: options.method });
    if (url.endsWith("/core/check")) return response(200, { result: "ok" });
    if (url.endsWith("/services/input_boolean/reload")) {
      activeName = "Green Installed";
      return response(200, []);
    }
    if (url.endsWith("/states/input_boolean.installed_guard")) {
      return response(200, {
        entity_id: "input_boolean.installed_guard",
        state: "off",
        attributes: { friendly_name: activeName },
      });
    }
    return response(404, { message: "fixture endpoint missing" });
  };

  const broker = new ChangeBroker({
    configRoot,
    dataRoot,
    supervisorToken: TOKEN,
    supervisorUrl: "http://supervisor.fixture",
    haUrl: "http://supervisor.fixture/core/api",
    fetchImpl,
    sleep: async () => {},
    audit: () => {},
    requiredUid: process.getuid(),
  });
  await broker.initialize();
  const proposal = await broker.propose({
    requester: REQUESTER,
    operation: "config_patch",
    summary: "Installed broker memory boundary smoke",
    payload: {
      path: "input_boolean.yaml",
      expected_sha256: sha256Digest(original),
      content: replacement,
      activation: { kind: "input_boolean_reload" },
    },
  });
  const authorization = broker.authorize({
    proposal_id: proposal.proposal_id,
    requester: REQUESTER,
    preview_digest: proposal.preview_digest,
    authorization: "human_confirmed",
  });
  const result = await broker.execute({
    proposal_id: proposal.proposal_id,
    requester: REQUESTER,
    preview_digest: proposal.preview_digest,
    capability: authorization.capability,
    idempotency_key: "installed-memory-boundary-0001",
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.changed, true);
  assert.equal(result.reload, "input_boolean.reload");
  assert.equal(result.fresh_verification, "memory_verified");
  assert.equal(await readFile(target, "utf8"), replacement);
  assert.equal(
    calls.some((call) => call.url.endsWith("/services/input_boolean/reload")),
    true,
  );
  process.stdout.write("installed change broker memory boundary passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
