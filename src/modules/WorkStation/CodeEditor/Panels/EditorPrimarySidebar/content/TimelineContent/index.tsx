/**
 * TimelineContent Component
 *
 * Displays Git commit history and repo-shareable `.orgtrack` session lineage
 * for the currently selected file.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import type {
  OrgtrackFileSessionHistory,
  OrgtrackFileTimeline,
} from "@src/api/tauri/lineage";
import Org2SessionIcon from "@src/assets/modelIcons/org2-session.svg";
import SessionHoverCard from "@src/components/SessionHoverCard";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { buildCloudRemoteItemId } from "@src/features/Org2Cloud/cloudRemoteItemId";
import { useFileHistory } from "@src/hooks/git/useFileHistory";
import { useOrgtrackFileSessionHistory } from "@src/hooks/git/useOrgtrackFileSessionHistory";
import { useOrgtrackFileTimeline } from "@src/hooks/git/useOrgtrackFileTimeline";
import { useRefreshSpin } from "@src/hooks/ui";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { getBasename } from "@src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel/pathUtils";
import {
  HEADER_BUTTON,
  PRIMARY_SIDEBAR_HOVER,
} from "@src/modules/WorkStation/shared/tokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { openOrReplaceSessionInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { sessionByIdAtom } from "@src/store/session";
import { requestSessionSidebarRevealAtom } from "@src/store/ui/sidebarAtom";
import { resolveSessionRowIcon } from "@src/util/session/sessionSidebarRow";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { TIMELINE_CONSTANTS, TIMELINE_ICONS } from "./config";
import { toTimelineRepoRelativePath } from "./filePath";
import type { TimelineCommitInfo, TimelineContentProps } from "./types";

type OrgtrackFileTimelineEntry = OrgtrackFileTimeline["entries"][number];
type FileSessionHistorySession = OrgtrackFileSessionHistory["sessions"][number];
type FileSessionHistoryParticipant =
  FileSessionHistorySession["participants"][number];
type CollaborationSessionOrigin = NonNullable<
  FileSessionHistorySession["collaborationOrigin"]
>;

interface FileSessionHistoryIconProps {
  sessionId: string;
  isOrg2Session?: boolean;
}

const FileSessionHistoryIcon = memo(
  ({ sessionId, isOrg2Session = false }: FileSessionHistoryIconProps) => {
    const session = useAtomValue(sessionByIdAtom(sessionId));

    if (isOrg2Session) {
      return <Org2SessionIcon className="size-3.5" aria-hidden="true" />;
    }

    return React.createElement(resolveSessionRowIcon(session ?? sessionId), {
      size: 14,
      className: "text-text-1",
    });
  }
);

FileSessionHistoryIcon.displayName = "FileSessionHistoryIcon";

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
  }
);

OrgtrackTimelineEntryView.displayName = "OrgtrackTimelineEntryView";

interface FileSessionHistoryParticipantProps {
  participant: FileSessionHistoryParticipant;
  originSessionId: string;
  source: string;
  onClick?: () => void;
}

const FileSessionHistoryParticipantView: React.FC<FileSessionHistoryParticipantProps> =
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
        className={`group/session-history flex w-full items-start gap-1.5 py-1.5 pl-7 pr-3 text-left transition-colors ${hasTranscript ? PRIMARY_SIDEBAR_HOVER.row : "cursor-default"}`}
        onClick={onClick}
        disabled={!hasTranscript}
        title={`${participant.sessionLabel} · ${attribution} · ${precision}`}
      >
        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
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
            className={`${HEADER_BUTTON.actionTreeRow} hidden flex-shrink-0 group-hover/session-history:flex`}
          >
            <OpenIcon size={14} />
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

const FileSessionHistorySessionView: React.FC<FileSessionHistorySessionProps> =
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
      <div className="h-full overflow-y-auto pb-2 scrollbar-hide">
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
                <SessionRefreshIcon
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
