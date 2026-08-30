/**
 * SessionHeader Component
 *
 * Displays session info at the top of the chat.
 * Shows: Session started indicator, model name, and truncated session ID.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon, PlayIcon } from "@src/icons";

export interface SessionInfo {
  sessionId?: string;
  model?: string;
  startedAt?: string;
}

interface SessionHeaderProps {
  sessionInfo: SessionInfo | null;
}

// memo: rendered once at the top of `ChatHistory`, which re-renders on
// every event tick. `sessionInfo` is produced by `useChatHistoryOptimization`
// via `useMemo`, so its reference is stable until the underlying
// `session_start` event changes.
const SessionHeader: React.FC<SessionHeaderProps> = memo(({ sessionInfo }) => {
  const { t } = useTranslation("sessions");
  const model = sessionInfo?.model;

  if (!sessionInfo) return null;

  return (
    <div className="flex flex-shrink-0 items-center gap-3 py-2 pl-5 pr-3">
      {/* Session started indicator */}
      <div className="chat-text-sm flex items-center gap-1.5">
        <HugeiconsIcon
          icon={PlayIcon}
          data-icon="play"
          className="chat-icon text-success-6"
        />
        <span className="chat-block-content ml-1.5 text-text-2">
          {t("chat.sessionStarted")}
        </span>
      </div>

      {/* Model badge */}
      {model && (
        <span className="rounded bg-primary-6/10 px-2 py-0.5 text-[11px] font-medium text-text-2">
          {model}
        </span>
      )}
    </div>
  );
});

SessionHeader.displayName = "SessionHeader";

export default SessionHeader;
