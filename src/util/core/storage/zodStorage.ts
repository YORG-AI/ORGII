import { z } from "zod/v4";

import {
  removeBrowserStorageItemSafely,
  setBrowserStorageItemWithRecovery,
} from "./quotaRecovery";

/**
 * Record schema that parses every entry independently and DROPS invalid
 * entries instead of failing the whole record. `createZodJsonStorage`
 * answers a failed whole-store parse with the initial value, so for a
 * record-shaped store one corrupted entry (disk damage, or a future
 * entry shape rolled back onto this build) would otherwise reset EVERY
 * entry at load — for cloud push state that scale of loss converts into
 * fleet-wide re-anchors or retracts. Losing one entry is the designed,
 * self-healing recovery; losing the store is an incident.
 */
export function tolerantRecordSchema<V>(
  label: string,
  valueSchema: z.ZodType<V>
) {
  return z.record(z.string(), z.unknown()).transform((entries) => {
    const valid: Record<string, V> = {};
    for (const [key, value] of Object.entries(entries)) {
      const parsed = valueSchema.safeParse(value);
      if (parsed.success) {
        valid[key] = parsed.data;
      } else {
        // Once per storage load per bad entry — no rate limit needed.
        console.warn(`[zodStorage] dropped invalid ${label} entry "${key}"`);
      }
    }
    return valid;
  });
}

export interface ZodSyncStorage<T> {
  getItem: (key: string, initialValue: T) => T;
  setItem: (key: string, value: T) => void;
  removeItem: (key: string) => void;
  /**
   * Cross-window resync via the `storage` event (fires in every OTHER
   * window sharing the origin). Without this, jotai's atomWithStorage
   * hydrates once per window and every whole-list write clobbers changes
   * made elsewhere (last-writer-wins data loss for multi-row stores).
   */
  subscribe: (
    key: string,
    callback: (value: T) => void,
    initialValue: T
  ) => () => void;
}

export interface ZodStorageOptions<T> {
  onInvalid?: (key: string, rawValue: string, error: unknown) => void;
  writeDefaultOnInvalid?: boolean;
  /**
   * Called when persisting fails (quota exceeded, storage unavailable).
   * Default logs a warning — a failed write must degrade to
   * in-memory-only state, never throw through the caller's write path.
   */
  onWriteError?: (key: string, error: unknown) => void;
  serialize?: (value: T) => string;
  deserialize?: (rawValue: string) => unknown;
}

const defaultDeserialize = (rawValue: string): unknown => JSON.parse(rawValue);
const defaultSerialize = <T>(value: T): string => JSON.stringify(value);

export function createZodJsonStorage<T>(
  schema: z.ZodType<T>,
  options: ZodStorageOptions<T> = {}
): ZodSyncStorage<T> {
  const deserialize = options.deserialize ?? defaultDeserialize;
  const serialize = options.serialize ?? defaultSerialize;
  const onWriteError =
    options.onWriteError ??
    ((key: string, error: unknown) => {
      console.warn(`[zodStorage] persist failed for "${key}"`, error);
    });

  const parseRaw = (key: string, rawValue: string, initialValue: T): T => {
    try {
      return schema.parse(deserialize(rawValue));
    } catch (error) {
      options.onInvalid?.(key, rawValue, error);
      return initialValue;
    }
  };

  return {
    getItem: (key, initialValue) => {
      let rawValue: string | null;
      try {
        rawValue = localStorage.getItem(key);
      } catch {
        return initialValue;
      }
      if (rawValue === null) return initialValue;

      try {
        return schema.parse(deserialize(rawValue));
      } catch (error) {
        options.onInvalid?.(key, rawValue, error);
        if (options.writeDefaultOnInvalid) {
          const writeResult = setBrowserStorageItemWithRecovery(
            key,
            serialize(initialValue)
          );
          if (!writeResult.persisted) {
            onWriteError(key, writeResult.error);
          }
        }
        return initialValue;
      }
    },
    setItem: (key, value) => {
      try {
        const result = setBrowserStorageItemWithRecovery(key, serialize(value));
        if (!result.persisted) onWriteError(key, result.error);
      } catch (error) {
        onWriteError(key, error);
      }
    },
    removeItem: (key) => {
      if (!removeBrowserStorageItemSafely(key)) {
        onWriteError(key, new Error("Failed to remove localStorage item"));
      }
    },
    subscribe: (key, callback, initialValue) => {
      if (typeof window === "undefined") return () => {};
      const handler = (event: StorageEvent) => {
        if (event.storageArea !== localStorage || event.key !== key) return;
        if (event.newValue === null) {
          callback(initialValue);
          return;
        }
        callback(parseRaw(key, event.newValue, initialValue));
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
  };
}
