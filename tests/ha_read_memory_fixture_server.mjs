import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import net from "node:net";

const SOCKET_PATH = "/run/antigravity-ha/ha-read.sock";
const PID_PATH = "/run/antigravity-ha/ha-read-memory-fixture.pid";
const FIXTURE_PATH = process.env.HA_MEMORY_FIXTURE_PATH;
const MAX_REQUEST_BYTES = 16 * 1024;

if (!FIXTURE_PATH) throw new Error("HA_MEMORY_FIXTURE_PATH is required");
const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));

await mkdir("/run/antigravity-ha", { recursive: true, mode: 0o700 });
await chmod("/run/antigravity-ha", 0o700);
try {
  const existing = await lstat(SOCKET_PATH);
  if (!existing.isSocket() || existing.isSymbolicLink()) {
    throw new Error("fixture broker socket path is unsafe");
  }
  await unlink(SOCKET_PATH);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let input = "";
  let bytes = 0;
  let handled = false;
  const reject = (code) => socket.end(`${JSON.stringify({ ok: false, error: code })}\n`);
  socket.on("data", (chunk) => {
    if (handled) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_REQUEST_BYTES) {
      handled = true;
      reject("request_too_large");
      return;
    }
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    handled = true;
    let request;
    try {
      request = JSON.parse(input.slice(0, newline));
    } catch {
      reject("invalid_request");
      return;
    }
    if (
      request?.version !== 1 ||
      request?.action !== "memory_snapshot" ||
      request?.payload === null ||
      typeof request?.payload !== "object" ||
      Array.isArray(request.payload) ||
      Object.keys(request.payload).length !== 0 ||
      input.slice(newline + 1).trim() !== ""
    ) {
      reject("unsupported_action");
      return;
    }
    socket.end(`${JSON.stringify({ ok: true, result: fixture })}\n`);
  });
  socket.once("error", () => {});
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(SOCKET_PATH, resolve);
});
await chmod(SOCKET_PATH, 0o600);
await writeFile(PID_PATH, `${process.pid}\n`, { mode: 0o600 });
await chmod(PID_PATH, 0o600);

const stop = async () => {
  await new Promise((resolve) => server.close(resolve));
  await unlink(SOCKET_PATH).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await unlink(PID_PATH).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
