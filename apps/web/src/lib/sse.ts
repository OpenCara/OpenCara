import { useEffect, useRef, useState } from "react";

export interface SseEvent {
  event: string;
  data: string;
}

export interface UseEventSourceResult<T> {
  events: T[];
  ended: boolean;
  error: string | null;
}

interface Options<T> {
  /** Map raw SSE event → typed item; return null to skip. */
  parse: (ev: SseEvent) => T | null;
  /** Named SSE events to subscribe to. Default: ["log"]. */
  events?: string[];
  /** SSE event names that should terminate the stream. Default: ["end"]. */
  endEvents?: string[];
  /**
   * Extract a monotonic dedupe key from a parsed item. When provided, items
   * whose key has already been seen are dropped — guards against backend
   * replays on EventSource auto-reconnect.
   */
  dedupeKey?: (item: T) => string | number | null | undefined;
  /**
   * Cap the accumulated events array at this size. When set, the oldest
   * entries are dropped once the array would exceed the limit. Use this
   * for long-running streams (agent logs, telemetry tails) where the
   * caller only renders a windowed view — without it the underlying
   * buffer grows linearly with output and pins memory.
   */
  maxBuffer?: number;
}

/**
 * Subscribes to an SSE endpoint and accumulates parsed events.
 * Auto-reconnects EventSource (browser-native) until an end event arrives.
 */
export function useEventSource<T>(url: string | null, opts: Options<T>): UseEventSourceResult<T> {
  const [events, setEvents] = useState<T[]>([]);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!url) return;
    setEvents([]);
    setEnded(false);
    setError(null);
    const es = new EventSource(url, { withCredentials: true });
    const endNames = optsRef.current.endEvents ?? ["end"];
    const eventNames = optsRef.current.events ?? ["log"];
    const seen = new Set<string | number>();

    const handleNamed = (name: string) => (e: MessageEvent) => {
      if (endNames.includes(name)) {
        setEnded(true);
        es.close();
        return;
      }
      const item = optsRef.current.parse({ event: name, data: e.data });
      if (item == null) return;
      const keyFn = optsRef.current.dedupeKey;
      if (keyFn) {
        const k = keyFn(item);
        if (k != null) {
          if (seen.has(k)) return;
          seen.add(k);
        }
      }
      const cap = optsRef.current.maxBuffer;
      setEvents((prev) => {
        const next = [...prev, item];
        if (cap && next.length > cap) {
          return next.slice(next.length - cap);
        }
        return next;
      });
    };

    for (const name of eventNames) {
      es.addEventListener(name, handleNamed(name));
    }
    for (const name of endNames) {
      es.addEventListener(name, handleNamed(name));
    }
    es.addEventListener("ping", () => undefined);
    es.onerror = () => {
      setError("connection error");
    };
    return () => {
      es.close();
    };
  }, [url]);

  return { events, ended, error };
}
