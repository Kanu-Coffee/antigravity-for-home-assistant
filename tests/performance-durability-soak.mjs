import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  TelegramPollBackoff,
  cancelRequesterWork,
  dispatchNormalizedUpdate,
  enqueueRequester,
  loadRuntimeConfig,
  metricsSnapshot,
  resetMetricsForTest,
  runAntigravityPrompt,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs";
import {
  HA_READ_MAX_MEMORY_RESPONSE_BYTES,
  HA_READ_MAX_RESPONSE_BYTES,
  HaReadError,
  sendHaReadRequest,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-read-client.mjs";
import {
  HaReadBroker,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-read-broker.mjs";
import {
  HomeAssistantUnavailableError,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-memory-ha-client.mjs";
import {
  closeMemoryDatabase,
  memoryStatus,
  openMemoryDatabase,
  refreshMemory,
} from "../antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/ha-memory-core.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_SCHEMA_VERSION = 1;
const ENTITY_FIXTURE_COUNT = 1_000;
const TELEGRAM_GLOBAL_WORKERS = 2;
const TELEGRAM_QUEUED_PER_CHAT = 4;
const PROJECTED_LOG_LINE_LIMIT = 4_096 + Buffer.byteLength("…[truncated]");
const FORBIDDEN_OVERRIDE = /^GAP007_(?:DURATION|OUTAGE|RESTART|SOAK|THRESHOLD)/u;

const MODE_CONFIG = Object.freeze({
  contract: Object.freeze({
    soakDurationMs: 2_000,
    outageDurationMs: 1_000,
    brokerRestartCount: 3,
    sampleIntervalMs: 25,
  }),
  release: Object.freeze({
    soakDurationMs: 30 * 60 * 1_000,
    outageDurationMs: 15 * 60 * 1_000,
    brokerRestartCount: 20,
    sampleIntervalMs: 1_000,
  }),
});

function parseArguments(argv) {
  const result = {
    mode: "contract",
    evidencePath: null,
    candidateImageId: null,
    candidateLeafDigest: null,
    candidateStageDigest: null,
    sourceRevision: null,
    sourceRootfsSha256: null,
    executionScope: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (![
      "--mode",
      "--evidence",
      "--candidate-image-id",
      "--candidate-leaf-digest",
      "--candidate-stage-digest",
      "--source-revision",
      "--source-rootfs-sha256",
      "--execution-scope",
    ].includes(argument)) {
      throw new Error(`unsupported argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === "--mode") result.mode = value;
    if (argument === "--evidence") result.evidencePath = resolve(value);
    if (argument === "--candidate-image-id") result.candidateImageId = value;
    if (argument === "--candidate-leaf-digest") result.candidateLeafDigest = value;
    if (argument === "--candidate-stage-digest") result.candidateStageDigest = value;
    if (argument === "--source-revision") result.sourceRevision = value;
    if (argument === "--source-rootfs-sha256") result.sourceRootfsSha256 = value;
    if (argument === "--execution-scope") result.executionScope = value;
  }
  if (!Object.hasOwn(MODE_CONFIG, result.mode)) throw new Error("mode must be contract or release");
  if (result.candidateImageId !== null && !/^sha256:[a-f0-9]{64}$/u.test(result.candidateImageId)) {
    throw new Error("candidate image ID must be an immutable sha256 identifier");
  }
  if (result.mode === "release" && result.candidateImageId === null) {
    throw new Error("release mode requires --candidate-image-id");
  }
  if (result.mode === "release") {
    if (!/^sha256:[a-f0-9]{64}$/u.test(result.candidateLeafDigest ?? "")) {
      throw new Error("release mode requires an exact candidate leaf digest");
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(result.candidateStageDigest ?? "")) {
      throw new Error("release mode requires an exact candidate staging digest");
    }
    if (!/^[a-f0-9]{40}$/u.test(result.sourceRevision ?? "")) {
      throw new Error("release mode requires an exact source revision");
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(result.sourceRootfsSha256 ?? "")) {
      throw new Error("release mode requires an exact source-rootfs digest");
    }
    if (result.executionScope !== "packaged_image") {
      throw new Error("release mode must execute packaged image modules");
    }
  } else if (
    result.sourceRevision !== null ||
    result.sourceRootfsSha256 !== null ||
    result.candidateLeafDigest !== null ||
    result.candidateStageDigest !== null ||
    result.executionScope !== null
  ) {
    throw new Error("source binding arguments are accepted only in release mode");
  }
  return result;
}

function assertNoThresholdOverrides() {
  const overrides = Object.keys(process.env).filter((key) => FORBIDDEN_OVERRIDE.test(key));
  if (overrides.length > 0) {
    throw new Error("GAP-007 duration and threshold environment overrides are forbidden");
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function elapsedSeconds(startedAt) {
  return Number(((performance.now() - startedAt) / 1_000).toFixed(3));
}

function resourceSnapshot() {
  const memory = process.memoryUsage();
  const resourceTypes = Object.create(null);
  for (const resource of process.getActiveResourcesInfo()) {
    resourceTypes[resource] = (resourceTypes[resource] ?? 0) + 1;
  }
  return {
    rss_bytes: memory.rss,
    heap_total_bytes: memory.heapTotal,
    heap_used_bytes: memory.heapUsed,
    external_bytes: memory.external,
    active_resource_types: Object.fromEntries(Object.entries(resourceTypes).sort()),
  };
}

function gitOutput(args, options = {}) {
  return execFileSync("git", args, {
    cwd: REPOSITORY_ROOT,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

async function sourceProvenance() {
  const listed = gitOutput(
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "buffer" },
  );
  const paths = listed.toString("utf8").split("\0").filter(Boolean).sort();
  const digest = createHash("sha256");
  for (const relativePath of paths) {
    const absolutePath = join(REPOSITORY_ROOT, relativePath);
    digest.update(relativePath);
    digest.update("\0");
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      digest.update("deleted\0");
      continue;
    }
    digest.update(String(metadata.mode & 0o7777));
    digest.update("\0");
    if (metadata.isSymbolicLink()) digest.update(await readlink(absolutePath));
    else if (metadata.isFile()) digest.update(await readFile(absolutePath));
    digest.update("\0");
  }
  return {
    git_commit: gitOutput(["rev-parse", "HEAD"]).trim(),
    source_tree_sha256: `sha256:${digest.digest("hex")}`,
    worktree_dirty: gitOutput(["status", "--porcelain", "--untracked-files=normal"]).length > 0,
    source_file_count: paths.length,
  };
}

async function telegramModuleProvenance(mode) {
  const modulePath = join(
    REPOSITORY_ROOT,
    "antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs",
  );
  const resolvedPath = await realpath(modulePath);
  if (mode === "release") {
    assert.equal(
      resolvedPath,
      "/usr/local/share/antigravity-ha/telegram-bridge.mjs",
      "release workload did not import the Telegram state machine from the packaged image",
    );
    return {
      module_origin: "packaged_image",
      telegram_bridge_module_path: resolvedPath,
    };
  }
  assert.ok(
    resolvedPath.startsWith(`${REPOSITORY_ROOT}/`),
    "contract workload resolved outside the repository worktree",
  );
  return {
    module_origin: "host_source_contract",
    telegram_bridge_module_path:
      "repository_worktree/antigravity_home_assistant/rootfs/usr/local/share/antigravity-ha/telegram-bridge.mjs",
  };
}

async function writeEvidence(path, evidence) {
  if (path === null) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function readableResponse(status, value, { raw = false } = {}) {
  const body = raw ? String(value) : JSON.stringify(value);
  return { status, body: Readable.from([Buffer.from(body)]) };
}

function minimalSnapshot(entityCount = 1) {
  const entities = Array.from({ length: entityCount }, (_, index) => ({
    entity_id: `sensor.fixture_${String(index).padStart(4, "0")}`,
    name: `Fixture ${index}`,
    platform: "fixture",
    aliases: [],
    labels: [],
  }));
  const states = entities.map((entity, index) => ({
    entity_id: entity.entity_id,
    state: String(index),
    attributes: {
      friendly_name: entity.name,
      unit_of_measurement: "unit",
    },
    last_changed: "2026-08-12T00:00:00Z",
    last_updated: "2026-08-12T00:00:00Z",
  }));
  return {
    haVersion: "fixture",
    areas: [],
    devices: [],
    entities,
    states,
    automations: {},
    warnings: [],
  };
}

async function waitForTelegramSaturation(config) {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const snapshot = metricsSnapshot();
    if (
      snapshot.jobs_active === TELEGRAM_GLOBAL_WORKERS &&
      snapshot.jobs_queued === TELEGRAM_QUEUED_PER_CHAT * 2
    ) {
      return snapshot;
    }
    await sleep(10);
  }
  throw new Error("Telegram fixture did not reach the required worker/queue saturation");
}

async function runTelegramSoak(config, fixtureDirectory) {
  resetMetricsForTest();
  const workerPath = join(fixtureDirectory, "soak-worker.mjs");
  const workerHoldMs = config.soakDurationMs + 120_000;
  await writeFile(workerPath, `
const holdMs = Number.parseInt(process.argv[2], 10);
for await (const _chunk of process.stdin) { /* drain stdin */ }
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    event: "init",
    conversation_id: "conversation.gap007-fixture",
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conversation.gap007-fixture",
      status: "SUCCESS",
      response: "fixture complete",
    },
  }) + "\\n");
}, holdMs);
`, { encoding: "utf8", mode: 0o600 });

  const requesters = ["81001", "82001"];
  const tasks = [];
  let queueCapacityRejections = 0;
  for (const requester of requesters) {
    for (let index = 0; index < TELEGRAM_QUEUED_PER_CHAT + 1; index += 1) {
      tasks.push(enqueueRequester(requester, requester, async (ticket) =>
        runAntigravityPrompt("GAP-007 bounded soak fixture", {
          binary: process.execPath,
          prefixArgs: [workerPath, String(workerHoldMs)],
          cwd: fixtureDirectory,
          timeoutMs: workerHoldMs + 60_000,
          hardKillGraceMs: 250,
          requester: { user_id: requester, chat_id: requester },
          runId: `${requester}:${requester}:gap007-${index}`,
          signal: ticket.cancellationController.signal,
        })));
    }
    try {
      enqueueRequester(requester, requester, async () => undefined);
    } catch (error) {
      assert.match(error.message, /대기열/u);
      queueCapacityRejections += 1;
    }
  }
  assert.equal(queueCapacityRejections, requesters.length);
  await waitForTelegramSaturation(config);

  const startedAt = performance.now();
  let samples = 0;
  let minimumActive = Number.POSITIVE_INFINITY;
  let maximumActive = 0;
  let minimumQueued = Number.POSITIVE_INFINITY;
  let maximumQueued = 0;
  while (performance.now() - startedAt < config.soakDurationMs) {
    const snapshot = metricsSnapshot();
    samples += 1;
    minimumActive = Math.min(minimumActive, snapshot.jobs_active);
    maximumActive = Math.max(maximumActive, snapshot.jobs_active);
    minimumQueued = Math.min(minimumQueued, snapshot.jobs_queued);
    maximumQueued = Math.max(maximumQueued, snapshot.jobs_queued);
    assert.equal(snapshot.jobs_active, TELEGRAM_GLOBAL_WORKERS);
    assert.equal(snapshot.jobs_queued, TELEGRAM_QUEUED_PER_CHAT * requesters.length);
    await sleep(Math.min(
      config.sampleIntervalMs,
      Math.max(1, config.soakDurationMs - (performance.now() - startedAt)),
    ));
  }
  const actualElapsedSeconds = elapsedSeconds(startedAt);
  assert.ok(actualElapsedSeconds * 1_000 >= config.soakDurationMs);

  const cancellations = requesters.map((requester) =>
    cancelRequesterWork(requester, requester, { hardKillGraceMs: 250 }));
  for (const cancellation of cancellations) {
    assert.deepEqual(cancellation, {
      queued_cancelled: TELEGRAM_QUEUED_PER_CHAT,
      running_cancel_requested: 1,
      approvals_cancelled: 0,
      durable_in_progress: 0,
      workers_terminated: 1,
    });
  }
  const settled = await Promise.allSettled(tasks);
  assert.equal(settled.filter((item) => item.status === "rejected").length, tasks.length);
  assert.equal(metricsSnapshot().jobs_active, 0);
  assert.equal(metricsSnapshot().jobs_queued, 0);

  return {
    required_elapsed_seconds: config.soakDurationMs / 1_000,
    actual_elapsed_seconds: actualElapsedSeconds,
    configured_global_workers: TELEGRAM_GLOBAL_WORKERS,
    observed_active_minimum: minimumActive,
    observed_active_maximum: maximumActive,
    configured_queue_per_chat: TELEGRAM_QUEUED_PER_CHAT,
    observed_queued_minimum: minimumQueued,
    observed_queued_maximum: maximumQueued,
    chat_count: requesters.length,
    task_count: tasks.length,
    queue_capacity_rejections: queueCapacityRejections,
    samples,
    cleanup: "all_workers_and_queues_closed",
    result: "PASS",
  };
}

async function startLoopbackBrowserFixture(state) {
  const server = createServer((_request, response) => {
    if (state.outage) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end('{"status":"unavailable"}\n');
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"status":"ready"}\n');
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/fixture`,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

async function runFailureInjection(config, fixtureDirectory, moduleOrigin) {
  const state = { outage: true };
  const browserFixture = await startLoopbackBrowserFixture(state);
  const memoryPath = join(fixtureDirectory, "outage-memory.sqlite3");
  const memoryDb = openMemoryDatabase(memoryPath);
  const coreBroker = new HaReadBroker({
    supervisorToken: "GAP007_LOCAL_FIXTURE_TOKEN",
    fetchImpl: async () => state.outage
      ? readableResponse(503, { status: "unavailable" })
      : readableResponse(200, { version: "fixture", state: "running" }),
  });
  const telegramConfig = loadRuntimeConfig({
    telegram_enabled: true,
    telegram_bot_token: `123456:${"A".repeat(35)}`,
    telegram_allowed_user_ids: ["83001"],
    telegram_allowed_chat_ids: ["83001"],
    antigravity_tool_permission: "request-review",
  });
  const normalizedCallback = {
    kind: "callback_query",
    value: {
      id: "gap007-callback",
      from: { id: "83001" },
      message: { chat: { id: "83001", type: "private" } },
      data: "v2d:fixture-not-present",
    },
  };

  const attempts = { core: 0, bot_api: 0, browser: 0, memory: 0 };
  const failures = { core: 0, bot_api: 0, browser: 0, memory: 0 };
  const telegramBackoff = new TelegramPollBackoff({ jitter: () => 0 });
  const operations = {
    async core() {
      attempts.core += 1;
      await coreBroker.dispatch("config", {});
    },
    async bot_api() {
      attempts.bot_api += 1;
      await dispatchNormalizedUpdate(telegramConfig, normalizedCallback, {
        authorization: () => false,
        api: async () => {
          if (state.outage) throw new Error("injected Bot API outage");
          return {};
        },
      });
    },
    async browser() {
      attempts.browser += 1;
      const response = await fetch(browserFixture.url, { redirect: "error" });
      if (!response.ok) throw new Error("injected browser gateway outage");
      await response.arrayBuffer();
    },
    async memory() {
      attempts.memory += 1;
      if (state.outage) {
        await refreshMemory(memoryDb, {
          rawSnapshot: Promise.reject(new HomeAssistantUnavailableError(
            "ha_transport_failed",
            "injected memory transport outage",
          )),
        });
        return;
      }
      await refreshMemory(memoryDb, { rawSnapshot: minimalSnapshot(1), force: true });
    },
  };

  const runAttempt = async (expectFailure) => {
    const entries = Object.entries(operations);
    const results = await Promise.allSettled(entries.map(([, operation]) => operation()));
    results.forEach((result, index) => {
      const name = entries[index][0];
      if (expectFailure) {
        assert.equal(result.status, "rejected", `${name} unexpectedly succeeded during outage`);
        failures[name] += 1;
      } else if (result.status === "rejected") {
        throw result.reason;
      }
    });
    return Object.fromEntries(
      entries.map(([name], index) => [name, results[index]]),
    );
  };

  try {
    const startedAt = performance.now();
    let maximumBackoffMs = 0;
    while (performance.now() - startedAt < config.outageDurationMs) {
      const results = await runAttempt(true);
      const botApiFailure = results.bot_api;
      assert.equal(botApiFailure?.status, "rejected");
      assert.match(botApiFailure.reason?.message ?? "", /Bot API outage/u);
      const backoff = telegramBackoff.nextDelay(botApiFailure.reason);
      maximumBackoffMs = Math.max(maximumBackoffMs, backoff);
      await sleep(Math.min(
        backoff,
        Math.max(1, config.outageDurationMs - (performance.now() - startedAt)),
      ));
    }
    const actualElapsedSeconds = elapsedSeconds(startedAt);
    assert.ok(actualElapsedSeconds * 1_000 >= config.outageDurationMs);
    state.outage = false;
    const recoveryStartedAt = performance.now();
    await runAttempt(false);
    assert.ok(telegramBackoff.consecutiveFailures > 0);
    telegramBackoff.reset();
    assert.equal(telegramBackoff.consecutiveFailures, 0);
    const recoverySeconds = elapsedSeconds(recoveryStartedAt);
    assert.equal(memoryStatus(memoryDb, memoryPath).catalog_status, "ready");
    for (const name of Object.keys(operations)) {
      assert.ok(failures[name] > 0);
      assert.equal(attempts[name], failures[name] + 1);
    }
    return {
      required_elapsed_seconds: config.outageDurationMs / 1_000,
      actual_elapsed_seconds: actualElapsedSeconds,
      simultaneous_surfaces: ["core", "bot_api", "browser", "memory"],
      attempts,
      injected_failures: failures,
      maximum_backoff_milliseconds: maximumBackoffMs,
      backoff_implementation: moduleOrigin === "packaged_image"
        ? "packaged_telegram_bridge"
        : "host_source_telegram_bridge_contract",
      backoff_reset_after_recovery: telegramBackoff.consecutiveFailures === 0,
      recovery_seconds: recoverySeconds,
      loopback_only: true,
      external_calls: 0,
      result: "PASS",
    };
  } finally {
    closeMemoryDatabase(memoryDb, memoryPath);
    await browserFixture.close();
  }
}

async function runBoundedCatalogAndLogs(fixtureDirectory) {
  const snapshot = minimalSnapshot(ENTITY_FIXTURE_COUNT);
  const memoryPath = join(fixtureDirectory, "catalog-memory.sqlite3");
  const memoryDb = openMemoryDatabase(memoryPath);
  const longLine = "L".repeat(5_000);
  const longLogs = Array.from({ length: 150 }, (_, index) =>
    `${String(index).padStart(3, "0")}:${longLine}`).join("\n");
  let oversizedRejected = false;
  const broker = new HaReadBroker({
    supervisorToken: "GAP007_LOCAL_FIXTURE_TOKEN",
    fetchImpl: async (url) => {
      if (url.endsWith("/states")) return readableResponse(200, snapshot.states);
      if (url.endsWith("/core/logs")) return readableResponse(200, longLogs, { raw: true });
      if (url.endsWith("/addons/self/logs")) {
        return readableResponse(200, "X".repeat(HA_READ_MAX_RESPONSE_BYTES + 1), { raw: true });
      }
      return readableResponse(404, { status: "missing" });
    },
  });

  try {
    const refreshStartedAt = performance.now();
    const refreshed = await refreshMemory(memoryDb, { rawSnapshot: snapshot, force: true });
    const refreshSeconds = elapsedSeconds(refreshStartedAt);
    const status = memoryStatus(memoryDb, memoryPath);
    assert.equal(refreshed.status, "success");
    assert.equal(status.catalog_counts.entity, ENTITY_FIXTURE_COUNT);

    const projectedStates = await broker.dispatch("states", { limit: 100 });
    const projectedLogs = await broker.dispatch("core_logs", { lines: 100 });
    await assert.rejects(
      broker.dispatch("app_logs", { lines: 100 }),
      (error) => {
        oversizedRejected = error instanceof HaReadError && error.code === "upstream_too_large";
        return oversizedRejected;
      },
    );
    const stateOutputBytes = Buffer.byteLength(JSON.stringify(projectedStates));
    const logOutputBytes = Buffer.byteLength(JSON.stringify(projectedLogs));
    const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
    assert.equal(projectedStates.length, 100);
    assert.equal(projectedLogs.lines.length, 100);
    assert.equal(projectedLogs.truncated, true);
    assert.ok(projectedLogs.lines.every(
      (line) => Buffer.byteLength(line) <= PROJECTED_LOG_LINE_LIMIT,
    ));
    assert.ok(stateOutputBytes <= HA_READ_MAX_RESPONSE_BYTES);
    assert.ok(logOutputBytes <= HA_READ_MAX_RESPONSE_BYTES);
    assert.ok(snapshotBytes <= HA_READ_MAX_MEMORY_RESPONSE_BYTES);
    const database = await stat(memoryPath);
    return {
      input_entities: ENTITY_FIXTURE_COUNT,
      indexed_entities: status.catalog_counts.entity,
      projected_entities: projectedStates.length,
      state_output_bytes: stateOutputBytes,
      input_log_lines: 150,
      projected_log_lines: projectedLogs.lines.length,
      log_output_bytes: logOutputBytes,
      per_line_bytes_maximum: Math.max(...projectedLogs.lines.map((line) => Buffer.byteLength(line))),
      general_output_limit_bytes: HA_READ_MAX_RESPONSE_BYTES,
      memory_output_limit_bytes: HA_READ_MAX_MEMORY_RESPONSE_BYTES,
      oversized_upstream_rejected: oversizedRejected,
      memory_database_bytes: database.size,
      memory_refresh_seconds: refreshSeconds,
      result: "PASS",
    };
  } finally {
    closeMemoryDatabase(memoryDb, memoryPath);
  }
}

async function runBrokerRestartFixture(config, fixtureDirectory) {
  const socketPath = join(fixtureDirectory, "restart", "ha-read.sock");
  const durations = [];
  for (let index = 0; index < config.brokerRestartCount; index += 1) {
    const startedAt = performance.now();
    const broker = new HaReadBroker({
      socketPath,
      supervisorToken: "GAP007_LOCAL_FIXTURE_TOKEN",
      fetchImpl: async () => readableResponse(200, { version: "fixture", state: "running" }),
    });
    await broker.start();
    const socket = await lstat(socketPath);
    assert.equal(socket.isSocket(), true);
    const response = await sendHaReadRequest("config", {}, { socketPath, timeoutMs: 1_000 });
    assert.equal(response.version, "fixture");
    await broker.close();
    await assert.rejects(lstat(socketPath), (error) => error?.code === "ENOENT");
    durations.push(elapsedSeconds(startedAt));
  }
  return {
    scope: "local_ha_read_broker_fixture",
    required_count: config.brokerRestartCount,
    completed_count: durations.length,
    elapsed_seconds: Number(durations.reduce((sum, item) => sum + item, 0).toFixed(3)),
    maximum_restart_seconds: Math.max(...durations),
    stale_socket_count: 0,
    result: "PASS",
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  assertNoThresholdOverrides();
  const previousMemoryTestMode = process.env.HA_MEMORY_TEST_MODE;
  process.env.HA_MEMORY_TEST_MODE = "1";
  const config = MODE_CONFIG[args.mode];
  const overallStartedAt = performance.now();
  const startedAtUtc = new Date().toISOString();
  const moduleProvenance = await telegramModuleProvenance(args.mode);
  const provenance = args.mode === "release"
    ? {
        git_commit: args.sourceRevision,
        source_tree_sha256: args.sourceRootfsSha256,
        source_rootfs_sha256: args.sourceRootfsSha256,
        source_scope: "antigravity_home_assistant/rootfs",
        worktree_dirty: null,
        source_file_count: null,
        candidate_leaf_digest: args.candidateLeafDigest,
        candidate_stage_digest: args.candidateStageDigest,
        ...moduleProvenance,
      }
    : {
        ...await sourceProvenance(),
        source_rootfs_sha256: null,
        source_scope: "repository_worktree",
        ...moduleProvenance,
      };
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "antigravity-gap007-"));
  const cpuBefore = process.cpuUsage();
  const resourcesBefore = resourceSnapshot();
  let peakRssBytes = resourcesBefore.rss_bytes;
  const resourceTimer = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, args.mode === "release" ? 5_000 : 25);
  resourceTimer.unref();

  try {
    const [telegram, failureInjection] = await Promise.all([
      runTelegramSoak(config, fixtureDirectory),
      runFailureInjection(
        config,
        fixtureDirectory,
        moduleProvenance.module_origin,
      ),
    ]);
    const boundedIo = await runBoundedCatalogAndLogs(fixtureDirectory);
    const rapidRestart = await runBrokerRestartFixture(config, fixtureDirectory);
    clearInterval(resourceTimer);
    if (args.mode === "contract") {
      const finishedProvenance = await sourceProvenance();
      assert.equal(
        finishedProvenance.git_commit,
        provenance.git_commit,
        "Git commit changed while GAP-007 evidence was being collected",
      );
      assert.equal(
        finishedProvenance.source_tree_sha256,
        provenance.source_tree_sha256,
        "source tree changed while GAP-007 evidence was being collected",
      );
    }
    const resourcesAfter = resourceSnapshot();
    peakRssBytes = Math.max(peakRssBytes, resourcesAfter.rss_bytes);
    const cpu = process.cpuUsage(cpuBefore);
    const finishedAtUtc = new Date().toISOString();
    const evidence = {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      requirement_id: "GAP-007",
      mode: args.mode,
      scope: args.mode === "release"
        ? "local_release_component_fixture"
        : "local_contract_fixture",
      closure_eligible: false,
      result: "PASS",
      started_at_utc: startedAtUtc,
      finished_at_utc: finishedAtUtc,
      actual_elapsed_seconds: elapsedSeconds(overallStartedAt),
      threshold_policy: {
        duration_override_supported: false,
        override_detected: false,
        release_soak_seconds: MODE_CONFIG.release.soakDurationMs / 1_000,
        release_outage_seconds: MODE_CONFIG.release.outageDurationMs / 1_000,
        release_restart_count: MODE_CONFIG.release.brokerRestartCount,
      },
      provenance: {
        ...provenance,
        source_tree_stable: args.mode === "contract" ? true : null,
        candidate_image_id: args.candidateImageId,
      },
      telegram,
      failure_injection: failureInjection,
      bounded_io: boundedIo,
      rapid_restart: rapidRestart,
      resources: {
        before: resourcesBefore,
        after: resourcesAfter,
        peak_rss_bytes: peakRssBytes,
        cpu_user_microseconds: cpu.user,
        cpu_system_microseconds: cpu.system,
        budget_status: args.mode === "release"
          ? "candidate_wrapper_budget_pending"
          : "contract_mode_not_closure_eligible",
      },
      sanitization: {
        external_calls: 0,
        contains_credentials: false,
        contains_entity_or_chat_identifiers: false,
        contains_raw_logs_or_prompts: false,
      },
      remaining_gap: args.mode === "release"
        ? "candidate container restart evidence must be merged by the opt-in wrapper"
        : "contract mode is shortened and cannot close GAP-007",
    };
    await writeEvidence(args.evidencePath, evidence);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    clearInterval(resourceTimer);
    await rm(fixtureDirectory, { recursive: true, force: true });
    if (previousMemoryTestMode === undefined) delete process.env.HA_MEMORY_TEST_MODE;
    else process.env.HA_MEMORY_TEST_MODE = previousMemoryTestMode;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`GAP-007 performance/durability harness failed: ${message}\n`);
  process.exitCode = 1;
});
