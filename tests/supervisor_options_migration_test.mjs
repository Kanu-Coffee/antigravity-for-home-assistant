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
  NORMALIZED_UPDATE_MODE,
  RetryableMigrationError,
  SUPERVISOR_OPTIONS_URL,
  migrateSupervisorOptions,
  performFixedSupervisorRequest,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/supervisor-options-migrate.mjs";

const REQUIRED_UID = process.getuid();
const TOKEN = "fixture-supervisor-token-never-use";
const SECRET_OPTION = "fixture-telegram-secret-never-use";

function makeFixture(mode, { credential = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "supervisor-options-migration."));
  const runtimeRoot = join(root, "run");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  chmodSync(runtimeRoot, 0o700);
  const optionsPath = join(root, "options.json");
  const credentialPath = join(runtimeRoot, "supervisor.token");
  const options = {
    telegram_enabled: true,
    telegram_bot_token: SECRET_OPTION,
    telegram_allowed_user_ids: ["123"],
    telegram_allowed_chat_ids: ["456"],
    telegram_access_mode: "confirm_changes",
    authorized_keys: ["ssh-ed25519 fixture"],
    web_terminal_auto_start_antigravity: false,
    tmux_session_name: "antigravity-ha",
    antigravity_tool_permission: "request-review",
    antigravity_terminal_sandbox: true,
    antigravity_sensitive_data_access: false,
    antigravity_user_files_update_mode: mode,
    home_assistant_browser_auto_auth: true,
    log_level: "info",
  };
  writeFileSync(optionsPath, `${JSON.stringify(options)}\n`, { mode: 0o600 });
  chmodSync(optionsPath, 0o600);
  if (credential) {
    writeFileSync(credentialPath, TOKEN, { mode: 0o400 });
    chmodSync(credentialPath, 0o400);
  }
  return { credentialPath, options, optionsPath, root, runtimeRoot };
}

function optionValue(arguments_, name) {
  const index = arguments_.indexOf(name);
  assert.notEqual(index, -1, `${name} is missing`);
  return arguments_[index + 1];
}

for (const legacyMode of ["refresh_agents", "refresh_all"]) {
  test(`normalizes ${legacyMode} through the fixed self-options request`, () => {
    const fixture = makeFixture(legacyMode);
    let temporaryDirectory;
    try {
      const spawnSyncImpl = (command, arguments_, options) => {
        assert.equal(command, "/usr/bin/curl");
        assert.equal(arguments_[0], "--disable");
        assert.equal(arguments_.at(-1), SUPERVISOR_OPTIONS_URL);
        assert.equal(optionValue(arguments_, "--request"), "POST");
        assert.equal(optionValue(arguments_, "--connect-timeout"), "5");
        assert.equal(optionValue(arguments_, "--max-time"), "15");
        assert.equal(options.timeout, 20_000);
        assert.deepEqual(Object.keys(options.env).sort(), [
          "HOME",
          "LANG",
          "LC_ALL",
          "PATH",
        ]);
        assert.equal(options.env.HOME, "/nonexistent");
        assert.equal(options.env.HTTP_PROXY, undefined);
        assert.equal(options.env.HTTPS_PROXY, undefined);
        assert.equal(options.env.ALL_PROXY, undefined);
        assert.equal(options.env.CURL_HOME, undefined);

        const serializedArguments = JSON.stringify(arguments_);
        assert.equal(serializedArguments.includes(TOKEN), false);
        assert.equal(serializedArguments.includes(SECRET_OPTION), false);
        const headerPath = optionValue(arguments_, "--header").slice(1);
        const requestPath = optionValue(arguments_, "--data-binary").slice(1);
        const responsePath = optionValue(arguments_, "--output");
        temporaryDirectory = dirname(headerPath);
        assert.equal(statSync(headerPath).mode & 0o777, 0o600);
        assert.equal(statSync(requestPath).mode & 0o777, 0o600);
        assert.equal(statSync(responsePath).mode & 0o777, 0o600);
        assert.equal(
          readFileSync(headerPath, "utf8"),
          `Authorization: Bearer ${TOKEN}\n`,
        );

        const body = JSON.parse(readFileSync(requestPath, "utf8"));
        assert.deepEqual(body, {
          options: {
            ...fixture.options,
            antigravity_user_files_update_mode: NORMALIZED_UPDATE_MODE,
          },
        });
        assert.deepEqual(
          {
            ...body.options,
            antigravity_user_files_update_mode: legacyMode,
          },
          fixture.options,
        );
        writeFileSync(responsePath, '{"result":"ok","data":{}}\n');
        return { status: 0, stderr: "", stdout: "200" };
      };

      const result = migrateSupervisorOptions({
        credentialPath: fixture.credentialPath,
        optionsPath: fixture.optionsPath,
        requestImpl: (request) =>
          performFixedSupervisorRequest({ ...request, spawnSyncImpl }),
        requiredUid: REQUIRED_UID,
        runtimeRoot: fixture.runtimeRoot,
      });
      assert.deepEqual(result, { status: "migrated" });
      assert.equal(existsSync(temporaryDirectory), false);
      assert.equal(
        JSON.parse(readFileSync(fixture.optionsPath, "utf8"))
          .antigravity_user_files_update_mode,
        legacyMode,
      );
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
}

test("returns not_required without reading a credential for a current mode", () => {
  const fixture = makeFixture("preserve", { credential: false });
  try {
    const result = migrateSupervisorOptions({
      credentialPath: fixture.credentialPath,
      optionsPath: fixture.optionsPath,
      requestImpl: () => assert.fail("request must not run"),
      requiredUid: REQUIRED_UID,
      runtimeRoot: fixture.runtimeRoot,
    });
    assert.deepEqual(result, { status: "not_required" });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("missing Supervisor credential fails safely and leaves options untouched", () => {
  const fixture = makeFixture("refresh_all", { credential: false });
  try {
    assert.throws(
      () =>
        migrateSupervisorOptions({
          credentialPath: fixture.credentialPath,
          optionsPath: fixture.optionsPath,
          requestImpl: () => assert.fail("request must not run"),
          requiredUid: REQUIRED_UID,
          runtimeRoot: fixture.runtimeRoot,
        }),
      RetryableMigrationError,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(fixture.optionsPath, "utf8")),
      fixture.options,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("Supervisor rejection is retryable and private request files are removed", () => {
  const fixture = makeFixture("refresh_agents");
  let temporaryDirectory;
  try {
    const spawnSyncImpl = (_command, arguments_) => {
      const responsePath = optionValue(arguments_, "--output");
      temporaryDirectory = dirname(responsePath);
      writeFileSync(responsePath, '{"result":"error"}\n');
      return { status: 0, stderr: "", stdout: "503" };
    };
    assert.throws(
      () =>
        migrateSupervisorOptions({
          credentialPath: fixture.credentialPath,
          optionsPath: fixture.optionsPath,
          requestImpl: (request) =>
            performFixedSupervisorRequest({ ...request, spawnSyncImpl }),
          requiredUid: REQUIRED_UID,
          runtimeRoot: fixture.runtimeRoot,
        }),
      RetryableMigrationError,
    );
    assert.equal(existsSync(temporaryDirectory), false);
    assert.deepEqual(
      JSON.parse(readFileSync(fixture.optionsPath, "utf8")),
      fixture.options,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});
