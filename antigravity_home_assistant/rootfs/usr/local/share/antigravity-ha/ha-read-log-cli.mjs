import { pathToFileURL } from "node:url";

import { HaReadError, sendHaReadRequest } from "./ha-read-client.mjs";

function parseLines(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,2}$/u.test(value)) return null;
  const lines = Number.parseInt(value, 10);
  return lines <= 500 ? lines : null;
}

export async function runHaReadLogCli({
  argv = process.argv.slice(2),
  brokerRequest = (action, payload) => sendHaReadRequest(action, payload),
  output = process.stdout,
  errorOutput = process.stderr,
} = {}) {
  let action;
  let payload;
  if (argv.length === 2 && argv[0] === "core") {
    const lines = parseLines(argv[1]);
    if (lines !== null) {
      action = "core_logs";
      payload = { lines };
    }
  } else if (
    argv.length === 3 &&
    argv[0] === "addon" &&
    /^[a-z0-9_-]{1,128}$/u.test(argv[1])
  ) {
    const lines = parseLines(argv[2]);
    if (lines !== null) {
      action = "addon_logs";
      payload = { slug: argv[1], lines };
    }
  }

  if (action === undefined) {
    errorOutput.write("managed log reader: invalid arguments\n");
    return 64;
  }

  try {
    const result = await brokerRequest(action, payload);
    if (
      result === null ||
      typeof result !== "object" ||
      !Array.isArray(result.lines) ||
      result.lines.some((line) => typeof line !== "string")
    ) {
      throw new HaReadError("invalid_response", "read broker returned invalid logs");
    }
    for (const line of result.lines) output.write(`${line}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof HaReadError ? error.code : "read_failed";
    errorOutput.write(`managed log reader failed: ${code}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  delete process.env.SUPERVISOR_TOKEN;
  delete process.env.BASH_ENV;
  delete process.env.ENV;
  delete process.env.NODE_OPTIONS;
  delete process.env.NODE_PATH;
  process.exitCode = await runHaReadLogCli();
}
