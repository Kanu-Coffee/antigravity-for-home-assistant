import net from "node:net";

export const HA_READ_SOCKET_PATH = "/run/antigravity-ha/ha-read.sock";
export const HA_READ_PROTOCOL_VERSION = 1;
export const HA_READ_MAX_REQUEST_BYTES = 16 * 1024;
export const HA_READ_MAX_RESPONSE_BYTES = 1024 * 1024;
export const HA_READ_MAX_MEMORY_RESPONSE_BYTES = 32 * 1024 * 1024;
export const HA_READ_DEFAULT_TIMEOUT_MS = 12_000;

export function haReadResponseLimit(action) {
  return action === "memory_snapshot"
    ? HA_READ_MAX_MEMORY_RESPONSE_BYTES
    : HA_READ_MAX_RESPONSE_BYTES;
}

export class HaReadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HaReadError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sendHaReadRequest(
  action,
  payload = {},
  {
    socketPath = HA_READ_SOCKET_PATH,
    timeoutMs = HA_READ_DEFAULT_TIMEOUT_MS,
  } = {},
) {
  if (typeof action !== "string" || !/^[a-z_]{1,32}$/u.test(action)) {
    throw new HaReadError("invalid_request", "read action is invalid");
  }
  if (!isPlainObject(payload)) {
    throw new HaReadError("invalid_request", "read payload must be an object");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new HaReadError("invalid_request", "read timeout is invalid");
  }

  const request = `${JSON.stringify({
    version: HA_READ_PROTOCOL_VERSION,
    action,
    payload,
  })}\n`;
  if (Buffer.byteLength(request) > HA_READ_MAX_REQUEST_BYTES) {
    throw new HaReadError("request_too_large", "read request exceeds the size limit");
  }
  const responseLimit = haReadResponseLimit(action);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let response = "";
    let responseBytes = 0;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new HaReadError("broker_timeout", "Home Assistant read broker timed out"));
    }, timeoutMs);
    timer.unref();

    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      responseBytes += Buffer.byteLength(chunk);
      if (responseBytes > responseLimit) {
        finish(new HaReadError("response_too_large", "read response exceeds the size limit"));
        return;
      }
      response += chunk;
    });
    socket.once("error", () => {
      finish(new HaReadError("broker_unavailable", "Home Assistant read broker is unavailable"));
    });
    socket.once("end", () => {
      if (settled) return;
      const lines = response.trimEnd().split("\n");
      if (lines.length !== 1 || lines[0] === "") {
        finish(new HaReadError("invalid_response", "read broker returned an invalid response"));
        return;
      }
      let message;
      try {
        message = JSON.parse(lines[0]);
      } catch {
        finish(new HaReadError("invalid_response", "read broker returned invalid JSON"));
        return;
      }
      if (!isPlainObject(message) || typeof message.ok !== "boolean") {
        finish(new HaReadError("invalid_response", "read broker response shape is invalid"));
        return;
      }
      if (!message.ok) {
        const code = typeof message.error === "string" && /^[a-z_]{1,48}$/u.test(message.error)
          ? message.error
          : "read_failed";
        finish(new HaReadError(code, `Home Assistant read failed: ${code}`));
        return;
      }
      finish(null, message.result);
    });
  });
}
