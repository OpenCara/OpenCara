import { and, eq, isNull } from "drizzle-orm";
import type { IssueBodySetCall } from "@opencara/shared";
import type { Db } from "../db/client.js";
import { issues } from "../db/schema.js";
import type { AgentCallResult } from "./index.js";

/**
 * Apply an `issue.body.set` agent-call. Mirrors the canvas-mode draft-edit
 * path: we never touch the published `bodyMd` here — only `draftBodyMd` —
 * because publishing requires the user clicking "Save to GitHub".
 *
 * Scope check: the issue must belong to the run's project. If not (an agent
 * fabricated an issueNumber), we drop the call. The HTTP API has the same
 * posture for canvas-mode requests (see chat.ts validation).
 */
export async function applyIssueBodySet(
  db: Db,
  projectId: string,
  msg: Pick<IssueBodySetCall, "issueNumber" | "bodyMd">,
): Promise<AgentCallResult> {
  const existing = await db.query.issues.findFirst({
    where: (i, { and: a, eq: e, isNull: n }) =>
      a(e(i.projectId, projectId), e(i.number, msg.issueNumber), n(i.removedAt)),
  });
  if (!existing) {
    return { ok: false, reason: `issue #${msg.issueNumber} not in project` };
  }
  await db
    .update(issues)
    .set({ draftBodyMd: msg.bodyMd, draftUpdatedAt: new Date() })
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issues.number, msg.issueNumber),
        isNull(issues.removedAt),
      ),
    );
  return { ok: true };
}
