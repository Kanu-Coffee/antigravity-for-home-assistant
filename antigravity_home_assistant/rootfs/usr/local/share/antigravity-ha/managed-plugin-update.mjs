import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const DATA_HOME = "/data/home";
const APP_DATA_ROOT = "/data/antigravity-ha";
const MIGRATION_ROOT = join(APP_DATA_ROOT, "migration");
const BACKUP_ROOT = join(APP_DATA_ROOT, "backups");
const JOURNAL_PATH = join(MIGRATION_ROOT, "managed-plugin.json");
const SOURCE = "/usr/local/share/antigravity-ha/plugins/home-assistant";
const PLUGINS_ROOT = join(DATA_HOME, ".gemini", "config", "plugins");
const TARGET = join(PLUGINS_ROOT, "home-assistant");
const MARKER_NAME = ".antigravity-ha-managed.json";
const MARKER_PATH = join(TARGET, MARKER_NAME);
const APP_VERSION_PATH = "/usr/local/share/antigravity-ha/app-version";
const NATIVE = "/usr/local/libexec/antigravity-real";
const MAX_CONTROL_FILE_BYTES = 1024 * 1024;
const MAX_PLUGIN_FILE_BYTES = 16 * 1024 * 1024;
const MAX_NATIVE_OUTPUT_BYTES = 1024 * 1024;
const JOURNAL_SCHEMA = 1;
const OWNER = "antigravity-for-home-assistant";
const BACKUP_RETENTION = 2;
const PLUGIN_TRANSACTION_PATTERN =
  /^plugin-[0-9A-Za-z._+-]+-to-[0-9A-Za-z._+-]+-[0-9a-f]{12}$/u;
const PRUNE_QUARANTINE_PATTERN =
  /^\.(plugin-[0-9A-Za-z._+-]+-to-[0-9A-Za-z._+-]+-[0-9a-f]{12})\.prune-[0-9a-f]{12}$/u;
const BACKUP_CHILDREN = new Set([
  "manifest.json",
  "plugin.before",
  "plugin.displaced",
  "plugin.failed",
  "plugin.uncommitted",
]);
const VALID_PHASES = new Set([
  "preflighted",
  "backed_up",
  "staged",
  "validated",
  "activating",
  "activated",
  "postcondition_verified",
  "committed",
]);
const DUPLICATE_PLUGIN_PATHS = [
  join(DATA_HOME, ".gemini", "antigravity-cli", "plugins", "home-assistant"),
  "/config/.agents/plugins/home-assistant",
  "/config/_agents/plugins/home-assistant",
];

class FatalPluginUpdateError extends Error {}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateVersion(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u.test(
      value,
    )
  ) {
    throw new Error("The image App version is invalid");
  }
  return value;
}

async function inspectPath(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    await handle.sync();
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function secureDirectory(path, mode = 0o700) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isDirectory() || before.uid !== 0) {
    throw new Error(`${path} must be a root-owned directory and not a symbolic link`);
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY |
      fsConstants.O_DIRECTORY |
      fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory() ||
      opened.uid !== 0 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error(`${path} changed during directory validation`);
    }
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

