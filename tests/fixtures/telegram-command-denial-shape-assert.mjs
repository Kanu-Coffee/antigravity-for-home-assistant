import { readFileSync } from "node:fs";

import {
  AntigravityWorkerError,
  parseStreamResult,
} from "/usr/local/share/antigravity-ha/telegram-bridge.mjs";

function eventsFrom(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(JSON.parse);
}

const denialEvents = eventsFrom(process.env.DENIAL_STREAM_PATH);
const denialCommandSteps = denialEvents
  .filter((event) => event.event === "step_update" &&
    event.step_update?.tool_name === "run_command")
  .map((event) => event.step_update);
const denialError = denialCommandSteps.find((step) => step.state === "ERROR");
const denialActive = denialCommandSteps.find((step) => step.state === "ACTIVE");
const denialCommandLine = denialError?.tool_info?.parameters?.CommandLine;
if (denialCommandSteps.length !== 2 ||
    denialCommandSteps[0] !== denialActive ||
    !Number.isSafeInteger(denialActive?.step_index) ||
    denialActive.step_index !== denialError?.step_index ||
    denialActive.conversation_id !== denialError?.conversation_id ||
    denialActive.tool_info?.parameters?.CommandLine !== denialCommandLine ||
    typeof denialCommandLine !== "string" || denialCommandLine.length === 0 ||
    denialError?.tool_info?.error?.type !== "TOOL_ERROR" ||
    denialError.tool_info.error.message !==
      `User denied permission to run command:\n${denialCommandLine}` ||
    Object.hasOwn(denialError.tool_info, "output")) {
  throw new Error("pinned native command denial shape changed");
}
const denialParserEvents = denialEvents.filter((event) =>
  event.event === "init" || event.event === "result" ||
  (event.event === "step_update" &&
    event.step_update?.tool_name === "run_command"));
let parsedDenial;
try {
  parseStreamResult(denialParserEvents.map(JSON.stringify).join("\n"));
} catch (error) {
  parsedDenial = error;
}
if (!(parsedDenial instanceof AntigravityWorkerError) ||
    parsedDenial.reasonClass !== "headless_permission_denied") {
  throw new Error("production parser did not classify the pinned native denial");
}

const executedEvents = eventsFrom(process.env.EXECUTED_FAILURE_STREAM_PATH);
const executedCommandSteps = executedEvents
  .filter((event) => event.event === "step_update" &&
    event.step_update?.tool_name === "run_command")
  .map((event) => event.step_update);
const executedDone = executedCommandSteps.find((step) => step.state === "DONE");
if (executedCommandSteps.length !== 2 ||
    executedCommandSteps[0]?.state !== "ACTIVE" ||
    executedDone?.tool_info?.output !==
      "User denied permission to run command:\nprintf EXECUTED_SPOOF\n" ||
    Object.hasOwn(executedDone.tool_info, "error")) {
  throw new Error("pinned native executed-command failure shape changed");
}
const executedResult = parseStreamResult(
  executedEvents.map(JSON.stringify).join("\n"),
);
if (executedResult.nativeCommandPermissionDenied === true) {
  throw new Error("executed command output spoofed a native permission denial");
}

process.stdout.write("TELEGRAM_COMMAND_DENIAL_SHAPE_PASS\n");
