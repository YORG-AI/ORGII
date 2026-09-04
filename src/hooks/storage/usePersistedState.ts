/**
 * usePersistedState — localStorage-backed state with useSyncExternalStore.
 *
 * Inspired by Mux's usePersistedState pattern. Provides:
 * - Tear-free reads via useSyncExternalStore (no flash of default values)
 * - Cross-component sync via internal subscriber registry
 * - Cross-tab sync via StorageEvent (opt-in via { listener: true })
 * - Referential stability: same JSON string → same parsed object
 *
 * Usage:
 *   const [theme, setTheme] = usePersistedState("theme", "dark");
 *   const [config, setConfig] = usePersistedState("config", defaultConfig, { listener: true });
 */
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useId,
  useRef,
  useSyncExternalStore,
} from "react";

import { createLogger } from "@src/hooks/logger";

const log = createLogger("usePersistedState");

// ============================================================================
// Internal subscriber registry
// ============================================================================

interface Subscriber {
  callback: () => void;
  componentId: string;
  listener: boolean;
}

const subscribersByKey = new Map<string, Set<Subscriber>>();

function addSubscriber(key: string, subscriber: Subscriber): () => void {
  const subs = subscribersByKey.get(key) ?? new Set<Subscriber>();
  subs.add(subscriber);
  subscribersByKey.set(key, subs);

  return () => {
    const current = subscribersByKey.get(key);
    if (!current) return;
    current.delete(subscriber);
    if (current.size === 0) {
      subscribersByKey.delete(key);
    }
  };
}

function notifySubscribers(key: string, origin?: string): void {
  const subs = subscribersByKey.get(key);
  if (!subs) return;

  for (const sub of subs) {
    if (!sub.listener && (!origin || origin !== sub.componentId)) continue;
    sub.callback();
  }
}

// ============================================================================
// Cross-tab StorageEvent listener (installed once)
// ============================================================================

let storageListenerInstalled = false;

function ensureStorageListener(): void {
  if (storageListenerInstalled || typeof window === "undefined") return;
  storageListenerInstalled = true;

  window.addEventListener("storage", (event: StorageEvent) => {
    if (!event.key) return;
    notifySubscribers(event.key);
  });
}

// ============================================================================
// Custom event name for same-tab non-hook listeners
// ============================================================================

function getStorageChangeEvent(key: string): string {
  return `storage-change:${key}`;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Read a persisted value from localStorage (non-hook).
 * Safe to call in callbacks, event handlers, initializers, etc.
 */
function readPersistedState<T>(key: string, defaultValue: T): T {
  if (typeof window === "undefined" || !window.localStorage) {
    return defaultValue;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null || raw === "undefined") return defaultValue;
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

// ============================================================================
// Hook
// ============================================================================

interface UsePersistedStateOptions {
  /** Enable listening to changes from other components/tabs (default: false) */
  listener?: boolean;
}

/**
 * Persist state to localStorage with automatic cross-component synchronization.
 *
 * @param key       Unique localStorage key
 * @param initialValue  Default value when key is absent or unparseable
 * @param options   { listener: true } to receive updates from other hook instances
 * @returns [state, setState] — same API as useState
 */
export function usePersistedState<T>(
  key: string,
  initialValue: T,
  options?: UsePersistedStateOptions
): [T, Dispatch<SetStateAction<T>>] {
  const componentId = useId();
  const initialValueRef = useRef(initialValue);

  ensureStorageListener();

  // Referential stability cache: avoid re-parsing identical JSON
  const snapshotRef = useRef<{
    key: string;
    raw: string | null;
    value: T;
  } | null>(null);

  const subscribe = useCallback(
    (callback: () => void) => {
      return addSubscriber(key, {
        callback,
        componentId,
        listener: Boolean(options?.listener),
      });
    },
    [key, options?.listener, componentId]
  );

  const getSnapshot = useCallback((): T => {
    if (typeof window === "undefined" || !window.localStorage) {
      return initialValueRef.current;
    }

    try {
      const raw = window.localStorage.getItem(key);

      if (raw === null || raw === "undefined") {
        if (
          snapshotRef.current?.key === key &&
          snapshotRef.current.raw === null
        ) {
          return snapshotRef.current.value;
        }
        snapshotRef.current = {
          key,
          raw: null,
          value: initialValueRef.current,
        };
        return initialValueRef.current;
      }

      if (snapshotRef.current?.key === key && snapshotRef.current.raw === raw) {
        return snapshotRef.current.value;
      }

      const parsed = JSON.parse(raw) as T;
      snapshotRef.current = { key, raw, value: parsed };
      return parsed;
    } catch {
      return initialValueRef.current;
    }
  }, [key]);

  const getServerSnapshot = useCallback(() => initialValueRef.current, []);

  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setState = useCallback(
    (value: SetStateAction<T>) => {
      if (typeof window === "undefined" || !window.localStorage) return;

      try {
        const prevState = readPersistedState<T>(key, initialValueRef.current);
        const newValue =
          typeof value === "function"
            ? (value as (prev: T) => T)(prevState)
            : value;

        if (newValue === undefined || newValue === null) {
          window.localStorage.removeItem(key);
        } else {
          window.localStorage.setItem(key, JSON.stringify(newValue));
        }

        notifySubscribers(key, componentId);

        window.dispatchEvent(
          new CustomEvent(getStorageChangeEvent(key), {
            detail: { key, newValue, origin: componentId },
          })
        );
      } catch (error) {
        log.warn(`Failed to write "${key}":`, error);
      }
    },
    [key, componentId]
  );

  return [state, setState];
}
