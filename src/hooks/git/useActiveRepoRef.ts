/**
 * useActiveRepoRef
 *
 * Resolves the currently displayed workspace repo to a `{ repoId, repoPath }`
 * pair — but only when the selected repo actually matches the active workspace
 * root, mirroring the gating the editor status bar uses for its git operations.
 *
 * Both fields are `undefined` when there's no confident match, so callers can
 * skip repo-scoped fetches instead of querying the wrong repo. Handy for
 * surfaces outside the status bar (e.g. the tab-bar `+` menu) that want the
 * active repo without re-deriving the match rules.
 */
import { useAtomValue } from "jotai";

import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace/derived";

export interface ActiveRepoRef {
  repoId: string | undefined;
  repoPath: string | undefined;
}

export function useActiveRepoRef(): ActiveRepoRef {
  const repoPath = useAtomValue(activeWorkspaceRootPathAtom);
  const { selectedRepoId, currentRepo } = useRepoSelection({ autoLoad: false });

  const selectedRepoPath = currentRepo?.path || currentRepo?.fs_uri;
  const matchedPath =
    selectedRepoPath && selectedRepoPath === repoPath
      ? selectedRepoPath
      : undefined;
  const matchedId = matchedPath ? selectedRepoId || undefined : undefined;

  return { repoId: matchedId, repoPath: matchedPath };
}