async function ensureDirectory(path, mode = 0o700) {
  try {
    await mkdir(path, { mode });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await secureDirectory(path, mode);
}

function assertRootOwnedRegular(path, stats) {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${path} must be a regular file and not a symbolic link`);
  }
  if (stats.uid !== 0 || stats.nlink !== 1) {
    throw new Error(`${path} must be root-owned with exactly one hard link`);
  }
}

async function readBoundedFile(path, maximum = MAX_CONTROL_FILE_BYTES) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const before = await handle.stat();
    assertRootOwnedRegular(path, before);
    if (before.size > maximum) {
      throw new Error(`${path} is larger than the supported size limit`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    assertRootOwnedRegular(path, after);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`${path} changed while it was read`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function readJson(path, optional = false) {
  const content = await readBoundedFile(path);
  if (content === undefined && optional) return undefined;
  if (content === undefined) throw new Error(`${path} is missing`);
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

async function writeAtomicJson(path, value) {
  const parent = dirname(path);
  const current = await inspectPath(path);
  if (current) assertRootOwnedRegular(path, current);
  const temporary = join(
    parent,
    `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function removeJournal() {
  const current = await inspectPath(JOURNAL_PATH);
  if (!current) return;
  assertRootOwnedRegular(JOURNAL_PATH, current);
  await unlink(JOURNAL_PATH);
  await syncDirectory(MIGRATION_ROOT);
}

async function snapshotTree(root) {
  const entries = [];
  let totalSize = 0;

  async function visit(relative) {
    const path = relative === "." ? root : join(root, relative);
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || stats.uid !== 0) {
      throw new Error(`${path} is not a safe root-owned plugin entry`);
    }
    const mode = stats.mode & 0o777;
    if (stats.isDirectory()) {
      entries.push({ path: relative, type: "directory", mode, size: 0, sha256: null });
      const children = (await readdir(path)).sort();
      for (const child of children) {
        await visit(relative === "." ? child : join(relative, child));
      }
      return;
    }
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error(`${path} is not a regular single-link plugin file`);
    }
    if (stats.size > MAX_PLUGIN_FILE_BYTES) {
      throw new Error(`${path} exceeds the plugin file size limit`);
    }
    const content = await readBoundedFile(path, MAX_PLUGIN_FILE_BYTES);
    totalSize += content.length;
    entries.push({
      path: relative,
      type: "file",
      mode,
      size: content.length,
      sha256: sha256(content),
    });
  }

  const rootStats = await inspectPath(root);
  if (!rootStats) return undefined;
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory() || rootStats.uid !== 0) {
    throw new Error(`${root} must be a safe root-owned plugin directory`);
  }
  await visit(".");
  return {
    entries,
    size: totalSize,
    tree_sha256: sha256(Buffer.from(JSON.stringify(entries), "utf8")),
  };
}

