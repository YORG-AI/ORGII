/**
 * SessionCreatorChatPanel — Branch Sync Hook
 *
 * Extracts the two small effects that keep the session-scoped branch draft
 * aligned with the checked-out branch, and trigger the branch-list load for
 * the selected repo, from SessionCreatorChatPanel to keep the component file
 * under the 600-line limit.
 */
import { useSetAtom } from "jotai";
import { useEffect } from "react";

import { REPO_KIND, type RepoKind } from "@src/store/repo/types";
import { sessionSourceAtom } from "@src/store/session";
import type { SessionSource } from "@src/store/session/creatorStateAtom";

interface UseChatPanelBranchSyncOptions {
  effectiveSource: SessionSource | null;
  selectedRepoId: string;
  currentRepoKind: RepoKind | undefined;
  currentBranch: string;
  loadBranchList: () => void;
}

export function useChatPanelBranchSync({
  effectiveSource,
  selectedRepoId,
  currentRepoKind,
  currentBranch,
  loadBranchList,
}: UseChatPanelBranchSyncOptions) {
  const setSessionSource = useSetAtom(sessionSourceAtom);

  useEffect(() => {
    if (!effectiveSource) return;
    if (effectiveSource.type !== "local") return;
    if (!effectiveSource.repoId) return;
    if (effectiveSource.repoId !== selectedRepoId) return;
    if (currentRepoKind === REPO_KIND.FOLDER) return;
    if (!currentBranch) return;
    if (effectiveSource.branch) return;

    setSessionSource({
      ...effectiveSource,
      branch: currentBranch,
    });
  }, [
    currentBranch,
    currentRepoKind,
    effectiveSource,
    selectedRepoId,
    setSessionSource,
  ]);

  useEffect(() => {
    if (!selectedRepoId) return;
    if (currentRepoKind === REPO_KIND.FOLDER) return;
    loadBranchList();
  }, [selectedRepoId, loadBranchList, currentRepoKind]);
}
