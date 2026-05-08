// Job dispatch on the device side. Pre-#30 this hosted both an ACP
// path (`runAcpJob`) and a legacy stdin-JSON path (`runJob` that
// piped a JSON envelope to a kind-specific CLI). The cutover deleted
// the legacy path; ACP is the only way an agent runs now. This file
// is a thin re-export so call sites that already imported from
// `runner/spawn.js` keep compiling.

export { runAcpJob } from "./acpRunner.js";
export type { AcpRunController, AcpRunHandlers, AcpRunResult } from "./acpRunner.js";
