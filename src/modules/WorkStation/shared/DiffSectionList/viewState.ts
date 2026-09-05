/**
 * Pure helpers behind `DiffSectionList`'s restorable view state.
 *
 * The list is unmounted whenever its tab stops being active and rebuilt on
 * the next visit, so the per-row expansion overrides and the scroll offset
 * have to be carried across mounts by the caller (see
 * `@src/store/workstation/tabs/tabViewState`). These helpers turn the
 * list's internal "remembered expansion" map — whose entries are only valid
 * while their `signal` matches the row's current expansion signal — into a
 * signal-free snapshot, and seed a fresh mount's map from such a snapshot.
 */
import type { StateSnapshot } from "react-virtuoso";

export interface RememberedExpansion {
  signal: number;
  expanded: boolean;
}

export interface DiffSectionListViewState {
  /** Per-row expansion overrides, keyed by the row's render key. */
  expanded: Record<string, boolean>;
  /** Virtuoso scroll offset + measured sizes; `null` when never scrolled. */
  scroll: StateSnapshot | null;
  /**
   * Focus nonce whose scroll-into-view already ran. A remount for the same
   * nonce restores the saved scroll instead of jumping back to the focused
   * row; a new nonce scrolls as usual.
   */
  focusNonce: number | null;
}

/**
 * Collect the overrides that are currently in effect. An entry whose signal
 * no longer matches the row's signal was invalidated by a collapse-all (or a
 * focus request) and is dropped rather than resurrected on the next mount.
 */
export function snapshotExpansions(
  remembered: ReadonlyMap<string, RememberedExpansion>,
  signalFor: (renderKey: string) => number | undefined
): Record<string, boolean> {
  const expanded: Record<string, boolean> = {};
  for (const [renderKey, entry] of remembered) {
    if (entry.signal === signalFor(renderKey)) {
      expanded[renderKey] = entry.expanded;
    }
  }
  return expanded;
}

/** Overrides waiting to be re-applied to rows as they first render. */
export function createRestoredExpansions(
  viewState: DiffSectionListViewState | null | undefined
): Map<string, boolean> {
  return new Map(Object.entries(viewState?.expanded ?? {}));
}

/**
 * Re-apply a restored override to `remembered` the first time its row
 * renders, stamping it with that row's live signal so the list treats it
 * exactly like an override the user made in this mount. Returns the
 * override, or `undefined` when the row has none pending.
 */
export function seedRestoredExpansion(
  remembered: Map<string, RememberedExpansion>,
  restored: Map<string, boolean>,
  renderKey: string,
  signal: number
): boolean | undefined {
  if (remembered.has(renderKey)) return undefined;
  const expanded = restored.get(renderKey);
  if (expanded === undefined) return undefined;
  restored.delete(renderKey);
  remembered.set(renderKey, { signal, expanded });
  return expanded;
}

/**
 * Drop pending overrides for rows that left the list. An empty key set means
 * the list has not been populated yet (it mounts empty and fills from an
 * effect), not that every row is gone — nothing is pruned then, or the
 * restored overrides would be wiped before their rows ever render.
 */
export function pruneRestoredExpansions(
  restored: Map<string, boolean>,
  validKeys: ReadonlySet<string>
): void {
  if (validKeys.size === 0) return;
  for (const key of restored.keys()) {
    if (!validKeys.has(key)) restored.delete(key);
  }
}
