/**
 * useTauriListen
 *
 * Race-safe wrappers around `@tauri-apps/api/event#listen`.
 *
 * The naive pattern of `await listen(...)` inside an effect can leak
 * subscriptions when cleanup runs before the await resolves (React 18
 * StrictMode, fast unmount, deps churn). We track a `cancelled` flag and,
 * if cancelled before resolution, immediately invoke the returned
 * `unlisten()` so no listener stays registered.
 */
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

interface UseTauriListenOptions {
  enabled?: boolean;
}

export function useTauriListen<T = unknown>(
  event: string | null | undefined,
  handler: (payload: T) => void,
  options?: UseTauriListenOptions
): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  const enabled = options?.enabled !== false;

  useEffect(() => {
    if (!enabled || !event) return;

    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    (async () => {
      const fn = await listen<T>(event, (e) => {
        handlerRef.current(e.payload);
      });
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [event, enabled]);
}
