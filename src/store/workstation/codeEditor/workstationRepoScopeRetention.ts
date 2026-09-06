import { BoundedMap } from "@src/util/collections/BoundedMap";

import {
  workstationIssueCallbackAtomFamily,
  workstationIssueListAtomFamily,
} from "./workstationIssueAtom";
import {
  workstationAllClosedPrsAtomFamily,
  workstationAllOpenPrsAtomFamily,
  workstationClosedPrsErrorAtomFamily,
  workstationClosedPrsLoadStateAtomFamily,
  workstationOpenPrsErrorAtomFamily,
  workstationOpenPrsLoadStateAtomFamily,
  workstationPrAtomFamily,
  workstationPrCallbackAtomFamily,
} from "./workstationPrAtom";

/**
 * How many repo scopes with no mounted consumer keep their PR / issue list
 * atoms warm.
 *
 * The repo-scoped families (`workstationPrAtom`, the open/closed PR lists and
 * their load states, the issue list, the callback atoms) are keyed by repo
 * scope and `jotai-family` pins every key forever, so every repository ever
 * opened in a workstation kept its full PR and issue lists for the app
 * lifetime. Releasing on unmount alone would be wrong: the main pane renders
 * one repo at a time, so switching repos unmounts the consumers, and dropping
 * the scope there would show a loading state on every switch back. A warm
 * window keeps recently used repos instant and only forgets the ones the user
 * has moved well past; those are re-seeded from the persisted PR cache and
 * refetched when they are opened again.
 *
 * Deliberately not released: `workstationPrCommitMessageAtomFamily` mirrors
 * the commit summary the user typed in Source Control, which is user input.
 */
export const MAX_WARM_RELEASED_REPO_SCOPES = 8;

/** Mounted consumers per scope; a scope here is never evicted. */
const mountedScopes = new Map<string, number>();

const warmScopes = new BoundedMap<string, true>({
  maxSize: MAX_WARM_RELEASED_REPO_SCOPES,
  name: "workstationRepoScopes",
  onEvict: (scopeKey) => {
    releaseWorkstationRepoScopeAtoms(scopeKey);
  },
});

/** Drop every repo-scoped list atom for `scopeKey`. */
export function releaseWorkstationRepoScopeAtoms(scopeKey: string): void {
  workstationPrAtomFamily.remove(scopeKey);
  workstationAllOpenPrsAtomFamily.remove(scopeKey);
  workstationAllClosedPrsAtomFamily.remove(scopeKey);
  workstationOpenPrsLoadStateAtomFamily.remove(scopeKey);
  workstationOpenPrsErrorAtomFamily.remove(scopeKey);
  workstationClosedPrsLoadStateAtomFamily.remove(scopeKey);
  workstationClosedPrsErrorAtomFamily.remove(scopeKey);
  workstationPrCallbackAtomFamily.remove(scopeKey);
  workstationIssueListAtomFamily.remove(scopeKey);
  workstationIssueCallbackAtomFamily.remove(scopeKey);
}

/**
 * Mark a repo scope as having a mounted consumer. Returns the matching
 * release; the final release parks the scope in the warm window, from which
 * the least recently released scope is evicted once the window is full.
 * Designed to be returned straight from a `useEffect`.
 */
export function retainWorkstationRepoScope(scopeKey: string): () => void {
  warmScopes.delete(scopeKey);
  mountedScopes.set(scopeKey, (mountedScopes.get(scopeKey) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (mountedScopes.get(scopeKey) ?? 1) - 1;
    if (remaining > 0) {
      mountedScopes.set(scopeKey, remaining);
      return;
    }
    mountedScopes.delete(scopeKey);
    warmScopes.set(scopeKey, true);
  };
}

/** Diagnostics for the RAM monitor and tests. */
export function getWorkstationRepoScopeRetentionStats(): {
  mounted: number;
  warm: number;
} {
  return { mounted: mountedScopes.size, warm: warmScopes.size };
}

/** Test-only: forget every mounted and warm scope without evicting atoms. */
export function __resetWorkstationRepoScopeRetention(): void {
  mountedScopes.clear();
  warmScopes.clear();
}
