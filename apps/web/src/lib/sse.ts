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
  /** SSE event names that should terminate the stream. Default: ["end"]. */
  endEvents?: string[];
}

/**
 * Subscribes to an SSE endpoint and accumulates parsed events.
 * Auto-reconnects EventSource (browser-native) until `ended` event arrives.
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

    const handleNamed = (name: string) => (e: MessageEvent) => {
      if (endNames.includes(name)) {
        setEnded(true);
        es.close();
        return;
      }
      const item = optsRef.current.parse({ event: name, data: e.data });
      if (item != null) setEvents((prev) => [...prev, item]);
    };

    es.addEventListener("log", handleNamed("log"));
    es.addEventListener("end", handleNamed("end"));
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
