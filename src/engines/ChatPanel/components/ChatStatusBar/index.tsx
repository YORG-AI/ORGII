/**
 * ChatStatusBar
 *
 * Thin status bar pinned to the bottom of the chat pane. Mirrors the
 * WorkStation editor status bar — it reuses the same shared `StatusBar`
 * primitives — but is scoped to the active chat session:
 *   - left:  repo · branch (hidden for chat-only sessions with no repo)
 *   - right: live context-window usage (percent + tokens), tinted as it fills
 *
 * Context usage comes from `useContextUsageInfo`, which mirrors the currently
 * synced session and updates live as the conversation grows.
 */
import { useAtomValue } from "jotai";
import { Code, Gauge, GitBranch } from "lucide-react";
import React, { memo } from "react";

import {
  type RingTone,
  ringToneForPercentage,
} from "@src/engines/ChatPanel/InputArea/components/contextInfoTypes";
import {
  formatTokenCount,
  useContextUsageInfo,
} from "@src/engines/ChatPanel/InputArea/components/useContextUsageInfo";
import {
  BaseStatusBar,
  StatusBarDivider,
  StatusBarSegment,
} from "@src/modules/WorkStation/shared/StatusBar/StatusBarBase";
import { sessionByIdAtom } from "@src/store/session";

interface ChatStatusBarProps {
  sessionId: string;
}

/** Prefer the session's stored repo name; fall back to the repo path basename. */
function resolveRepoName(
  repoName: string | undefined,
  repoPath: string | undefined
): string | undefined {
  if (repoName) return repoName;
  if (!repoPath) return undefined;
  return repoPath.split(/[\\/]/).filter(Boolean).pop();
}

const CONTEXT_TONE_CLASS: Record<RingTone, string> = {
  unused: "text-text-3",
  normal: "text-text-2",
  warning: "text-warning-6",
  critical: "text-danger-6",
};

const ChatStatusBar: React.FC<ChatStatusBarProps> = memo(({ sessionId }) => {
  const session = useAtomValue(sessionByIdAtom(sessionId));
  const { clampedPercentage, displayTokens, maxTokens, tokenLabel } =
    useContextUsageInfo();

  const repoName = resolveRepoName(session?.repo_name, session?.repoPath);
  const branch = session?.worktreeBranch || session?.branch;
  const toneClass =
    CONTEXT_TONE_CLASS[ringToneForPercentage(clampedPercentage)];

  const leftContent = (
    <>
      {repoName && (
        <StatusBarSegment className="min-w-0 text-text-1" title={repoName}>
          <Code size={13} className="shrink-0 text-text-1" />
          <span className="min-w-0 max-w-40 truncate font-medium">
            {repoName}
          </span>
        </StatusBarSegment>
      )}
      {branch && (
        <StatusBarSegment className="min-w-0 text-text-1" title={branch}>
          <GitBranch size={13} className="shrink-0 text-text-1" />
          <span className="min-w-0 max-w-40 truncate font-medium">
            {branch}
          </span>
        </StatusBarSegment>
      )}
    </>
  );

  const rightContent = (
    <StatusBarSegment className="text-text-1" title={tokenLabel}>
      <Gauge size={13} className="shrink-0 text-text-3" />
      <span className={`font-medium tabular-nums ${toneClass}`}>
        {Math.round(clampedPercentage)}%
      </span>
      <StatusBarDivider />
      <span className="tabular-nums text-text-3">
        {formatTokenCount(displayTokens)}/{formatTokenCount(maxTokens)}
      </span>
    </StatusBarSegment>
  );

  return (
    <BaseStatusBar
      leftContent={leftContent}
      rightContent={rightContent}
      roundedBottom={false}
      // Sits flush under the composer — drop BaseStatusBar's top hairline
      // (`!` beats the baked-in `border-t`, since classNames is a plain join).
      className="!border-t-0"
    />
  );
});

ChatStatusBar.displayName = "ChatStatusBar";

export default ChatStatusBar;
