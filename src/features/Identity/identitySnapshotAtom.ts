import { atom, getDefaultStore } from "jotai";

import {
  type IdentitySnapshot,
  createEmptyIdentitySnapshot,
} from "./identityTypes";

const writableIdentitySnapshotAtom = atom<IdentitySnapshot>(
  createEmptyIdentitySnapshot()
);
const snapshotWillChangeListeners = new Set<
  (current: IdentitySnapshot, next: IdentitySnapshot) => void
>();
const snapshotListeners = new Set<(snapshot: IdentitySnapshot) => void>();

/** Read-only renderer mirror of the native Broker's public snapshot. */
export const identitySnapshotAtom = atom((get) =>
  get(writableIdentitySnapshotAtom)
);
identitySnapshotAtom.debugLabel = "identitySnapshotAtom";

export function readIdentitySnapshot(): IdentitySnapshot {
  return getDefaultStore().get(writableIdentitySnapshotAtom);
}

/** Broker adapters are the only callers allowed to replace the mirror. */
export function replaceIdentitySnapshot(next: IdentitySnapshot): boolean {
  const store = getDefaultStore();
  const current = store.get(writableIdentitySnapshotAtom);
  if (next.revision < current.revision) return false;
  for (const listener of snapshotWillChangeListeners) listener(current, next);
  store.set(writableIdentitySnapshotAtom, next);
  for (const listener of snapshotListeners) listener(next);
  return true;
}

/**
 * Run synchronous identity-scoped cache invalidation before a newer public
 * identity becomes visible to projection consumers.
 */
export function subscribeIdentitySnapshotWillChange(
  listener: (current: IdentitySnapshot, next: IdentitySnapshot) => void
): () => void {
  snapshotWillChangeListeners.add(listener);
  return () => snapshotWillChangeListeners.delete(listener);
}

/** Register a synchronous projection adapter for accepted Broker snapshots. */
export function subscribeIdentitySnapshotChanges(
  listener: (snapshot: IdentitySnapshot) => void
): () => void {
  snapshotListeners.add(listener);
  listener(readIdentitySnapshot());
  return () => snapshotListeners.delete(listener);
}