async function syncTree(root) {
  const stats = await lstat(root);
  if (stats.isDirectory()) {
    for (const child of (await readdir(root)).sort()) {
      await syncTree(join(root, child));
    }
    await syncDirectory(root);
    return;
  }
  assertRootOwnedRegular(root, stats);
  const handle = await open(
    root,
    fsConstants.O_RDONLY |
      fsConstants.O_NOFOLLOW |
      fsConstants.O_NONBLOCK,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function copyVerifiedTree(source, target, expected) {
  if (await inspectPath(target)) {
    throw new Error("A managed plugin transaction path already exists");
  }
  await cp(source, target, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  await syncTree(target);
  await syncDirectory(dirname(target));
  const copied = await snapshotTree(target);
  if (!copied || copied.tree_sha256 !== expected.tree_sha256) {
    throw new Error("A managed plugin copy failed digest verification");
  }
  return copied;
}

function validateMarker(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== 1 ||
    value.owner !== OWNER ||
    value.plugin !== "home-assistant" ||
    !Array.isArray(value.applied_versions) ||
    new Set(value.applied_versions).size !== value.applied_versions.length ||
    value.applied_versions.some((version) => {
      try {
        validateVersion(version);
        return false;
      } catch {
        return true;
      }
    })
  ) {
    throw new Error("The managed plugin ownership marker is invalid");
  }
  if (value.installed_version !== null && value.installed_version !== undefined) {
    validateVersion(value.installed_version);
  }
  return value;
}

function validateJournal(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schema !== JOURNAL_SCHEMA ||
    value.owner !== OWNER ||
    value.kind !== "managed-plugin-refresh" ||
    typeof value.transaction !== "string" ||
    !PLUGIN_TRANSACTION_PATTERN.test(value.transaction) ||
    !VALID_PHASES.has(value.phase) ||
    typeof value.before_exists !== "boolean" ||
    (value.before_exists && !/^[0-9a-f]{64}$/u.test(value.before_tree_sha256)) ||
    (!value.before_exists && value.before_tree_sha256 !== null) ||
    (value.candidate_tree_sha256 !== null &&
      !/^[0-9a-f]{64}$/u.test(value.candidate_tree_sha256))
  ) {
    throw new Error("The managed plugin update journal is invalid");
  }
  if (value.source_version !== null) validateVersion(value.source_version);
  validateVersion(value.target_version);
  return value;
}

async function saveJournal(journal, phase) {
  journal.phase = phase;
  validateJournal(journal);
  await writeAtomicJson(JOURNAL_PATH, journal);
}

async function loadJournal() {
  const value = await readJson(JOURNAL_PATH, true);
  return value === undefined ? undefined : validateJournal(value);
}

function transactionPaths(journal) {
  const transactionDirectory = join(BACKUP_ROOT, journal.transaction);
  return {
    transactionDirectory,
    backup: join(transactionDirectory, "plugin.before"),
    displaced: join(transactionDirectory, "plugin.displaced"),
    failed: join(transactionDirectory, "plugin.failed"),
    manifest: join(transactionDirectory, "manifest.json"),
    stage: join(PLUGINS_ROOT, `.home-assistant.stage-${journal.transaction}`),
    uncommitted: join(transactionDirectory, "plugin.uncommitted"),
  };
}

async function assertNoDuplicatePlugins() {
  for (const path of DUPLICATE_PLUGIN_PATHS) {
    if (await inspectPath(path)) {
      throw new Error(`A duplicate home-assistant plugin conflicts at ${path}`);
    }
  }
}

function nativeEnvironment() {
  return {
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    HOME: DATA_HOME,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
}

async function runNative(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(NATIVE, args, {
      cwd: "/config",
      env: nativeEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let length = 0;
    let rejected = false;
    const timeout = setTimeout(() => {
      rejected = true;
      child.kill("SIGKILL");
      reject(new Error("The native plugin validation timed out"));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_NATIVE_OUTPUT_BYTES) {
        rejected = true;
        child.kill("SIGKILL");
        clearTimeout(timeout);
        reject(new Error("The native plugin validation output was too large"));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (!rejected) reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (rejected) return;
      if (code !== 0 || signal) {
        reject(new Error("The native plugin validation command failed"));
        return;
      }
      resolve(Buffer.concat(chunks, length).toString("utf8"));
    });
  });
}

async function validatePlugin(path) {
  await runNative(["plugin", "validate", path]);
}

async function validateInstalledPostcondition(expectedDigest) {
  await validatePlugin(TARGET);
  const installed = await snapshotTree(TARGET);
  if (!installed || installed.tree_sha256 !== expectedDigest) {
    throw new Error("The installed managed plugin changed during postcondition checks");
  }
}

async function moveAside(path, destination) {
  const current = await inspectPath(path);
  if (!current) return;
  if (current.isSymbolicLink() || !current.isDirectory() || current.uid !== 0) {
    throw new Error("A managed plugin transaction path is unsafe");
  }
  if (await inspectPath(destination)) {
    throw new Error("A managed plugin recovery destination already exists");
  }
  await rename(path, destination);
  await syncDirectory(dirname(path));
  await syncDirectory(dirname(destination));
}

async function restorePreviousPlugin(journal, paths) {
  const current = await snapshotTree(TARGET);
  const currentDigest = current?.tree_sha256;

  if (journal.before_exists) {
    if (current && currentDigest === journal.before_tree_sha256) {
      // The old target was never displaced or was already restored.
    } else if (
      current &&
      journal.candidate_tree_sha256 !== null &&
      currentDigest === journal.candidate_tree_sha256
    ) {
      await moveAside(TARGET, paths.failed);
    } else if (current) {
      throw new FatalPluginUpdateError(
        "The managed plugin target is ambiguous; automatic recovery was not attempted",
      );
    }

    if (!(await inspectPath(TARGET))) {
      const displaced = await snapshotTree(paths.displaced);
      if (displaced) {
        if (displaced.tree_sha256 !== journal.before_tree_sha256) {
          throw new FatalPluginUpdateError("The displaced managed plugin failed verification");
        }
        await rename(paths.displaced, TARGET);
        await syncDirectory(dirname(paths.displaced));
        await syncDirectory(PLUGINS_ROOT);
      } else {
        const backup = await snapshotTree(paths.backup);
        if (!backup || backup.tree_sha256 !== journal.before_tree_sha256) {
          throw new FatalPluginUpdateError("The verified managed plugin backup is unavailable");
        }
        await copyVerifiedTree(paths.backup, TARGET, backup);
      }
    }
    await validateInstalledPostcondition(journal.before_tree_sha256);
  } else if (current) {
    if (
      journal.candidate_tree_sha256 === null ||
      currentDigest !== journal.candidate_tree_sha256
    ) {
      throw new FatalPluginUpdateError(
        "The new managed plugin target is ambiguous; automatic recovery was not attempted",
      );
    }
    await moveAside(TARGET, paths.failed);
  }

  if (await inspectPath(paths.stage)) {
    await moveAside(paths.stage, paths.uncommitted);
  }
  await removeJournal();
}

async function finishCommittedPlugin(journal, paths) {
  if (journal.candidate_tree_sha256 === null) {
    throw new FatalPluginUpdateError("The committed managed plugin digest is missing");
  }
  await validateInstalledPostcondition(journal.candidate_tree_sha256);
  const displaced = await snapshotTree(paths.displaced);
  if (displaced) {
    if (!journal.before_exists || displaced.tree_sha256 !== journal.before_tree_sha256) {
      throw new FatalPluginUpdateError("The displaced managed plugin is unsafe to finalize");
    }
  }
  await removeJournal();
}

async function recoverPendingTransaction() {
  let journal;
  try {
    journal = await loadJournal();
  } catch (error) {
    throw new FatalPluginUpdateError(
      `The pending managed plugin journal is unsafe: ${error.message}`,
    );
  }
  if (!journal) return "none";
  const paths = transactionPaths(journal);
  await secureDirectory(paths.transactionDirectory, 0o700);
  if (new Set(["postcondition_verified", "committed"]).has(journal.phase)) {
    await finishCommittedPlugin(journal, paths);
    return "committed";
  }
  await restorePreviousPlugin(journal, paths);
  return "rolled_back";
}

async function inspectCompletedBackup(path, transaction) {
  const rootStats = await lstat(path);
  if (
    rootStats.isSymbolicLink() ||
    !rootStats.isDirectory() ||
    rootStats.uid !== 0
  ) {
    throw new Error("A managed plugin backup root is unsafe");
  }
  const tree = await snapshotTree(path);
  if (!tree) throw new Error("A managed plugin backup disappeared");
  for (const entry of tree.entries) {
    if (entry.path === ".") continue;
    const topLevel = entry.path.split("/")[0];
    if (!BACKUP_CHILDREN.has(topLevel)) {
      throw new Error("A managed plugin backup contains an unexpected path");
    }
  }
  const manifestPath = join(path, "manifest.json");
  if (!(await inspectPath(manifestPath))) {
    throw new Error("A managed plugin backup has no ownership manifest");
  }
  const manifest = await readJson(manifestPath);
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schema !== 1 ||
    manifest.owner !== OWNER ||
    manifest.transaction !== transaction ||
    manifest.target !== TARGET
  ) {
    throw new Error("A managed plugin backup manifest is not App-owned");
  }
  return { mtimeMs: rootStats.mtimeMs, tree_sha256: tree.tree_sha256 };
}

async function removeCompletedBackup(path, transaction) {
  const before = await lstat(path);
  await inspectCompletedBackup(path, transaction);
  const quarantine = join(
    BACKUP_ROOT,
    `.${transaction}.prune-${randomBytes(6).toString("hex")}`,
  );
  await rename(path, quarantine);
  await syncDirectory(BACKUP_ROOT);
  try {
    const moved = await lstat(quarantine);
    if (
      moved.isSymbolicLink() ||
      !moved.isDirectory() ||
      moved.uid !== 0 ||
      moved.dev !== before.dev ||
      moved.ino !== before.ino
    ) {
      throw new Error("A managed plugin backup changed during quarantine");
    }
    await inspectCompletedBackup(quarantine, transaction);
    await rm(quarantine, {
      force: false,
      maxRetries: 2,
      recursive: true,
      retryDelay: 20,
    });
    await syncDirectory(BACKUP_ROOT);
  } catch (error) {
    if (!(await inspectPath(path)) && await inspectPath(quarantine)) {
      await rename(quarantine, path).catch(() => {});
      await syncDirectory(BACKUP_ROOT).catch(() => {});
    }
    throw error;
  }
}

async function pruneCompletedPluginBackups(preserve = new Set()) {
  const journal = await loadJournal();
  if (journal) preserve.add(journal.transaction);
  const candidates = [];
  for (const name of (await readdir(BACKUP_ROOT)).sort()) {
    const quarantine = PRUNE_QUARANTINE_PATTERN.exec(name);
    if (quarantine) {
      const transaction = quarantine[1];
      if (preserve.has(transaction)) continue;
      const path = join(BACKUP_ROOT, name);
      try {
        await inspectCompletedBackup(path, transaction);
        await rm(path, {
          force: false,
          maxRetries: 2,
          recursive: true,
          retryDelay: 20,
        });
        await syncDirectory(BACKUP_ROOT);
      } catch {
        // Unsafe or concurrently changed entries are intentionally preserved.
      }
      continue;
    }
    if (!PLUGIN_TRANSACTION_PATTERN.test(name) || preserve.has(name)) continue;
    const path = join(BACKUP_ROOT, name);
    try {
      const inspected = await inspectCompletedBackup(path, name);
      candidates.push({ name, path, ...inspected });
    } catch {
      // Exact App ownership could not be established, so do not delete it.
    }
  }
  candidates.sort((left, right) =>
    right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
  let retained = preserve.size;
  for (const candidate of candidates) {
    if (retained < BACKUP_RETENTION) {
      retained += 1;
      continue;
    }
    try {
      await removeCompletedBackup(candidate.path, candidate.name);
    } catch {
      // A failed safe delete must not make the installed plugin unavailable.
    }
  }
}

async function createTransaction(before, marker, targetVersion) {
  const sourceVersion = marker?.installed_version ?? null;
  const sourcePart = sourceVersion ?? "none";
  const transaction = `plugin-${sourcePart}-to-${targetVersion}-${randomBytes(6).toString("hex")}`;
  const transactionDirectory = join(BACKUP_ROOT, transaction);
  await mkdir(transactionDirectory, { mode: 0o700 });
  await syncDirectory(BACKUP_ROOT);
  const journal = {
    schema: JOURNAL_SCHEMA,
    owner: OWNER,
    kind: "managed-plugin-refresh",
    transaction,
    source_version: sourceVersion,
    target_version: targetVersion,
    phase: "preflighted",
    before_exists: before !== undefined,
    before_tree_sha256: before?.tree_sha256 ?? null,
    candidate_tree_sha256: null,
  };
  await saveJournal(journal, "preflighted");
  return { journal, paths: transactionPaths(journal) };
}

async function writeCandidateMarker(path, previousMarker, targetVersion) {
  const applied = new Set(previousMarker?.applied_versions ?? []);
  applied.add(targetVersion);
  await writeAtomicJson(join(path, MARKER_NAME), {
    schema: 1,
    owner: OWNER,
    plugin: "home-assistant",
    installed_version: targetVersion,
    applied_versions: [...applied].sort(),
  });
}

async function installManagedPlugin(before, marker, targetVersion) {
  const { journal, paths } = await createTransaction(before, marker, targetVersion);
  let recovered = false;
  try {
    let backup;
    if (before) {
      backup = await copyVerifiedTree(TARGET, paths.backup, before);
    }
    await saveJournal(journal, "backed_up");

    const source = await snapshotTree(SOURCE);
    if (!source) throw new Error("The image-managed plugin source is missing");
    await copyVerifiedTree(SOURCE, paths.stage, source);
    await writeCandidateMarker(paths.stage, marker, targetVersion);
    await syncTree(paths.stage);
    const candidate = await snapshotTree(paths.stage);
    journal.candidate_tree_sha256 = candidate.tree_sha256;
    await saveJournal(journal, "staged");
    await validatePlugin(paths.stage);
    const afterValidation = await snapshotTree(paths.stage);
    if (afterValidation.tree_sha256 !== candidate.tree_sha256) {
      throw new Error("Native validation changed the staged managed plugin");
    }

    await writeAtomicJson(paths.manifest, {
      schema: 1,
      owner: OWNER,
      transaction: journal.transaction,
      source_version: journal.source_version,
      target_version: journal.target_version,
      target: TARGET,
      before: before ?? null,
      candidate,
    });
    await saveJournal(journal, "validated");

    await assertNoDuplicatePlugins();
    const current = await snapshotTree(TARGET);
    if ((before?.tree_sha256 ?? null) !== (current?.tree_sha256 ?? null)) {
      throw new Error("The managed plugin target changed after backup");
    }
    const targetParent = await lstat(PLUGINS_ROOT);
    const transactionParent = await lstat(paths.transactionDirectory);
    if (targetParent.dev !== transactionParent.dev) {
      throw new Error("Managed plugin backup and target are not on the same filesystem");
    }

    await saveJournal(journal, "activating");
    if (before) {
      await rename(TARGET, paths.displaced);
      await syncDirectory(PLUGINS_ROOT);
      await syncDirectory(paths.transactionDirectory);
    }
    await rename(paths.stage, TARGET);
    await syncDirectory(PLUGINS_ROOT);
    await saveJournal(journal, "activated");

    await validateInstalledPostcondition(candidate.tree_sha256);
    await saveJournal(journal, "postcondition_verified");
    await saveJournal(journal, "committed");
    await finishCommittedPlugin(journal, paths);
    return {
      backup_directory: before ? paths.transactionDirectory : null,
      degraded: false,
      recovered,
      updated: true,
      version: targetVersion,
      warning: null,
    };
  } catch (error) {
    try {
      const outcome = await recoverPendingTransaction();
      recovered = outcome !== "none";
    } catch (recoveryError) {
      throw new FatalPluginUpdateError(
        `Managed plugin update and recovery failed: ${recoveryError.message}`,
      );
    }
    if (before) {
      return {
        backup_directory: paths.transactionDirectory,
        degraded: true,
        recovered,
        updated: false,
        version: marker.installed_version,
        warning: "The new managed plugin was rejected; the previous verified copy was restored",
      };
    }
    throw new FatalPluginUpdateError(
      `The initial managed plugin installation failed: ${error.message}`,
    );
  }
}

async function prepareRoots() {
  await ensureDirectory(DATA_HOME);
  await ensureDirectory(join(DATA_HOME, ".gemini"));
  await ensureDirectory(join(DATA_HOME, ".gemini", "config"));
  await ensureDirectory(PLUGINS_ROOT);
  await ensureDirectory(APP_DATA_ROOT);
  await ensureDirectory(MIGRATION_ROOT);
  await ensureDirectory(BACKUP_ROOT);
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("managed-plugin-update.mjs does not accept command-line arguments");
  }
  await prepareRoots();
  const recovery = await recoverPendingTransaction();
  await assertNoDuplicatePlugins();

  const versionContent = await readBoundedFile(APP_VERSION_PATH, 128);
  if (versionContent === undefined) {
    throw new FatalPluginUpdateError("The image App version file is missing");
  }
  const targetVersion = validateVersion(versionContent.toString("utf8").trim());

  const sourceMarker = await inspectPath(join(SOURCE, MARKER_NAME));
  if (sourceMarker) {
    throw new FatalPluginUpdateError("The image plugin source contains an ownership marker");
  }
  const source = await snapshotTree(SOURCE);
  if (!source) throw new FatalPluginUpdateError("The image-managed plugin source is missing");
  await validatePlugin(SOURCE);
  const sourceAfterValidation = await snapshotTree(SOURCE);
  if (source.tree_sha256 !== sourceAfterValidation.tree_sha256) {
    throw new FatalPluginUpdateError("Native validation changed the image plugin source");
  }

  const installed = await snapshotTree(TARGET);
  let marker;
  if (installed) {
    marker = validateMarker(await readJson(MARKER_PATH));
    await validateInstalledPostcondition(installed.tree_sha256);
    if (marker.installed_version === targetVersion) {
      await pruneCompletedPluginBackups();
      process.stdout.write(`${JSON.stringify({
        backup_directory: null,
        degraded: false,
        recovered: recovery !== "none",
        updated: false,
        version: targetVersion,
        warning: null,
      })}\n`);
      return;
    }
  }

  const result = await installManagedPlugin(installed, marker, targetVersion);
  result.recovered ||= recovery !== "none";
  const preserve = new Set();
  if (result.backup_directory !== null) {
    preserve.add(basename(result.backup_directory));
  }
  await pruneCompletedPluginBackups(preserve);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  await main();
} catch (error) {
  const prefix = error instanceof FatalPluginUpdateError
    ? "managed plugin recovery error"
    : "managed plugin update error";
  process.stderr.write(`${prefix}: ${error.message}\n`);
  process.exitCode = 30;
}
