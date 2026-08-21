import { existsSync, watch, writeFileSync } from "node:fs";

const [directory, readyPath, stopPath] = process.argv.slice(2);
if (!directory || !readyPath || !stopPath) {
  process.stderr.write(
    "usage: native-settings-atomic-watch.mjs DIRECTORY READY STOP\n",
  );
  process.exit(64);
}

const temporaryPattern = /^settings\.json\.[A-Za-z0-9-]{16,128}\.tmp$/;
let closed = false;

const watcher = watch(directory, { encoding: "utf8" }, (eventType, name) => {
  if (name === "settings.json") {
    process.stdout.write(`EVENT ${eventType} final\n`);
  } else if (temporaryPattern.test(name ?? "")) {
    // Never print the native random temporary suffix. The event class is all
    // the regression needs and keeps the smoke output deterministic.
    process.stdout.write(`EVENT ${eventType} temporary\n`);
  }
});

function close(status = 0) {
  if (closed) return;
  closed = true;
  watcher.close();
  clearInterval(stopPoll);
  clearTimeout(deadline);
  process.stdout.write("WATCHER_DONE\n");
  process.exitCode = status;
}

const stopPoll = setInterval(() => {
  if (existsSync(stopPath)) close();
}, 10);
const deadline = setTimeout(() => close(1), 30_000);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => close(1));
}

writeFileSync(readyPath, "ready\n", { mode: 0o600 });
