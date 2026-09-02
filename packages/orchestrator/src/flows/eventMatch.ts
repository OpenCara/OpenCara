/**
 * Cheap, side-effect-free pre-filter: can ANY trigger of this flow match this
 * platform event? The engine consults it before minting a flow_run, so an
 * event that only concerns one of the four stage flows doesn't leave three
 * cancelled `trigger_skip` runs behind. It deliberately checks only what is
 * knowable from the event itself (kind ↔ event type, action, comment phrase)
 * — branch / path / label / draft filters need PR context and stay with the
 * trigger runner, whose skip is still recorded on a run.
 */
import { isTriggerKind, type FlowDefinition } from "@opencara/flows";

interface EventLike {
  type: string;
  payload: unknown;
}

export function flowMayMatchEvent(def: FlowDefinition, event: EventLike): boolean {
  const triggers = def.nodes.filter((n) => isTriggerKind(n.kind));
  if (triggers.length === 0) return true;
  return triggers.some((t) => triggerMayMatchEvent(t, event));
}

export function triggerMayMatchEvent(trigger: FlowDefinition["nodes"][number], event: EventLike): boolean {
  const payload = (event.payload ?? {}) as {
    action?: unknown;
    issue?: { pull_request?: unknown };
    comment?: { body?: unknown };
  };
  switch (trigger.kind) {
    case "schedule.cron":
      return false;
    case "scm.board_item":
      return event.type === "projects_v2_item";
    case "scm.pull_request": {
      const cfg = trigger.config;
      if (event.type === "pull_request") {
        return typeof payload.action === "string" && (cfg.actions as readonly string[]).includes(payload.action);
      }
      if (event.type === "issue_comment") {
        if (!(cfg.actions as readonly string[]).includes("commented")) return false;
        if (payload.action !== "created" || !payload.issue?.pull_request) return false;
        return commentMentions(payload.comment?.body, cfg.commentPhrase);
      }
      return false;
    }
    case "scm.pull_request_review": {
      // The runner only fires on `submitted`; edited / dismissed reviews
      // would otherwise mint a trigger_skip run each.
      if (event.type === "pull_request_review") return payload.action === "submitted";
      if (event.type === "issue_comment") {
        if (payload.action !== "created" || !payload.issue?.pull_request) return false;
        return commentMentions(payload.comment?.body, trigger.config.commentPhrase);
      }
      return false;
    }
    default:
      // Unknown trigger kinds: be conservative and let the runner decide.
      return true;
  }
}

function commentMentions(body: unknown, phrase: unknown): boolean {
  if (typeof phrase !== "string" || phrase.length === 0) return false;
  if (typeof body !== "string") return false;
  return body.toLowerCase().includes(phrase.toLowerCase());
}
