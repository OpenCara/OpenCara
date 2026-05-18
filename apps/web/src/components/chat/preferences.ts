// Chat panel per-user preferences. Browser-local today (localStorage);
// crosses devices only when the user pins them via a future server-side
// settings table. We keep the store deliberately tiny — only knobs that
// don't fit anywhere else in the existing chat_sessions row.
//
// `useSyncExternalStore` is used so all open panels (and all bubbles
// within one panel) re-render in lockstep when the user flips a
// preference. A naive `useState` per consumer would let bubbles drift
// out of sync after a toggle until the next re-render arrived.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "opencara.chat.showThinking";
const listeners = new Set<() => void>();

function readShowThinking(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeShowThinking(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // SSR / private-mode / disabled storage — preference is in-memory only.
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) fn();
}

export function useShowThinking(): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    readShowThinking,
    () => false,
  );
  const set = (next: boolean) => {
    writeShowThinking(next);
    notify();
  };
  return [value, set];
}
