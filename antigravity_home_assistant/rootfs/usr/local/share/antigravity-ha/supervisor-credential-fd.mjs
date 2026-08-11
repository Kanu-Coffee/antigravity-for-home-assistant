import { closeSync, fstatSync, readFileSync, readlinkSync } from "node:fs";

const CREDENTIAL_FD_ENV = "ANTIGRAVITY_HA_SUPERVISOR_FD";
// Keep the payload at or below one Linux pipe page. The bootstrap fills the
// anonymous handoff pipe before the long-running broker starts reading it.
const MAX_CREDENTIAL_BYTES = 4_096;

export function consumeSupervisorCredentialFromInheritedFd({
  environment = process.env,
  requiredUid = 0,
} = {}) {
  const descriptorText = environment[CREDENTIAL_FD_ENV];
  delete environment[CREDENTIAL_FD_ENV];
  delete environment.SUPERVISOR_TOKEN;

  if (!/^[1-9][0-9]{0,3}$/u.test(descriptorText ?? "")) {
    throw new Error("Supervisor credential descriptor is unavailable");
  }
  const descriptor = Number(descriptorText);
  let token;
  try {
    const info = fstatSync(descriptor);
    const descriptorTarget = readlinkSync(`/proc/self/fd/${descriptor}`);
    if (
      !info.isFIFO() ||
      info.uid !== requiredUid ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size !== 0 ||
      !/^pipe:\[[0-9]+\]$/u.test(descriptorTarget)
    ) {
      throw new Error("Supervisor credential descriptor is unsafe");
    }
    token = readFileSync(descriptor, "utf8");
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // A failed validation still consumes the inherited descriptor.
    }
  }
  if (
    typeof token !== "string" ||
    token === "" ||
    token.length > MAX_CREDENTIAL_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(token)
  ) {
    throw new Error("Supervisor credential is unavailable");
  }
  return token;
}
