import { readFileSync } from "node:fs";

const events = readFileSync(process.env.NATIVE_STREAM_PATH, "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
const terminal = events.find((event) => event.event === "result");
const toolSteps = events
  .filter((event) => event.event === "step_update" &&
    event.step_update?.step_type === "tool")
  .map((event) => event.step_update);
const requireAppArmor = process.env.PERMISSION_CANARY_REQUIRE_APPARMOR === "true";
if (
  terminal?.result?.status !== "SUCCESS" ||
  terminal?.result?.response !== "PERMISSION_CANARY_DONE\n"
) {
  throw new Error(
    "native command/MCP permission canary did not finish successfully",
  );
}
if (!toolSteps.some((step) =>
  step.tool_name === "write_to_file" && step.state === "ERROR" &&
  /denied|permission/iu.test(JSON.stringify(step.tool_info)))) {
  throw new Error("native settings write deny did not emit a permission error");
}
if (requireAppArmor && toolSteps.filter((step) =>
  step.tool_name === "write_to_file" && step.state === "ERROR" &&
  /denied|permission|operation not permitted/iu.test(
    JSON.stringify(step.tool_info),
  )).length < 2) {
  throw new Error("settings symlink alias did not hit the resolved-target deny");
}
for (const expected of ["run_command", "call_mcp_tool"]) {
  if (!toolSteps.some((step) =>
    step.tool_name === expected && step.state === "DONE")) {
    throw new Error(`${expected} did not complete under the managed allow rule`);
  }
}
const haChangeStep = toolSteps.find((step) =>
  step.tool_name === "call_mcp_tool" && step.state === "DONE" &&
  step.tool_info?.parameters?.ServerName === "ha_change" &&
  step.tool_info?.parameters?.ToolName === "ha_change_propose");
if (!haChangeStep) {
  throw new Error("native ha_change proposal metadata canary did not complete");
}
const proposalParameters = haChangeStep.tool_info.parameters;
const proposalParameterKeys = Object.keys(proposalParameters).sort();
const requiredProposalParameterKeys = ["Arguments", "ServerName", "ToolName"];
const allowedProposalParameterKeys = new Set([
  ...requiredProposalParameterKeys,
  "toolAction",
  "toolSummary",
]);
if (!requiredProposalParameterKeys.every((key) => proposalParameterKeys.includes(key)) ||
    !proposalParameterKeys.every((key) => allowedProposalParameterKeys.has(key)) ||
    (Object.hasOwn(proposalParameters, "toolAction") &&
      proposalParameters.toolAction !==
        "Prepare a synthetic Home Assistant change proposal") ||
    (Object.hasOwn(proposalParameters, "toolSummary") &&
      proposalParameters.toolSummary !==
        "Synthetic Home Assistant proposal metadata canary")) {
  throw new Error("native ha_change proposal metadata shape changed");
}
