import type { Store } from "jotai/vanilla/store";

import { LRUCache } from "./lruCache";

/**
 * Small retained snapshots that belong to a rendered Jotai store.
 *
 * The WeakMap prevents data from crossing app/test stores and lets an entire
 * store be collected without an explicit teardown path. Each store's cache is
 * independently bounded and optionally expires entries on read.
 */
export class StoreScopedSnapshotCache<K, V> {
  private stores = new WeakMap<Store, LRUCache<K, V>>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs?: number
  ) {}

  get(store: Store, key: K): V | undefined {
    return this.stores.get(store)?.get(key);
  }

  set(store: Store, key: K, value: V): void {
    let cache = this.stores.get(store);
    if (!cache) {
      cache = new LRUCache<K, V>(this.maxEntries, this.ttlMs);
      this.stores.set(store, cache);
    }
    cache.set(key, value);
  }

  delete(store: Store, key: K): boolean {
    return this.stores.get(store)?.delete(key) ?? false;
  }

  clear(store?: Store): void {
    if (store) {
      this.stores.delete(store);
      return;
    }
    this.stores = new WeakMap<Store, LRUCache<K, V>>();
  }
}
