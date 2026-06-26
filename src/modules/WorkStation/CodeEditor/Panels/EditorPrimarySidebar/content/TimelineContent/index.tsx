/**
 * TimelineContent Component
 *
 * Displays Git commit history and repo-shareable `.orgtrack` session lineage
 * for the currently selected file.
 */
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { OrgtrackFileTimeline } from "@src/api/tauri/lineage";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { useFileHistory } from "@src/hooks/git/useFileHistory";
import { useOrgtrackFileTimeline } from "@src/hooks/git/useOrgtrackFileTimeline";
import { getBasename } from "@src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel/pathUtils";
import {
  HEADER_BUTTON,
  PRIMARY_SIDEBAR_HOVER,
} from "@src/modules/WorkStation/shared/tokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { TIMELINE_CONSTANTS, TIMELINE_ICONS } from "./config";
import type { TimelineCommitInfo, TimelineContentProps } from "./types";

type OrgtrackFileTimelineEntry = OrgtrackFileTimeline["entries"][number];

interface TimelineEntryProps {
  commitSha: string;
  shortSha: string;
  message: string;
  author: string;
  timestamp: string;
  isSelected?: boolean;
  onClick: () => void;
}

const TimelineEntry: React.FC<TimelineEntryProps> = memo(
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

interface OrgtrackTimelineEntryProps {
  entry: OrgtrackFileTimelineEntry;
  onCommitClick?: (commitSha: string) => void;
}

const OrgtrackTimelineEntryView: React.FC<OrgtrackTimelineEntryProps> = memo(
  ({ entry, onCommitClick }) => {
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
          <Icon size={14} className="text-primary-6" />
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
  }
);

OrgtrackTimelineEntryView.displayName = "OrgtrackTimelineEntryView";

export const TimelineContent: React.FC<TimelineContentProps> = memo(
  ({
    repoId,
    repoPath,
    filePath,
    selectedCommitSha,
    onCommitClick,
    loading: _parentLoading = false,
  }) => {
    const { t } = useTranslation();
    const orgtrackRepoPath = repoPath ?? repoId;
    const relativeFilePath = React.useMemo(() => {
      if (!filePath || !repoId) return null;

      if (filePath.startsWith(repoId)) {
        const relative = filePath.slice(repoId.length);
        return relative.startsWith("/") ? relative.slice(1) : relative;
      }

      if (repoPath && filePath.startsWith(repoPath)) {
        const relative = filePath.slice(repoPath.length);
        return relative.startsWith("/") ? relative.slice(1) : relative;
      }

      return filePath;
    }, [filePath, repoId, repoPath]);

    const { commits, loading, error } = useFileHistory({
      repoId,
      filePath: relativeFilePath,
      limit: TIMELINE_CONSTANTS.MAX_COMMITS,
      autoLoad: true,
    });

    const {
      timeline: orgtrackTimeline,
      loading: orgtrackLoading,
      error: orgtrackError,
    } = useOrgtrackFileTimeline({
      repoPath: orgtrackRepoPath,
      filePath: relativeFilePath,
      autoLoad: true,
    });

    const handleCommitClick = useCallback(
      (commitInfo: TimelineCommitInfo) => {
        if (filePath && onCommitClick) {
          onCommitClick(commitInfo.sha, filePath, commitInfo);
        }
      },
      [filePath, onCommitClick]
    );

    const handleOrgtrackCommitClick = useCallback(
      (commitSha: string) => {
        const commit = commits.find(
          (candidate) => candidate.sha.split(/[\s\n]/)[0] === commitSha
        );
        if (!commit || !filePath || !onCommitClick) return;
        onCommitClick(commitSha, filePath, {
          sha: commitSha,
          shortSha: commit.short_sha,
          message: commit.summary,
          author: commit.author.name,
          timestamp: commit.author.date,
        });
      },
      [commits, filePath, onCommitClick]
    );

    if (!filePath || !relativeFilePath) {
      return (
        <Placeholder
          variant="empty"
          title={t("placeholders.selectFileToViewChanges")}
        />
      );
    }

    if (loading && orgtrackLoading) {
      return (
        <Placeholder
          variant="loading"
          title={t("placeholders.loadingHistory")}
        />
      );
    }

    if (error && !orgtrackTimeline) {
      return (
        <Placeholder
          variant="error"
          title={t("placeholders.failedToLoadHistory")}
          subtitle={error}
        />
      );
    }

    const orgtrackEntries = orgtrackTimeline?.entries ?? [];

    if (commits.length === 0 && orgtrackEntries.length === 0) {
      return (
        <Placeholder
          variant="empty"
          title={t("placeholders.noGitHistory")}
          subtitle={`${getBasename(filePath)} is not tracked by Git`}
        />
      );
    }

    return (
      <div className="h-full overflow-y-auto pb-2 scrollbar-hide">
        {commits.length > 0 && (
          <div className="py-1">
            <div className="px-4 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-text-3">
              {t("labels.timeline")}
            </div>
            {commits.map((commit) => {
              const cleanSha = commit.sha.split(/[\s\n]/)[0];
              const isSelected = selectedCommitSha === cleanSha;

              const commitInfo: TimelineCommitInfo = {
                sha: cleanSha,
                shortSha: commit.short_sha,
                message: commit.summary,
                author: commit.author.name,
                timestamp: commit.author.date,
              };

              return (
                <TimelineEntry
                  key={cleanSha}
                  commitSha={cleanSha}
                  shortSha={commit.short_sha}
                  message={commit.summary}
                  author={commit.author.name}
                  timestamp={commit.author.date}
                  isSelected={isSelected}
                  onClick={() => handleCommitClick(commitInfo)}
                />
              );
            })}
          </div>
        )}

        {orgtrackEntries.length > 0 && (
          <div className="py-1">
            <div className="px-4 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-text-3">
              {t("labels.agentBlame")}
            </div>
            {orgtrackEntries.map((entry) => (
              <OrgtrackTimelineEntryView
                key={entry.id}
                entry={entry}
                onCommitClick={handleOrgtrackCommitClick}
              />
            ))}
          </div>
        )}

        {orgtrackError && (
          <div className="px-4 py-2 text-[11px] text-warning-6">
            {orgtrackError}
          </div>
        )}
      </div>
    );
  }
);

TimelineContent.displayName = "TimelineContent";

export default TimelineContent;
