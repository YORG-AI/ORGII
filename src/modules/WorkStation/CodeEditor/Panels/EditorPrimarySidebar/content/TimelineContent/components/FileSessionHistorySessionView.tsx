import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import SessionHoverCard from "@src/components/SessionHoverCard";
import { PRIMARY_SIDEBAR_HOVER } from "@src/modules/WorkStation/shared/tokens";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import type {
  CollaborationSessionOrigin,
  FileSessionHistorySession,
} from "../types";
import { FileSessionHistoryIcon } from "./FileSessionHistoryIcon";
import { FileSessionHistoryParticipantView } from "./FileSessionHistoryParticipantView";

interface FileSessionHistorySessionProps {
  session: FileSessionHistorySession;
  fallbackWorkspacePath?: string;
  onOpenSession: (
    sessionId: string,
    sessionLabel: string,
    workspacePath?: string,
    parentSessionId?: string,
    collaborationOrigin?: CollaborationSessionOrigin
  ) => void;
}

export const FileSessionHistorySessionView: React.FC<FileSessionHistorySessionProps> =
  memo(({ session, fallbackWorkspacePath, onOpenSession }) => {
    const { t } = useTranslation();
    const actionSummary = Object.entries(session.actionCounts)
      .filter(([, count]) => count > 0)
      .map(
        ([action, count]) =>
          `${t(`labels.sessionBlameAction.${action}`, { defaultValue: action })} ${count}`
      )
      .join(" · ");
    const collaborationOwner =
      session.collaborationOrigin?.ownerDisplayName.trim();
    const collaborationOwnerLabel = collaborationOwner
      ? collaborationOwner.startsWith("@")
        ? collaborationOwner
        : `@${collaborationOwner}`
      : null;
    const meta = [
      collaborationOwnerLabel,
      formatRelativeTime(session.lastInteractionAt, "compact"),
      actionSummary,
    ].filter(Boolean);
    const workspacePath = session.workspacePath ?? fallbackWorkspacePath;
    const hasRootTranscript = Boolean(session.transcriptSessionId);

    const row = (
      <button
        type="button"
        data-testid="session-blame-session-header"
        data-session-id={session.sessionId}
        data-transcript-session-id={session.transcriptSessionId ?? undefined}
        data-origin-session-id={session.sessionId}
        data-participant-kind="root"
        data-session-source={session.source}
        data-attribution-precision={session.attributionPrecision}
        data-read-count={session.actionCounts.read ?? 0}
        data-write-count={session.actionCounts.write ?? 0}
        className={`flex w-full items-start gap-1.5 px-4 py-1.5 pr-3 text-left transition-colors ${hasRootTranscript ? PRIMARY_SIDEBAR_HOVER.row : "cursor-default"}`}
        disabled={!hasRootTranscript}
        onClick={() => {
          if (!session.transcriptSessionId) return;
          onOpenSession(
            session.transcriptSessionId,
            session.sessionLabel,
            workspacePath,
            undefined,
            session.collaborationOrigin ?? undefined
          );
        }}
      >
        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          <FileSessionHistoryIcon
            sessionId={session.sessionId}
            isOrg2Session={Boolean(session.collaborationOrigin)}
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium text-text-2">
            {session.sessionLabel}
          </span>
          <span className="truncate text-[11px] text-text-3">
            {meta.join(" · ")}
          </span>
        </span>
      </button>
    );

    return (
      <div
        data-testid="session-blame-session"
        data-session-id={session.sessionId}
        data-session-source={session.source}
        data-cloud-org-id={session.collaborationOrigin?.orgId}
        data-cloud-session-row-id={session.collaborationOrigin?.sessionRowId}
      >
        {hasRootTranscript ? (
          <SessionHoverCard
            sessionId={session.transcriptSessionId}
            position="right-start"
            mouseEnterDelay={600}
          >
            {row}
          </SessionHoverCard>
        ) : (
          row
        )}
        <div className="border-l border-border-2/60">
          {session.participants.map((participant) => (
            <FileSessionHistoryParticipantView
              key={participant.entryId}
              participant={participant}
              originSessionId={session.sessionId}
              source={session.source}
              onClick={
                participant.transcriptSessionId
                  ? () =>
                      onOpenSession(
                        participant.transcriptSessionId!,
                        participant.sessionLabel,
                        workspacePath,
                        session.transcriptSessionId ?? undefined,
                        session.collaborationOrigin ?? undefined
                      )
                  : undefined
              }
            />
          ))}
        </div>
      </div>
    );
  });

FileSessionHistorySessionView.displayName = "FileSessionHistorySessionView";
