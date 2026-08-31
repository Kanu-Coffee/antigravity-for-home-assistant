import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  COMPLETION_SCHEMA,
  DEFAULT_OPTIONS,
  OptionsResetError,
  SUPERVISOR_OPTIONS_URL,
  performFixedSupervisorRequest,
  resetSupervisorOptions,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/supervisor-options-migrate.mjs";

const REQUIRED_UID = process.getuid();
const TOKEN = "fixture-supervisor-token-never-use";

function fixture({ credential = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "v3-options-reset."));
  const runtimeRoot = join(root, "run");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  chmodSync(runtimeRoot, 0o700);
  const credentialPath = join(runtimeRoot, "supervisor.token");
  const completionPath = join(root, "completed.json");
  if (credential) {
    writeFileSync(credentialPath, TOKEN, { mode: 0o400 });
    chmodSync(credentialPath, 0o400);
  }
  return { completionPath, credentialPath, root, runtimeRoot };
}

test("posts exactly the 3.0 public defaults once", () => {
  const value = fixture();
  try {
    let observed;
    assert.deepEqual(
      resetSupervisorOptions({
        ...value,
        requestImpl: ({ payload, token }) => {
          observed = payload;
          assert.equal(token, TOKEN);
        },
        requiredUid: REQUIRED_UID,
      }),
      { status: "reset" },
    );
    assert.deepEqual(observed, { options: { ...DEFAULT_OPTIONS } });
    assert.equal(statSync(value.completionPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(value.completionPath, "utf8")), {
      schema: COMPLETION_SCHEMA,
      completed: true,
    });

    rmSync(value.credentialPath);
    assert.deepEqual(
      resetSupervisorOptions({
        ...value,
        requestImpl: () => assert.fail("completed reset must not repeat"),
        requiredUid: REQUIRED_UID,
      }),
      { status: "already_complete" },
    );
  } finally {
    rmSync(value.root, { force: true, recursive: true });
  }
});

test("missing credential leaves reset retryable", () => {
  const value = fixture({ credential: false });
  try {
    assert.throws(
      () =>
        resetSupervisorOptions({
          ...value,
          requestImpl: () => assert.fail("request must not run"),
          requiredUid: REQUIRED_UID,
        }),
      OptionsResetError,
    );
    assert.equal(existsSync(value.completionPath), false);
  } finally {
    rmSync(value.root, { force: true, recursive: true });
  }
});

test("fixed Supervisor request keeps token and body out of argv", () => {
  const value = fixture();
  let temporaryDirectory;
  try {
    const spawnSyncImpl = (command, args, options) => {
      assert.equal(command, "/usr/bin/curl");
      assert.equal(args.at(-1), SUPERVISOR_OPTIONS_URL);
      assert.equal(JSON.stringify(args).includes(TOKEN), false);
      assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LANG", "LC_ALL", "PATH"]);
      const headerPath = args[args.indexOf("--header") + 1].slice(1);
      const requestPath = args[args.indexOf("--data-binary") + 1].slice(1);
      const responsePath = args[args.indexOf("--output") + 1];
      temporaryDirectory = dirname(headerPath);
      assert.equal(readFileSync(headerPath, "utf8"), `Authorization: Bearer ${TOKEN}\n`);
      assert.deepEqual(JSON.parse(readFileSync(requestPath, "utf8")), {
        options: { ...DEFAULT_OPTIONS },
      });
      writeFileSync(responsePath, '{"result":"ok"}\n');
      return { status: 0, stderr: "", stdout: "200" };
    };
    performFixedSupervisorRequest({
      payload: { options: { ...DEFAULT_OPTIONS } },
      requiredUid: REQUIRED_UID,
      runtimeRoot: value.runtimeRoot,
      spawnSyncImpl,
      token: TOKEN,
    });
    assert.equal(existsSync(temporaryDirectory), false);
  } finally {
    rmSync(value.root, { force: true, recursive: true });
  }
});
