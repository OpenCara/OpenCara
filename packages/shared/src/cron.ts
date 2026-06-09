// Dependency-free 5-field cron parsing + occurrence computation.
//
// Why hand-rolled instead of `cron-parser`: this module is imported by BOTH
// the orchestrator (to decide when a scheduled flow is due) and the web app
// (to preview "next N fire times" as the operator types). Sharing one
// implementation keeps the preview and the actual firing in lockstep — a
// library on only one side would let the UI promise a fire time the
// scheduler then computes differently. It also avoids pulling a runtime dep
// into the browser bundle.
//
// Supported syntax (standard Vixie-style 5-field cron):
//   ┌───────────── minute        (0-59)
//   │ ┌───────────── hour         (0-23)
//   │ │ ┌───────────── day-of-month (1-31)
//   │ │ │ ┌───────────── month        (1-12 or JAN-DEC)
//   │ │ │ │ ┌───────────── day-of-week  (0-6 or SUN-SAT; 7 = Sunday)
//   * * * * *
// Per field: `*`, `*/step`, `a`, `a-b`, `a-b/step`, and comma lists of those.
// Day-of-month vs day-of-week follow the classic rule: when BOTH are
// restricted the match is their UNION (either satisfies); when one is `*`
// the other alone gates the day.

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when the field was a bare `*` — needed for the dom/dow union rule. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

interface FieldSpec {
  min: number;
  max: number;
  names?: Record<string, number>;
}

const FIELD_SPECS: FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12, names: MONTH_NAMES }, // month
  { min: 0, max: 7, names: DOW_NAMES }, // day-of-week (7 normalised to 0)
];

class CronParseError extends Error {}

function parseValue(token: string, spec: FieldSpec): number {
  const named = spec.names?.[token.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(token)) {
    throw new CronParseError(`invalid value "${token}"`);
  }
  const n = Number(token);
  if (n < spec.min || n > spec.max) {
    throw new CronParseError(`value ${n} out of range ${spec.min}-${spec.max}`);
  }
  return n;
}

function parseField(raw: string, spec: FieldSpec): { set: Set<number>; restricted: boolean } {
  const set = new Set<number>();
  let restricted = true;
  for (const part of raw.split(",")) {
    if (part.length === 0) throw new CronParseError("empty list item");
    let rangePart = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      rangePart = part.slice(0, slash);
      const stepStr = part.slice(slash + 1);
      if (!/^\d+$/.test(stepStr) || Number(stepStr) === 0) {
        throw new CronParseError(`invalid step "${stepStr}"`);
      }
      step = Number(stepStr);
    }

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = spec.min;
      hi = spec.max;
      if (slash === -1) restricted = false;
    } else {
      const dash = rangePart.indexOf("-");
      if (dash > 0) {
        lo = parseValue(rangePart.slice(0, dash), spec);
        hi = parseValue(rangePart.slice(dash + 1), spec);
      } else {
        lo = parseValue(rangePart, spec);
        // `a/step` means "from a to max, stepping" (cron semantics).
        hi = slash === -1 ? lo : spec.max;
      }
      if (lo > hi) throw new CronParseError(`range ${lo}-${hi} is inverted`);
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, restricted };
}

/**
 * Parse a 5-field cron expression into per-field value sets. Throws a
 * descriptive Error when the expression is malformed.
 */
export function parseCron(expression: string): CronFields {
  const trimmed = expression.trim();
  if (trimmed.length === 0) throw new CronParseError("empty expression");
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    );
  }

  const fields = parts.map((p, i) => parseField(p, FIELD_SPECS[i]!));

  // Normalise day-of-week: 7 → 0 (both mean Sunday).
  const dow = new Set<number>();
  for (const v of fields[4]!.set) dow.add(v === 7 ? 0 : v);

  return {
    minute: fields[0]!.set,
    hour: fields[1]!.set,
    dayOfMonth: fields[2]!.set,
    month: fields[3]!.set,
    dayOfWeek: dow,
    domRestricted: fields[2]!.restricted,
    dowRestricted: fields[4]!.restricted,
  };
}

export interface CronValidationResult {
  valid: boolean;
  /** Present only when `valid` is false. */
  error?: string;
}

