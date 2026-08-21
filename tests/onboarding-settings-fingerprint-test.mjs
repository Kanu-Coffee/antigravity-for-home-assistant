import assert from "node:assert/strict";

import {
  settingsInvariantFingerprint,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/onboarding-settings-fingerprint.mjs";
import {
  nativeParseJsonContent,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-permission-policy.mjs";

function fingerprint(source) {
  return settingsInvariantFingerprint(nativeParseJsonContent(source));
}

const baseline = '{"futureCounter":9007199254740992,"nested":{"value":1.0}}';
assert.notEqual(
  fingerprint(baseline),
  fingerprint('{"futureCounter":9007199254740993,"nested":{"value":1.0}}'),
);
assert.notEqual(
  fingerprint(baseline),
  fingerprint('{"nested":{"value":10e-1},"futureCounter":9007199254740992}'),
);
assert.notEqual(fingerprint('{"value":-0}'), fingerprint('{"value":0}'));
assert.equal(
  fingerprint(`${baseline.slice(0, -1)},"enableTelemetry":false}`),
  fingerprint(`${baseline.slice(0, -1)},"enableTelemetry":true}`),
);
assert.notEqual(
  fingerprint(baseline),
  fingerprint(`${baseline.slice(0, -1)},"futureSecurityPolicy":null}`),
);
assert.notEqual(fingerprint('{"value":null}'), fingerprint("{}"));
assert.throws(() => fingerprint('{"enableTelemetry":"false"}'));

process.stdout.write("onboarding settings fingerprint: PASS\n");
