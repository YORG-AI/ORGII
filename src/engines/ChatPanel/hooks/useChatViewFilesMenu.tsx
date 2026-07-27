/**
 * useChatViewFilesMenu
 *
 * Wires the composer's "Files" pill menu (`GitDiffActionsMenu`) to the git
 * diff actions for a session, and memoizes the rendered menu element so
 * ChatView doesn't rebuild it every render.
 */
import { useMemo } from "react";

import GitDiffActionsMenu from "../InputArea/components/GitDiffActionsMenu";
import { useGitDiffActions } from "../InputArea/hooks/useGitDiffActions";

export function useChatViewFilesMenu({
  sessionId,
  openAgentStationDiff,
}: {
  sessionId: string;
  openAgentStationDiff: () => void;
}) {
  const {
    onCommit,
    onCommitPush,
    onPush,
    onCreatePr,
    onViewMyStation,
    onViewAgentStation,
    hasCommitsToPush,
    gitActionsDisabled,
  } = useGitDiffActions({ sessionId, openAgentStationDiff });

  const filesMenu = useMemo(
    () => (
      <GitDiffActionsMenu
        onCommit={onCommit}
        onCommitPush={onCommitPush}
        onPush={onPush}
        onCreatePr={onCreatePr}
        onViewMyStation={onViewMyStation}
        onViewAgentStation={onViewAgentStation}
        hasCommitsToPush={hasCommitsToPush}
        gitActionsDisabled={gitActionsDisabled}
      />
    ),
    [
      onCommit,
      onCommitPush,
      onPush,
      onCreatePr,
      onViewMyStation,
      onViewAgentStation,
      hasCommitsToPush,
      gitActionsDisabled,
    ]
  );

  return { filesMenu };
}
