import { closeSync, fstatSync, readFileSync } from "node:fs";

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
    // The only Px entrypoint is the broker bootstrap, which validates the
    // source file and anonymous pipe target before constructing this sanitized
    // environment. Revalidate the stable descriptor properties here without
    // granting the long-running broker access to any numeric /proc fd path.
    if (
      !info.isFIFO() ||
      info.uid !== requiredUid ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size !== 0
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
