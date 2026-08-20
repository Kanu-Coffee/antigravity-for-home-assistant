import assert from "node:assert/strict";
import {
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import {
  loadTelegramPermissionBoundary,
} from "/usr/local/share/antigravity-ha/telegram-bridge.mjs";

const [settingsPath, expectedToolPermission] = process.argv.slice(2);
if (typeof settingsPath !== "string" ||
    !new Set(["request-review", "always-proceed"])
      .has(expectedToolPermission)) {
  throw new Error("usage: telegram-settings-boundary-canary.mjs PATH MODE");
}

const boundary = loadTelegramPermissionBoundary(
  expectedToolPermission,
  settingsPath,
);
assert.equal(boundary.toolPermission, expectedToolPermission);

const value = JSON.parse(readFileSync(settingsPath, "utf8"));
const noncanonicalPath =
  `/tmp/telegram-settings-noncanonical-${process.pid}.json`;
writeFileSync(
  noncanonicalPath,
  `${JSON.stringify(value)}\n`,
  { encoding: "utf8", flag: "wx", mode: 0o600 },
);
try {
  assert.throws(
    () => loadTelegramPermissionBoundary(
      expectedToolPermission,
      noncanonicalPath,
    ),
    /not in native canonical form/u,
  );
} finally {
  unlinkSync(noncanonicalPath);
}

process.stdout.write("TELEGRAM_SETTINGS_BOUNDARY_CANARY_PASS\n");
