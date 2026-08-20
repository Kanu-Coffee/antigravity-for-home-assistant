import { readFileSync } from "node:fs";

const events = readFileSync(process.env.NATIVE_STREAM_PATH, "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
const terminalEvents = events.filter((event) => event.event === "result");
const initEvents = events.filter((event) => event.event === "init");
const toolSteps = events
  .filter((event) => event.event === "step_update" &&
    event.step_update?.step_type === "tool")
  .map((event) => event.step_update);
const completedCommands = toolSteps.filter((step) =>
  step.tool_name === "run_command" && step.state === "DONE");

if (initEvents.length !== 1 || terminalEvents.length !== 1) {
  throw new Error("always-proceed native command stream cardinality changed");
}
if (terminalEvents[0]?.result?.status !== "SUCCESS" ||
    terminalEvents[0]?.result?.response?.trim() !==
      "TERMINAL-DIR-CANARY-COMPLETE") {
  throw new Error("always-proceed native command did not terminate successfully");
}
if (completedCommands.length !== 1 ||
    !JSON.stringify(completedCommands[0].tool_info)
      .includes("TERMINAL_DIR_CANARY_OK")) {
  throw new Error("always-proceed run_command did not return its bounded marker");
}
if (toolSteps.some((step) => step.state === "ERROR")) {
  throw new Error("always-proceed native command emitted an unexpected tool error");
}
