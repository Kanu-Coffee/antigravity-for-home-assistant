import { readFile } from "node:fs/promises";

import {
  BrokerError,
  DEFAULT_PROPOSAL_SOCKET_PATH,
  sendBrokerRequest,
} from "./ha-change-broker.mjs";

const ALLOWED_ACTIONS = new Set([
  "health",
  "propose",
  "inspect",
  "authorize",
  "execute",
  "execute_status",
]);
const MAX_INPUT_BYTES = 1024 * 1024;

async function main() {
  if (process.argv.length !== 3 || !ALLOWED_ACTIONS.has(process.argv[2])) {
    console.error(
      "Usage: ha-change-broker-client health|propose|inspect|authorize|execute|execute_status < payload.json",
    );
    process.exit(64);
  }
  delete process.env.SUPERVISOR_TOKEN;
  delete process.env.BASH_ENV;
  delete process.env.ENV;
  delete process.env.NODE_OPTIONS;
  delete process.env.NODE_PATH;
  const input = await readFile(0);
  if (input.length > MAX_INPUT_BYTES) {
    console.error("ha-change-broker-client: input exceeds the limit");
    process.exit(65);
  }
  let payload = {};
  if (input.toString("utf8").trim() !== "") {
    try {
      payload = JSON.parse(input.toString("utf8"));
    } catch {
      console.error("ha-change-broker-client: input must be one JSON object");
      process.exit(65);
    }
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    console.error("ha-change-broker-client: input must be one JSON object");
    process.exit(65);
  }
  try {
    const options = process.argv[2] === "propose"
      ? { socketPath: DEFAULT_PROPOSAL_SOCKET_PATH }
      : {};
    const result = await sendBrokerRequest(process.argv[2], payload, options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof BrokerError ? error.code : "broker_error";
    console.error(`ha-change-broker-client: ${code}`);
    process.exit(1);
  }
}

main().catch(() => process.exit(1));
