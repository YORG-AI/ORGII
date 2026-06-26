/**
 * useGitDiffActions
 *
 * Wires the composer file-changes pill menu (`GitDiffActionsMenu`) to real
 * behavior:
 * - commit / commit & push / push → agent prompt (runs in the agent's own
 *   workspace)
 * - View in my station            → My Station Source Control tab
 * - View in Agent station         → existing Agent Station diff navigation
 *
 * The agent-prompt sequence mirrors PinnedActionsBar's "Commit & Push" pill.
 */
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useRef } from "react";

import { useUserIntentSubmit } from "@src/engines/ChatPanel/hooks/useWorkspaceChat/useUserIntentSubmit";
import { createLogger } from "@src/hooks/logger";
import { WorkStationViewService } from "@src/services/workStation";
import {
  currentGitStatusAtom,
  workspaceGitStatusMapAtom,
} from "@src/store/git";
import { isSessionActiveAtom } from "@src/store/session/cliSessionStatusAtom";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";

import {
  GIT_DIFF_COMMIT_PROMPT,
  GIT_DIFF_COMMIT_PUSH_PROMPT,
  GIT_DIFF_CREATE_PR_PROMPT,
  GIT_DIFF_PUSH_PROMPT,
  computeGitActionsDisabled,
  runAgentGitAction,
} from "./gitDiffActions";

const log = createLogger("GitDiffActions");

export interface UseGitDiffActionsOptions {
  sessionId?: string | null;
  /** Existing Agent Station diff navigation (reused for "View in Agent station"). */
  openAgentStationDiff: () => void;
}

export interface UseGitDiffActionsResult {
  onCommit: () => void;
  onCommitPush: () => void;
  onPush: () => void;
  onCreatePr: () => void;
  onViewMyStation: () => void;
  onViewAgentStation: () => void;
  hasCommitsToPush: boolean;
  gitActionsDisabled: boolean;
}

export function useGitDiffActions({
  sessionId,
  openAgentStationDiff,
}: UseGitDiffActionsOptions): UseGitDiffActionsResult {
  const isSessionActive = useAtomValue(isSessionActiveAtom);
  const currentGitStatus = useAtomValue(currentGitStatusAtom);
  const workspaceFolders = useAtomValue(workspaceFoldersAtom);
  const workspaceGitStatusMap = useAtomValue(workspaceGitStatusMapAtom);
  const submitUserIntent = useUserIntentSubmit({
    getSessionId: () => sessionId ?? null,
  });
  const pendingRef = useRef(false);

  const sendAgentPrompt = useCallback(
    (prompt: string) => {
      void runAgentGitAction({
        sessionId,
        isSessionActive,
        guard: pendingRef,
        prompt,
        submitPrompt: (sid, p) =>
          submitUserIntent({
            sessionId: sid,
            displayContent: p,
            source: "interactive-event",
          }),
        onError: (err) => log.error("agent git action failed:", err),
      });
    },
    [sessionId, isSessionActive, submitUserIntent]
  );

  const onCommit = useCallback(
    () => sendAgentPrompt(GIT_DIFF_COMMIT_PROMPT),
    [sendAgentPrompt]
  );
  const onCommitPush = useCallback(
    () => sendAgentPrompt(GIT_DIFF_COMMIT_PUSH_PROMPT),
    [sendAgentPrompt]
  );
  const onPush = useCallback(
    () => sendAgentPrompt(GIT_DIFF_PUSH_PROMPT),
    [sendAgentPrompt]
  );

  const onCreatePr = useCallback(
    () => sendAgentPrompt(GIT_DIFF_CREATE_PR_PROMPT),
    [sendAgentPrompt]
  );

  const onViewMyStation = useCallback(() => {
    void WorkStationViewService.openSourceControlTab().catch((err) =>
      log.error("open source control failed:", err)
    );
  }, []);

  const onViewAgentStation = useCallback(() => {
    openAgentStationDiff();
  }, [openAgentStationDiff]);

  const hasCommitsToPush = useMemo(() => {
    if ((currentGitStatus?.branch_ahead_behind?.ahead ?? 0) > 0) {
      return true;
    }

    return workspaceFolders.some((folder) => {
      const status = workspaceGitStatusMap.get(folder.path);
      return (status?.branch_ahead_behind?.ahead ?? 0) > 0;
    });
  }, [currentGitStatus, workspaceFolders, workspaceGitStatusMap]);

  const gitActionsDisabled = useMemo(
    () => computeGitActionsDisabled({ isSessionActive, sessionId }),
    [isSessionActive, sessionId]
  );

  return {
    onCommit,
    onCommitPush,
    onPush,
    onCreatePr,
    onViewMyStation,
    onViewAgentStation,
    hasCommitsToPush,
    gitActionsDisabled,
  };
}

export default useGitDiffActions;