/** Non-throwing validation, for UI input feedback. */
export function validateCron(expression: string): CronValidationResult {
  try {
    parseCron(expression);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  dow: number; // 0-6, Sunday = 0
}

// Cache one formatter per timezone — constructing Intl.DateTimeFormat is the
// expensive part, and the scheduler may evaluate many schedules per tick.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** Wall-clock fields of an instant as seen in `timeZone`. DST-correct because
 *  it reads the actual local time of each candidate instant. */
function wallClockInZone(date: Date, timeZone: string): WallClock {
  const parts = getFormatter(timeZone).formatToParts(date);
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  const year = get("year");
  const month = get("month");
  const day = get("day");
  let hour = get("hour");
  // Some engines emit "24" for midnight under h23 edge cases; normalise.
  if (hour === 24) hour = 0;
  const minute = get("minute");
  // Day-of-week of a calendar date is timezone-independent, so derive it from
  // the wall-clock Y/M/D via a UTC date (avoids a second formatter).
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, dow };
}

/** Whether the calendar-date portion (month + dom/dow union) matches. When
 *  this is false the ENTIRE wall-clock day is excluded, so the caller can
 *  skip to the next day instead of testing all 1440 minutes. */
function matchesDate(wc: WallClock, f: CronFields): boolean {
  if (!f.month.has(wc.month)) return false;
  if (f.domRestricted && f.dowRestricted) {
    return f.dayOfMonth.has(wc.day) || f.dayOfWeek.has(wc.dow);
  }
  if (f.domRestricted) return f.dayOfMonth.has(wc.day);
  if (f.dowRestricted) return f.dayOfWeek.has(wc.dow);
  return true;
}

function matchesFields(wc: WallClock, f: CronFields): boolean {
  return f.minute.has(wc.minute) && f.hour.has(wc.hour) && matchesDate(wc, f);
}

// One year of minutes plus a slack day. A syntactically valid cron always
// recurs within a year, so reaching this cap means "no upcoming occurrence"
// (e.g. an impossible date like Feb 30) rather than an infinite scan.
const MAX_STEP_MINUTES = 366 * 24 * 60 + 24 * 60;

/**
 * Compute the next `count` occurrences of `expression` strictly after `from`,
 * evaluated in `timeZone` (IANA name, e.g. "America/New_York"; defaults to
 * "UTC"). Returns fewer than `count` only if none exist within a year.
 *
 * Throws if the expression is invalid (callers that want soft failure should
 * validateCron first).
 */
export function nextCronOccurrences(
  expression: string,
  from: Date,
  count: number,
  timeZone = "UTC",
): Date[] {
  const fields = parseCron(expression);
  const results: Date[] = [];
  if (count <= 0) return results;

  // Start at the next whole minute boundary after `from` (cron has
  // minute resolution; never re-fire the minute we're already in).
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  for (let step = 0; step < MAX_STEP_MINUTES && results.length < count; ) {
    const wc = wallClockInZone(cursor, timeZone);
    if (!matchesDate(wc, fields)) {
      // The whole wall-clock day is excluded — jump to (approximately) the
      // next local midnight instead of testing all of today's minutes. This
      // turns a sparse cron like "Feb 30" from a 527k-minute scan into a
      // ~366-day one. A DST shift can leave the landing instant off by up to
      // an hour, but the next iteration recomputes the wall clock fresh, so
      // correctness is preserved (at worst a few extra minute steps).
      const minutesLeftInDay = (23 - wc.hour) * 60 + (60 - wc.minute);
      cursor.setUTCMinutes(cursor.getUTCMinutes() + minutesLeftInDay);
      step += minutesLeftInDay;
      continue;
    }
    if (matchesFields(wc, fields)) {
      results.push(new Date(cursor.getTime()));
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    step += 1;
  }
  return results;
}

/**
 * The single next occurrence strictly after `from`, or null if none within a
 * year. Convenience wrapper used by the scheduler's due-time bookkeeping.
 */
export function nextCronOccurrence(
  expression: string,
  from: Date,
  timeZone = "UTC",
): Date | null {
  const [next] = nextCronOccurrences(expression, from, 1, timeZone);
  return next ?? null;
}

/** Whether `timeZone` is an IANA zone this runtime accepts. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
