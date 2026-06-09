import { useMemo } from "react";
import { validateCron, nextCronOccurrences } from "@opencara/shared";

export interface CronPreviewState {
  valid: boolean;
  error: string | null;
  /** Up to 5 upcoming fire times, formatted in the schedule's timezone. */
  fireTimes: string[];
}

/**
 * Validate a cron expression and compute its next fire times for preview.
 * Memoised so it can be shared between the flow node editor and the
 * project-settings schedule form. Uses the same `@opencara/shared` cron
 * engine the orchestrator fires on, so the preview never disagrees with the
 * actual schedule.
 */
export function useCronPreview(cron: string, timezone: string): CronPreviewState {
  return useMemo(() => {
    const trimmed = cron.trim();
    const tz = timezone.trim() || "UTC";
    const check = validateCron(trimmed);
    if (!check.valid) {
      return { valid: false, error: check.error ?? "invalid cron", fireTimes: [] };
    }
    let times: Date[] = [];
    try {
      times = nextCronOccurrences(trimmed, new Date(), 5, tz);
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : "invalid timezone",
        fireTimes: [],
      };
    }
    const fmt = (d: Date) => {
      try {
        return new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: tz,
        }).format(d);
      } catch {
        return d.toISOString();
      }
    };
    return { valid: true, error: null, fireTimes: times.map(fmt) };
  }, [cron, timezone]);
}

export function CronPreview({ preview }: { preview: CronPreviewState }) {
  if (!preview.valid) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {preview.error}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
      <div className="mb-1 font-medium text-muted-foreground">Next fire times</div>
      {preview.fireTimes.length === 0 ? (
        <div className="text-muted-foreground">No upcoming occurrences within a year.</div>
      ) : (
        <ul className="space-y-0.5 font-mono">
          {preview.fireTimes.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
