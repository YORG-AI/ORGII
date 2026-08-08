import type { Store } from "jotai/vanilla/store";
import { useCallback, useRef, useSyncExternalStore } from "react";

interface OwnershipEntry {
  claims: Set<string>;
  owners: symbol[];
  listeners: Map<symbol, () => void>;
}

let entriesByStore = new WeakMap<Store, Map<string, OwnershipEntry>>();

function entriesFor(store: Store): Map<string, OwnershipEntry> {
  let entries = entriesByStore.get(store);
  if (!entries) {
    entries = new Map();
    entriesByStore.set(store, entries);
  }
  return entries;
}

function notify(entry: OwnershipEntry): void {
  for (const listener of entry.listeners.values()) listener();
}

export function retainWorkItemOrchestratorOwnership(
  store: Store,
  key: string,
  owner: symbol,
  listener: () => void
): () => void {
  const entries = entriesFor(store);
  let entry = entries.get(key);
  if (!entry) {
    entry = { claims: new Set(), owners: [], listeners: new Map() };
    entries.set(key, entry);
  }
  if (!entry.owners.includes(owner)) entry.owners.push(owner);
  entry.listeners.set(owner, listener);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = entries.get(key);
    if (!current) return;
    current.owners = current.owners.filter((candidate) => candidate !== owner);
    current.listeners.delete(owner);
    if (current.owners.length === 0) {
      entries.delete(key);
      if (entries.size === 0) entriesByStore.delete(store);
      return;
    }
    notify(current);
  };
}

export function isWorkItemOrchestratorOwner(
  store: Store,
  key: string,
  owner: symbol
): boolean {
  return entriesByStore.get(store)?.get(key)?.owners[0] === owner;
}

export function getWorkItemOrchestratorOwnershipCount(store: Store): number {
  return entriesByStore.get(store)?.size ?? 0;
}

export function claimWorkItemOrchestratorAction(
  store: Store,
  key: string,
  action: string
): boolean {
  const entry = entriesByStore.get(store)?.get(key);
  if (!entry || entry.claims.has(action)) return false;
  entry.claims.add(action);
  return true;
}

export function releaseWorkItemOrchestratorAction(
  store: Store,
  key: string,
  action: string
): void {
  entriesByStore.get(store)?.get(key)?.claims.delete(action);
}

export function resetWorkItemOrchestratorOwnership(): void {
  entriesByStore = new WeakMap<Store, Map<string, OwnershipEntry>>();
}

export function useWorkItemOrchestratorOwnership(
  store: Store,
  key: string | null
): boolean {
  const ownerRef = useRef(Symbol("work-item-orchestrator-owner"));
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => undefined;
      return retainWorkItemOrchestratorOwnership(
        store,
        key,
        ownerRef.current,
        listener
      );
    },
    [key, store]
  );
  const getSnapshot = useCallback(
    () =>
      key ? isWorkItemOrchestratorOwner(store, key, ownerRef.current) : false,
    [key, store]
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
