/**
 * TimelineContent Component
 *
 * Displays Git commit history and repo-shareable `.orgtrack` session lineage
 * for the currently selected file.
 */
import { useSetAtom } from "jotai";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import { Placeholder } from "@src/components/Placeholder";
import { buildCloudRemoteItemId } from "@src/features/Org2Cloud/cloudRemoteItemId";
import { useFileHistory } from "@src/hooks/git/useFileHistory";
import { useOrgtrackFileSessionHistory } from "@src/hooks/git/useOrgtrackFileSessionHistory";
import { useOrgtrackFileTimeline } from "@src/hooks/git/useOrgtrackFileTimeline";
import { useRefreshSpin } from "@src/hooks/ui";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { getBasename } from "@src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel/pathUtils";
import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";
import { openOrReplaceSessionInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { requestSessionSidebarRevealAtom } from "@src/store/ui/sidebarAtom";

import { FileSessionHistorySessionView } from "./components/FileSessionHistorySessionView";
import { OrgtrackTimelineEntryView } from "./components/OrgtrackTimelineEntryView";
import { TimelineEntry } from "./components/TimelineEntry";
import { TIMELINE_CONSTANTS, TIMELINE_ICONS } from "./config";
import { toTimelineRepoRelativePath } from "./filePath";
import type {
  CollaborationSessionOrigin,
  TimelineCommitInfo,
  TimelineContentProps,
} from "./types";

export const TimelineContent: React.FC<TimelineContentProps> = memo(
  ({
    variant,
    repoId,
    repoPath,
    filePath,
    selectedCommitSha,
    onCommitClick,
    loading: _parentLoading = false,
  }) => {
    const { t } = useTranslation();
    const { openSession } = useSessionView();
    const openOrReplaceSessionTab = useSetAtom(
      openOrReplaceSessionInChatPanelTabAtom
    );
    const requestSessionSidebarReveal = useSetAtom(
      requestSessionSidebarRevealAtom
    );
    const orgtrackRepoPath = repoPath ?? repoId;
    const relativeFilePath = React.useMemo(
      () => toTimelineRepoRelativePath(filePath, repoId, repoPath),
      [filePath, repoId, repoPath]
    );

    const { commits, loading, error } = useFileHistory({
      repoId,
      filePath: relativeFilePath,
      limit: TIMELINE_CONSTANTS.MAX_COMMITS,
      // Session lineage entries can link back to their corresponding commit.
      // Keep the file history available in both views for that interaction.
      autoLoad: true,
    });

    const {
      timeline: orgtrackTimeline,
      loading: orgtrackLoading,
      error: orgtrackError,
    } = useOrgtrackFileTimeline({
      repoPath: orgtrackRepoPath,
      filePath: relativeFilePath,
      autoLoad: variant === "session",
    });
    const {
      history: fileSessionHistory,
      loading: sessionHistoryLoading,
      error: sessionHistoryError,
      refresh: refreshFileSessions,
      loadMore: loadMoreFileSessions,
      loadingMore: fileSessionsLoadingMore,
      hasMore: hasMoreFileSessions,
    } = useOrgtrackFileSessionHistory({
      repoPath: orgtrackRepoPath,
      filePath: relativeFilePath,
      autoLoad: variant === "session",
    });

    // Session history loads once on mount and only refreshes on demand — this
    // button (and the empty/error-state actions below) is the sole refresh
    // path now that the 5s revision poll is gone.
    const {
      spinClass: sessionRefreshSpinClass,
      handleClick: handleSessionRefresh,
    } = useRefreshSpin(refreshFileSessions, sessionHistoryLoading);
    const SessionRefreshIcon = TIMELINE_ICONS.refresh;

    const handleCommitClick = useCallback(
      (commitInfo: TimelineCommitInfo) => {
        if (filePath && onCommitClick) {
          onCommitClick(commitInfo.sha, filePath, commitInfo);
        }
      },
      [filePath, onCommitClick]
    );

    const handleOpenSession = useCallback(
      (
        sessionId: string,
        sessionName: string,
        workspacePath?: string,
        parentSessionId?: string,
        collaborationOrigin?: CollaborationSessionOrigin
      ) => {
        requestSessionSidebarReveal({
          sessionId,
          parentSessionId,
          sidebarItemId: collaborationOrigin
            ? buildCloudRemoteItemId(
                collaborationOrigin.orgId,
                collaborationOrigin.sessionRowId
              )
            : undefined,
          cloudOrgId: collaborationOrigin?.orgId,
        });
        // ChatView is owned by the active Chat Panel tab. Keep that tab's
        // identity in sync with the legacy WorkStation session selection so
        // root-session and subagent rows load their own transcripts.
        openOrReplaceSessionTab({
          sessionId,
          sessionName,
          repoPath: workspacePath,
        });
        openSession(sessionId, sessionName, workspacePath);
      },
      [openOrReplaceSessionTab, openSession, requestSessionSidebarReveal]
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

    const orgtrackEntries = orgtrackTimeline?.entries ?? [];
    const fileSessions = fileSessionHistory?.sessions ?? [];
    const sessionBackfill = fileSessionHistory?.backfill;
    const isSessionBackfillActive =
      sessionBackfill &&
      ["queued", "discovering", "indexing"].includes(sessionBackfill.status);
    const isGitTimeline = variant === "git";
    const hasNoEntries = isGitTimeline
      ? commits.length === 0
      : orgtrackEntries.length === 0 &&
        fileSessions.length === 0 &&
        !isSessionBackfillActive;
    const isLoading = isGitTimeline
      ? loading
      : orgtrackLoading || sessionHistoryLoading;
    const timelineError = isGitTimeline
      ? error
      : (orgtrackError ?? sessionHistoryError);

    if (hasNoEntries && isLoading) {
      return (
        <Placeholder
          variant="loading"
          title={t("placeholders.loadingHistory")}
        />
      );
    }

    if (hasNoEntries && timelineError) {
      return (
        <Placeholder
          variant="error"
          title={t("placeholders.failedToLoadHistory")}
          subtitle={timelineError ?? t("placeholders.failedToLoadHistory")}
          onRetry={isGitTimeline ? undefined : handleSessionRefresh}
        />
      );
    }

    if (hasNoEntries) {
      return (
        <Placeholder
          variant="empty"
          title={
            isGitTimeline
              ? t("placeholders.noGitHistory")
              : t("placeholders.noSessionHistory", {
                  defaultValue: "No session history",
                })
          }
          subtitle={
            isGitTimeline
              ? `${getBasename(filePath)} is not tracked by Git`
              : t("placeholders.noSessionHistoryForFile", {
                  defaultValue: `No session activity found for ${getBasename(filePath)}`,
                })
          }
          action={
            isGitTimeline
              ? undefined
              : {
                  label: t("actions.refresh"),
                  onClick: handleSessionRefresh,
                  disabled: sessionHistoryLoading,
                  dataTestId: "session-blame-refresh-empty",
                }
          }
        />
      );
    }

    return (
      <div className="scrollbar-hide h-full overflow-y-auto pb-2">
        {!isGitTimeline && (fileSessions.length > 0 || sessionBackfill) && (
          <div
            className="py-1"
            data-testid="session-blame-section"
            data-history-revision={fileSessionHistory?.revision ?? 0}
            data-loaded-sessions={fileSessions.length}
            data-total-sessions={fileSessionHistory?.page.totalSessions ?? 0}
          >
            <div className="flex items-center justify-end px-2 pb-1">
              <button
                type="button"
                className={HEADER_BUTTON.actionDisabled}
                disabled={sessionHistoryLoading}
                onClick={handleSessionRefresh}
                title={t("actions.refresh")}
                aria-label={t("actions.refresh")}
                data-testid="session-blame-refresh"
              >
                <AnyIcon
                  icon={SessionRefreshIcon}
                  size={13}
                  strokeWidth={1.75}
                  className={sessionRefreshSpinClass}
                />
              </button>
            </div>
            {sessionBackfill &&
              (isSessionBackfillActive ||
                sessionBackfill.status === "partial" ||
                sessionBackfill.status === "failed") && (
                <div
                  className="px-4 pb-1 text-[11px] text-text-3"
                  data-testid="session-blame-backfill"
                  data-backfill-status={sessionBackfill.status}
                >
                  {isSessionBackfillActive
                    ? t("labels.sessionBlameBackfill.indexing", {
                        indexed: sessionBackfill.indexedSessions,
                        total: sessionBackfill.totalSessions,
                      })
                    : sessionBackfill.status === "partial"
                      ? t("labels.sessionBlameBackfill.partial", {
                          failed: sessionBackfill.failedSessions,
                        })
                      : t("labels.sessionBlameBackfill.failed")}
                </div>
              )}
            {fileSessions.map((session) => (
              <FileSessionHistorySessionView
                key={session.sessionId}
                session={session}
                fallbackWorkspacePath={repoPath}
                onOpenSession={handleOpenSession}
              />
            ))}
            {hasMoreFileSessions && (
              <div className="px-4 py-1">
                <button
                  type="button"
                  className={`${HEADER_BUTTON} w-full justify-center text-xs text-text-2`}
                  disabled={fileSessionsLoadingMore}
                  data-testid="session-blame-load-more"
                  onClick={() => void loadMoreFileSessions()}
                >
                  {t("actions.loadMore")}
                </button>
              </div>
            )}
          </div>
        )}

        {isGitTimeline && commits.length > 0 && (
          <div className="py-1">
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

        {!isGitTimeline && orgtrackEntries.length > 0 && (
          <div className="py-1">
            {orgtrackEntries.map((entry) => (
              <OrgtrackTimelineEntryView
                key={entry.id}
                entry={entry}
                onCommitClick={handleOrgtrackCommitClick}
              />
            ))}
          </div>
        )}

        {!isGitTimeline && orgtrackError && (
          <div className="px-4 py-2 text-[11px] text-warning-6">
            {orgtrackError}
          </div>
        )}
        {!isGitTimeline && sessionHistoryError && (
          <div className="px-4 py-2 text-[11px] text-warning-6">
            {sessionHistoryError}
          </div>
        )}
      </div>
    );
  }
);

TimelineContent.displayName = "TimelineContent";

export default TimelineContent;
