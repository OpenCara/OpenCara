// Server-side handlers for `opencara-call` mutations the CLI proxies back
// over the device WS. Each helper validates that the targeted resource is
// in the run's project/user scope, then applies a drizzle write.
//
// The HTTP PATCH routes in routes/api/{flows,flowTemplates}.ts are the
// reference implementation for shape + validation; helpers here mirror
// that logic so the agent path can't bypass validation the route enforces.
// If you change validation in either place, update both — there's no
// shared route handler today (Hono routes own their own context).
//
// Convention: helpers return `{ ok: true }` or `{ ok: false; reason }`.
// The caller in dispatch/devices.ts logs `reason` and otherwise drops the
// call silently — agent-calls are fire-and-forget at the protocol level.

export type AgentCallOk = { ok: true };
export type AgentCallErr = { ok: false; reason: string };
export type AgentCallResult = AgentCallOk | AgentCallErr;

export { applyIssueBodySet } from "./issueBodySet.js";
export { applyFlowNodeConfigSet } from "./flowNodeConfigSet.js";
export { applyTemplateNodeConfigSet } from "./templateNodeConfigSet.js";
export { applyKanbanWaveDispatch } from "./kanbanWaveDispatch.js";
export { applyIssueSubissueCreate } from "./issueSubissueCreate.js";
export { applyIssueCreate } from "./issueCreate.js";
export { applyIssueStateSet } from "./issueStateSet.js";
export { applyIssueCommentCreate } from "./issueCommentCreate.js";
export { applyIssueLabelsSet } from "./issueLabelsSet.js";
