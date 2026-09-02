/** Human label for a flow run's originating platform event type. */
export function triggerTypeLabel(type: string | null | undefined): string {
  switch (type) {
    case "schedule":
      return "Schedule";
    case "pull_request":
      return "Pull request";
    case "pull_request_review":
      return "PR review";
    case "projects_v2_item":
      return "Project status";
    case "issue_comment":
      return "Comment";
    case "manual":
      return "Manual";
    case null:
    case undefined:
      return "—";
    default:
      return type;
  }
}
