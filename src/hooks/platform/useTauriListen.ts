/**
 * useTauriListen / useTauriListenMany
 *
 * Race-safe wrappers around `@tauri-apps/api/event#listen`.
 *
 * The naive pattern of `await listen(...)` inside an effect can leak
 * subscriptions when cleanup runs before the await resolves (React 18
 * StrictMode, fast unmount, deps churn). `AsyncUnlistenScope` immediately
 * invokes any handle that resolves after cleanup and rolls back partial
 * multi-listener setup.
 */
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

import { AsyncUnlistenScope } from "@src/util/platform/tauri/asyncUnlistenScope";

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

    const listenerScope = new AsyncUnlistenScope();

    void listenerScope
      .register(() =>
        listen<T>(event, (e) => {
          if (!listenerScope.isDisposed) {
            handlerRef.current(e.payload);
          }
        })
      )
      .catch(() => undefined);

    return () => {
      listenerScope.dispose();
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

    const listenerScope = new AsyncUnlistenScope();

    void listenerScope
      .registerAll(
        active.map(
          (reg) => () =>
            listen<unknown>(reg.event, (e) => {
              if (listenerScope.isDisposed) return;
              const idx = registrationsRef.current.findIndex(
                (candidate) => candidate?.event === reg.event
              );
              const current =
                idx >= 0 ? registrationsRef.current[idx] : undefined;
              current?.handler(e.payload);
            })
        )
      )
      .catch(() => undefined);

    return () => {
      listenerScope.dispose();
    };
  }, [eventKey, enabled]);
}
