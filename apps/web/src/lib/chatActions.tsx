import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

/**
 * Pages register handlers for "apply" actions the chat panel detects in the
 * agent's reply (e.g. ```command fenced blocks). The chat panel then exposes
 * an Apply button that invokes the registered handler with the block content.
 *
 * Action types are conventional, not enforced. The current panel recognises:
 *   - `command`  → fills an agent's Command input
 *   - `prompt`   → fills a prompt body
 * Pages opt in by calling useRegisterChatAction(type, fn) on mount.
 */

type Handler = (value: string) => void;

interface ChatActionsValue {
  register: (type: string, fn: Handler) => () => void;
  resolve: (type: string) => Handler | null;
  /** Bumps when handlers register/unregister so listeners can re-render. */
  version: number;
}

const ChatActionsContext = createContext<ChatActionsValue | null>(null);

export function ChatActionsProvider({ children }: { children: ReactNode }) {
  // Backing store kept in a ref so handler updates don't re-render every
  // consumer; a companion version counter notifies anyone (the chat panel)
  // who needs to re-evaluate which actions are currently available.
  const registryRef = useRef<Map<string, Handler>>(new Map());
  const [version, setVersion] = useState(0);

  const register = useCallback((type: string, fn: Handler) => {
    registryRef.current.set(type, fn);
    setVersion((v) => v + 1);
    return () => {
      if (registryRef.current.get(type) === fn) {
        registryRef.current.delete(type);
        setVersion((v) => v + 1);
      }
    };
  }, []);

  const resolve = useCallback(
    (type: string) => registryRef.current.get(type) ?? null,
    [],
  );

  const value = useMemo<ChatActionsValue>(
    () => ({ register, resolve, version }),
    [register, resolve, version],
  );
  return (
    <ChatActionsContext.Provider value={value}>
      {children}
    </ChatActionsContext.Provider>
  );
}

/**
 * Register a handler while the calling component is mounted. The handler
 * reference may change between renders — it's stored in a ref so the
 * registry always invokes the latest closure.
 *
 * IMPORTANT: depend only on the (stable) `register` function, not the whole
 * context object. The context value reference changes every time `version`
 * bumps, and depending on it would re-run this effect on every register,
 * causing an infinite register/cleanup/register loop and a blank page.
 */
export function useRegisterChatAction(type: string, handler: Handler): void {
  const ctx = useContext(ChatActionsContext);
  const register = ctx?.register ?? null;
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!register) return;
    return register(type, (v) => ref.current(v));
  }, [register, type]);
}

/**
 * Returns a function that resolves a handler for an action type, plus the
 * registry version (so the panel can re-render when the available actions
 * change without forcing all the action buttons through context).
 */
export function useChatActions() {
  const ctx = useContext(ChatActionsContext);
  const resolve = useCallback(
    (type: string): Handler | null => ctx?.resolve(type) ?? null,
    [ctx],
  );
  return { resolve, version: ctx?.version ?? 0 };
}
