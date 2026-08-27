interface WeakReferenceLike<T extends object> {
  deref(): T | undefined;
}

type WeakReferenceConstructorLike = new <T extends object>(
  target: T
) => WeakReferenceLike<T>;

interface FinalizationRegistryLike<HeldValue> {
  register(target: object, heldValue: HeldValue): void;
}

type FinalizationRegistryConstructorLike = new <HeldValue>(
  cleanup: (heldValue: HeldValue) => void
) => FinalizationRegistryLike<HeldValue>;

interface WeakCacheEntry<T extends object> {
  reference: WeakReferenceLike<T>;
  token: number;
}

interface FinalizedCacheEntry {
  key: string;
  token: number;
}

export interface StableWeakLruCache<T extends object> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

/**
 * Bounded strong LRU with a weak identity tier.
 *
 * The strong tier bounds retained hot values. Values evicted from that tier
 * keep their identity for as long as another owner still references them;
 * once the last owner releases one, the weak entry is finalized too. This is
 * intended for keyed React/Jotai objects whose identity must not change while
 * mounted merely because more keys were visited.
 */
export function createStableWeakLruCache<T extends object>(
  maxStrongEntries: number
): StableWeakLruCache<T> {
  if (!Number.isInteger(maxStrongEntries) || maxStrongEntries < 1) {
    throw new Error("maxStrongEntries must be a positive integer");
  }

  const weakReferenceConstructor = (
    globalThis as typeof globalThis & {
      WeakRef?: WeakReferenceConstructorLike;
    }
  ).WeakRef;
  const finalizationRegistryConstructor = (
    globalThis as typeof globalThis & {
      FinalizationRegistry?: FinalizationRegistryConstructorLike;
    }
  ).FinalizationRegistry;
  const strongCache = new Map<string, T>();
  const weakCache = new Map<string, WeakCacheEntry<T>>();
  let weakToken = 0;

  const finalizationRegistry = finalizationRegistryConstructor
    ? new finalizationRegistryConstructor<FinalizedCacheEntry>(
        ({ key, token }) => {
          if (weakCache.get(key)?.token === token) {
            weakCache.delete(key);
          }
        }
      )
    : null;

  const retain = (key: string, value: T): void => {
    strongCache.delete(key);
    strongCache.set(key, value);

    while (strongCache.size > maxStrongEntries) {
      const lruKey = strongCache.keys().next().value;
      if (lruKey === undefined) break;
      strongCache.delete(lruKey);
    }
  };

  return {
    get(key) {
      const stronglyCached = strongCache.get(key);
      if (stronglyCached) {
        retain(key, stronglyCached);
        return stronglyCached;
      }

      const weaklyCached = weakCache.get(key);
      const liveWeakValue = weaklyCached?.reference.deref();
      if (liveWeakValue) {
        retain(key, liveWeakValue);
        return liveWeakValue;
      }
      if (weaklyCached) weakCache.delete(key);
      return undefined;
    },
    set(key, value) {
      const token = ++weakToken;
      const reference = weakReferenceConstructor
        ? new weakReferenceConstructor(value)
        : // WeakRef is present in every supported Tauri WebView. Preserve
          // identity on an older host rather than reverting to unsafe live
          // eviction; the strong tier remains bounded either way.
          { deref: () => value };

      weakCache.set(key, { reference, token });
      finalizationRegistry?.register(value, { key, token });
      retain(key, value);
    },
  };
}
