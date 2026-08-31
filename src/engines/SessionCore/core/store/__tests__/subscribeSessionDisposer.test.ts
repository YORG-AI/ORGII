import { describe, expect, it, vi } from "vitest";

import type { SessionListener } from "../EventStoreProxyTypes";
import { SnapshotCacheManager } from "../snapshotCacheManager";

type ListenerRegistry = Map<string, Set<SessionListener>>;

function registryOf(manager: SnapshotCacheManager): ListenerRegistry {
  return (manager as unknown as { _sessionListeners: ListenerRegistry })
    ._sessionListeners;
}

/**
 * Regression: the unsubscribe returned by `subscribeSession` used to close
 * over the Set it was created with and delete the registry entry whenever
 * *that* Set became empty. After `evictSessionCache` (which drops the entry)
 * a later subscriber installs a fresh Set; the stale disposer then silently
 * unregistered the live Set, so still-mounted consumers stopped receiving
 * pushes and kept their last snapshot forever.
 */
describe("SnapshotCacheManager.subscribeSession disposer", () => {
  it("does not unregister a newer live Set after evictSessionCache", () => {
    const manager = new SnapshotCacheManager(vi.fn());
    const registry = registryOf(manager);

    const first = vi.fn();
    const disposeFirst = manager.subscribeSession("s1", first);
    const firstSet = registry.get("s1");
    expect(firstSet?.has(first)).toBe(true);

    manager.evictSessionCache("s1");
    expect(registry.has("s1")).toBe(false);

    const second = vi.fn();
    const disposeSecond = manager.subscribeSession("s1", second);
    const secondSet = registry.get("s1");
    expect(secondSet).not.toBe(firstSet);
    expect(secondSet?.has(second)).toBe(true);

    // Stale disposer from before the eviction fires (e.g. old consumer
    // unmounts). It must not touch the new registration.
    disposeFirst();
    expect(registry.get("s1")).toBe(secondSet);
    expect(secondSet?.has(second)).toBe(true);

    disposeSecond();
    expect(registry.has("s1")).toBe(false);
  });

  it("removes the registry entry when the last live subscriber leaves", () => {
    const manager = new SnapshotCacheManager(vi.fn());
    const registry = registryOf(manager);
    const a = manager.subscribeSession("s2", vi.fn());
    const b = manager.subscribeSession("s2", vi.fn());
    a();
    expect(registry.has("s2")).toBe(true);
    b();
    expect(registry.has("s2")).toBe(false);
  });
});
