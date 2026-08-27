/**
 * SessionCreatorChatPanel — Worktree Selection Hook
 *
 * Extracts the running-location / worktree-launch-selection state and its
 * change handlers from SessionCreatorChatPanel to keep the component file
 * under the 600-line limit.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";

import {
  type WorktreeLaunchSelection,
  resolveWorktreeSelectionRepoKey,
  worktreeLaunchSelectionAtom,
} from "@src/store/session";
import type { SessionSource } from "@src/store/session/creatorStateAtom";
import { runningLocationAtom } from "@src/store/session/runningLocationAtom";

interface UseChatPanelWorktreeSelectionOptions {
  effectiveSource: SessionSource | null;
}

export function useChatPanelWorktreeSelection({
  effectiveSource,
}: UseChatPanelWorktreeSelectionOptions) {
  const runningLocation = useAtomValue(runningLocationAtom);
  const setRunningLocation = useSetAtom(runningLocationAtom);
  const worktreeLaunchSelection = useAtomValue(worktreeLaunchSelectionAtom);
  const setWorktreeLaunchSelection = useSetAtom(worktreeLaunchSelectionAtom);

  const currentWorktreeRepoKey = resolveWorktreeSelectionRepoKey(
    effectiveSource?.repoId,
    effectiveSource?.repoPath
  );
  const activeWorktreeSelection =
    worktreeLaunchSelection?.repoKey === currentWorktreeRepoKey
      ? worktreeLaunchSelection
      : null;
  const clearWorktreeLaunchSelection = useCallback(
    () => setWorktreeLaunchSelection(null),
    [setWorktreeLaunchSelection]
  );

  const handleWorktreeLocationChange = useCallback(
    (location: Parameters<typeof setRunningLocation>[0]) => {
      if (location !== "worktree") {
        setWorktreeLaunchSelection(null);
      }
      setRunningLocation(location);
    },
    [setRunningLocation, setWorktreeLaunchSelection]
  );

  const handleWorktreeSourceSelect = useCallback(
    (selection: WorktreeLaunchSelection) => {
      // A PR-base resolution may finish after the user switches repositories.
      // Ignore that late result before it can overwrite the new repo's branch
      // draft or put the creator back into worktree mode.
      if (
        !currentWorktreeRepoKey ||
        selection.repoKey !== currentWorktreeRepoKey
      ) {
        return;
      }
      setWorktreeLaunchSelection(selection);
      setRunningLocation("worktree");
    },
    [currentWorktreeRepoKey, setRunningLocation, setWorktreeLaunchSelection]
  );

  return {
    runningLocation,
    activeWorktreeSelection,
    clearWorktreeLaunchSelection,
    handleWorktreeLocationChange,
    handleWorktreeSourceSelect,
  };
}
