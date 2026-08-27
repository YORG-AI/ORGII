import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import {
  HEADER_BUTTON,
  PRIMARY_SIDEBAR_HOVER,
} from "@src/modules/WorkStation/shared/tokens";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { TIMELINE_ICONS } from "../config";

interface TimelineEntryProps {
  commitSha: string;
  shortSha: string;
  message: string;
  author: string;
  timestamp: string;
  isSelected?: boolean;
  onClick: () => void;
}

export const TimelineEntry: React.FC<TimelineEntryProps> = memo(
  ({
    shortSha,
    message,
    author,
    timestamp,
    isSelected = false,
    onClick,
    commitSha: _commitSha,
  }) => {
    const { t } = useTranslation();
    const CommitIcon = TIMELINE_ICONS.commit;
    const OpenIcon = TIMELINE_ICONS.openDiff;

    return (
      <div
        className={`group/timeline-item flex cursor-pointer items-start gap-1.5 px-4 py-1.5 pr-3 transition-colors ${
          isSelected
            ? `${SURFACE_TOKENS.selected} ${PRIMARY_SIDEBAR_HOVER.selectedRow}`
            : PRIMARY_SIDEBAR_HOVER.row
        }`}
        onClick={onClick}
      >
        <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          <CommitIcon size={14} className="text-text-3" />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div
            className={`truncate text-[13px] ${isSelected ? "font-medium text-text-1" : "text-text-2"}`}
            title={message}
          >
            {message}
          </div>

          <div className="truncate text-[11px] text-text-3">
            {formatRelativeTime(timestamp, "compact")} · {author} · {shortSha}
          </div>
        </div>

        <button
          className={`${HEADER_BUTTON.actionTreeRow} hidden flex-shrink-0 group-hover/timeline-item:flex`}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
          title={t("tooltips.openDiff")}
        >
          <OpenIcon size={14} />
        </button>
      </div>
    );
  }
);

TimelineEntry.displayName = "TimelineEntry";
