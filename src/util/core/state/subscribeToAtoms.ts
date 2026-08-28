import type { Atom } from "jotai";

/** Minimal store surface for multi-atom subscriptions. */
export type AtomSubscribableStore = {
  sub: <Value>(atom: Atom<Value>, listener: () => void) => () => void;
};

/**
 * Subscribe `listener` to every atom in `atoms`.
 *
 * Returns one disposer that unsubscribes from all of them — the common
 * "subscribe in useEffect, loop-unsubscribe on cleanup" pattern.
 */
export function subscribeToAtoms(
  store: AtomSubscribableStore,
  atoms: readonly Atom<unknown>[],
  listener: () => void
): () => void {
  const unsubscribers = atoms.map((atom) => store.sub(atom, listener));
  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}
