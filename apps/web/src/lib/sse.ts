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

    const handleNamed = (name: string) => (e: MessageEvent) => {
      if (endNames.includes(name)) {
        setEnded(true);
        es.close();
        return;
      }
      const item = optsRef.current.parse({ event: name, data: e.data });
      if (item != null) setEvents((prev) => [...prev, item]);
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
