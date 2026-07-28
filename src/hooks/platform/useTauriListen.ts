/**
 * useTauriListen / useTauriListenMany
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

export interface TauriListenRegistration {
  event: string;
  handler: (payload: unknown) => void;
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

export function useTauriListenMany(
  registrations: Array<TauriListenRegistration | null | undefined>,
  options?: UseTauriListenOptions
): void {
  const registrationsRef = useRef(registrations);
  useEffect(() => {
    registrationsRef.current = registrations;
  }, [registrations]);

  const enabled = options?.enabled !== false;

  // Stable signature: only re-subscribe when the set of event names changes.
  const eventKey = registrations.map((r) => (r ? r.event : "")).join("\u0000");

  useEffect(() => {
    if (!enabled) return;

    const active = registrationsRef.current.filter(
      (r): r is TauriListenRegistration => Boolean(r && r.event)
    );
    if (active.length === 0) return;

    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    (async () => {
      for (const reg of active) {
        const fn = await listen<unknown>(reg.event, (e) => {
          const idx = registrationsRef.current.findIndex(
            (r) => r?.event === reg.event
          );
          const current = idx >= 0 ? registrationsRef.current[idx] : undefined;
          current?.handler(e.payload);
        });
        if (cancelled) {
          fn();
          return;
        }
        unlisteners.push(fn);
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [eventKey, enabled]);
}
