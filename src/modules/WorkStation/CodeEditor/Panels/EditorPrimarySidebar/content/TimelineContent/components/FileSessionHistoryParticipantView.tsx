import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import SessionHoverCard from "@src/components/SessionHoverCard";
import { HugeiconsIcon } from "@src/icons";
import {
  HEADER_BUTTON,
  PRIMARY_SIDEBAR_HOVER,
} from "@src/modules/WorkStation/shared/tokens";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { TIMELINE_ICONS } from "../config";
import type { FileSessionHistoryParticipant } from "../types";
import { FileSessionHistoryIcon } from "./FileSessionHistoryIcon";

interface FileSessionHistoryParticipantProps {
  participant: FileSessionHistoryParticipant;
  originSessionId: string;
  source: string;
  onClick?: () => void;
}

export const FileSessionHistoryParticipantView: React.FC<FileSessionHistoryParticipantProps> =
  memo(({ participant, originSessionId, source, onClick }) => {
    const { t } = useTranslation();
    const OpenIcon = TIMELINE_ICONS.openDiff;
    const actionSummary = Object.entries(participant.actionCounts)
      .filter(([, count]) => count > 0)
      .map(
        ([action, count]) =>
          `${t(`labels.sessionBlameAction.${action}`, { defaultValue: action })} ${count}`
      )
      .join(" · ");
    const meta = [
      formatRelativeTime(participant.lastInteractionAt, "compact"),
      actionSummary,
    ].filter(Boolean);
    const attribution =
      participant.participantKind === "subagent"
        ? t("labels.sessionBlameSubagent", {
            name:
              participant.actorLabel ??
              participant.actorId ??
              participant.sessionLabel,
          })
        : t("labels.sessionBlameMainSession");
    const precision = t(
      `labels.sessionBlamePrecision.${participant.attributionPrecision}`
    );
    const hasTranscript = Boolean(participant.transcriptSessionId);

    const row = (
      <button
        type="button"
        data-testid="session-blame-entry"
        data-session-id={participant.sessionId}
        data-transcript-session-id={
          participant.transcriptSessionId ?? undefined
        }
        data-origin-session-id={originSessionId}
        data-participant-kind={participant.participantKind}
        data-actor-id={participant.actorId ?? undefined}
        data-session-source={source}
        data-attribution-precision={participant.attributionPrecision}
        data-read-count={participant.actionCounts.read ?? 0}
        data-write-count={participant.actionCounts.write ?? 0}
        className={`group/session-history flex w-full items-start gap-1.5 py-1.5 pr-3 pl-7 text-left transition-colors ${hasTranscript ? PRIMARY_SIDEBAR_HOVER.row : "cursor-default"}`}
        onClick={onClick}
        disabled={!hasTranscript}
        title={`${participant.sessionLabel} · ${attribution} · ${precision}`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          <FileSessionHistoryIcon
            sessionId={participant.transcriptSessionId ?? participant.sessionId}
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] text-text-2">
            {participant.sessionLabel}
          </span>
          <span className="truncate text-[11px] text-text-3">
            {meta.join(" · ")}
          </span>
          <span
            className="truncate text-[11px] text-text-3"
            data-testid="session-blame-attribution"
          >
            {attribution} · {precision}
          </span>
        </span>
        {hasTranscript && (
          <span
            className={`${HEADER_BUTTON.actionTreeRow} hidden shrink-0 group-hover/session-history:flex`}
          >
            <HugeiconsIcon icon={OpenIcon} size={14} />
          </span>
        )}
      </button>
    );

    return hasTranscript ? (
      <SessionHoverCard
        sessionId={participant.transcriptSessionId}
        position="right-start"
        mouseEnterDelay={600}
      >
        {row}
      </SessionHoverCard>
    ) : (
      row
    );
  });

FileSessionHistoryParticipantView.displayName =
  "FileSessionHistoryParticipantView";
