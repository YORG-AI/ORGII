import React, { memo } from "react";

import { PRIMARY_SIDEBAR_HOVER } from "@src/modules/WorkStation/shared/tokens";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { TIMELINE_ICONS } from "../config";
import type { OrgtrackFileTimelineEntry } from "../types";

interface OrgtrackTimelineEntryProps {
  entry: OrgtrackFileTimelineEntry;
  onCommitClick?: (commitSha: string) => void;
}

export const OrgtrackTimelineEntryView: React.FC<OrgtrackTimelineEntryProps> =
  memo(({ entry, onCommitClick }) => {
    const CommitIcon = TIMELINE_ICONS.commit;
    const PinIcon = TIMELINE_ICONS.pin;
    const Icon = entry.entryType === "commit_link" ? CommitIcon : PinIcon;
    const timestamp = new Date(entry.timestamp * 1000).toISOString();
    const lineLabel =
      entry.startLine && entry.endLine
        ? `L${entry.startLine}-${entry.endLine}`
        : null;
    const sessionName =
      entry.sessionLabel ?? entry.sessionId ?? "Unknown session";
    const people = entry.agentIdentity?.displayName;
    const title = sessionName;
    const meta = [
      formatRelativeTime(timestamp, "compact"),
      people,
      entry.commitSha
        ? `${entry.commitSha.slice(0, 8)} applied`
        : "not committed",
      lineLabel,
      entry.functionName,
    ].filter(Boolean);

    return (
      <div
        className={`group/orgtrack-item flex items-start gap-1.5 px-4 py-1.5 pr-3 transition-colors ${
          entry.commitSha ? `cursor-pointer ${PRIMARY_SIDEBAR_HOVER.row}` : ""
        }`}
        onClick={() => {
          if (entry.commitSha) {
            onCommitClick?.(entry.commitSha);
          }
        }}
      >
        <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          <Icon size={14} className="text-text-1" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="truncate text-[13px] text-text-2" title={title}>
            {title}
          </div>
          <div className="truncate text-[11px] text-text-3">
            {meta.join(" · ")}
          </div>
        </div>
      </div>
    );
  });

OrgtrackTimelineEntryView.displayName = "OrgtrackTimelineEntryView";
