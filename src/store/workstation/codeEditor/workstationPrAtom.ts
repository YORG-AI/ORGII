import { atom } from "jotai";
import { atomFamily } from "jotai-family";

import type { OpenPRItem } from "@src/api/tauri/github";

export const DEFAULT_WORKSTATION_REPO_SCOPE = "default";

export function workstationRepoScopeKey(
  repoId: string | null | undefined,
  repoPath: string | null | undefined
): string {
  const id = repoId?.trim();
  if (id) return `repo:${id}`;
  const path = repoPath?.trim();
  return path ? `path:${path}` : DEFAULT_WORKSTATION_REPO_SCOPE;
}

/**
 * Shared PR state for the active workstation repo.
 * Written by `useWorkstationPr` when eligibility or PR URL changes.
 * Read by Source Control surfaces and context collection.
 */
export interface WorkstationPrSnapshot {
  /** The branch is eligible for PR creation (not default, pushed, clean) */
  readyToCreate: boolean;
  /** Existing PR URL if one has already been created/found */
  prUrl?: string;
  /** PR is currently being created */
  isCreating: boolean;
  /** Current branch has an upstream set on origin */
  hasUpstream: boolean;
  /** Number of uncommitted changes in the working tree */
  uncommittedCount: number;
  /** Current branch equals the repo default branch */
  isDefaultBranch: boolean;
}

const initialWorkstationPrSnapshot: WorkstationPrSnapshot = {
  readyToCreate: false,
  prUrl: undefined,
  isCreating: false,
  hasUpstream: false,
  uncommittedCount: 0,
  isDefaultBranch: false,
};

export const workstationPrAtomFamily = atomFamily((scopeKey: string) => {
  const scopedAtom = atom<WorkstationPrSnapshot>({
    ...initialWorkstationPrSnapshot,
  });
  scopedAtom.debugLabel = `workstationPrAtom(${scopeKey})`;
  return scopedAtom;
});

/**
 * Latest Source Control commit message for the active workstation repo.
 *
 * `useWorkstationPr` is mounted once at the editor level (see
 * `useSourceControlSetup`) where the commit form — and therefore the commit
 * message — is not in scope. The Source Control panel publishes its commit
 * summary here so the single PR mount can derive a meaningful PR title from
 * it. Empty when no Source Control panel is mounted, in which case the PR
 * title falls back to the branch name.
 */
export const workstationPrCommitMessageAtomFamily = atomFamily(
  (scopeKey: string) => {
    const scopedAtom = atom<string>("");
    scopedAtom.debugLabel = `workstationPrCommitMessageAtom(${scopeKey})`;
    return scopedAtom;
  }
);
/**
 * All open pull requests for the active workstation repo.
 * Written by `useWorkstationPr` when the PR page requests the list.
 * Read by `PullRequestContent` to render the full PR list.
 */
export const workstationAllOpenPrsAtomFamily = atomFamily(
  (scopeKey: string) => {
    const scopedAtom = atom<OpenPRItem[]>([]);
    scopedAtom.debugLabel = `workstationAllOpenPrsAtom(${scopeKey})`;
    return scopedAtom;
  }
);
/** Closed pull requests, loaded lazily when the CLOSED section is expanded. */
export const workstationAllClosedPrsAtomFamily = atomFamily(
  (scopeKey: string) => {
    const scopedAtom = atom<OpenPRItem[]>([]);
    scopedAtom.debugLabel = `workstationAllClosedPrsAtom(${scopeKey})`;
    return scopedAtom;
  }
);
/**
 * Load lifecycle for `workstationAllOpenPrsAtom`. Lets the PR sidebar
 * distinguish "still fetching" from "truly empty" / "failed to fetch".
 *   - "idle"    : not yet attempted (no repo selected)
 *   - "loading" : in-flight request OR seeded from stale cache while refreshing
 *   - "ready"   : last fetch succeeded (list may be empty)
 *   - "error"   : last fetch threw (error message in `workstationOpenPrsErrorAtom`)
 */
export type WorkstationOpenPrsLoadState =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export const workstationOpenPrsLoadStateAtomFamily = atomFamily(
  (scopeKey: string) => {
    const scopedAtom = atom<WorkstationOpenPrsLoadState>("idle");
    scopedAtom.debugLabel = `workstationOpenPrsLoadStateAtom(${scopeKey})`;
    return scopedAtom;
  }
);
export const workstationOpenPrsErrorAtomFamily = atomFamily(
  (scopeKey: string) => {
    const scopedAtom = atom<string | null>(null);
    scopedAtom.debugLabel = `workstationOpenPrsErrorAtom(${scopeKey})`;
    return scopedAtom;
  }
);
export const workstationClosedPrsLoadStateAtomFamily = atomFamily(
  (scopeKey: string) => {
    const scopedAtom = atom<WorkstationOpenPrsLoadState>("idle");
    scopedAtom.debugLabel = `workstationClosedPrsLoadStateAtom(${scopeKey})`;
    return scopedAtom;
  }
);
export const workstationClosedPrsErrorAtomFamily = atomFamily(
  (scopeKey: string) => {
    const scopedAtom = atom<string | null>(null);
    scopedAtom.debugLabel = `workstationClosedPrsErrorAtom(${scopeKey})`;
    return scopedAtom;
  }
);
/**
 * Stable ref-backed callback for triggering PR creation from Source Control UI.
 * Stored as a ref container to avoid stale closure issues with atom-stored functions.
 */
type WorkstationPrCallbacks = {
  createPr: (() => Promise<{ url?: string; error?: string }>) | null;
  loadOpenPrs: ((force?: boolean) => void) | null;
  loadClosedPrs: ((force?: boolean) => void) | null;
  /** Force a re-fetch of the visible PR lists (sidebar header refresh). */
  refreshPrs: (() => void) | null;
};

export const workstationPrCallbackAtomFamily = atomFamily(
  (scopeKey: string) => {
    const scopedAtom = atom<WorkstationPrCallbacks>({
      createPr: null,
      loadOpenPrs: null,
      loadClosedPrs: null,
      refreshPrs: null,
    });
    scopedAtom.debugLabel = `workstationPrCallbackAtom(${scopeKey})`;
    return scopedAtom;
  }
);
