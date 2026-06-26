/**
 * SessionReplayDiff
 *
 * Dedicated simulator app for reviewing every diff (edit_file,
 * apply_patch, create, overwrite, delete) emitted by the agent.
 *
 * Layout uses the same `WorkStationShell` + simulator primary sidebar atoms
 * as CodeEditor / Browser session replays, so collapse / position (left ↔
 * right) / resize all share the same chrome and persisted state.
 *
 * The diff always shows the cumulative whole-session state (no per-event
 * replay focus and no per-round narrowing — see issue #24). A chat
 * `TurnFilesFooter` "Review"/file click still scrolls the cumulative list to
 * the clicked file, but never filters it down to a single round.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { GitBranch, ListChevronsDownUp, RotateCcw, Send } from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { getGitCommits } from "@src/api/http/git";
import { type OrgtrackSessionFinalDiff } from "@src/api/tauri/lineage";
import Button from "@src/components/Button";
import { SIMULATOR_PRIMARY_SIDEBAR } from "@src/config/simulatorPrimarySidebar";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { simulatorEventsAtom } from "@src/engines/SessionCore/derived/simulatorEvents";
import { parseUnifiedDiffToOldNew } from "@src/engines/SessionCore/rendering/props/propsDataExtractors";
import type { SimulatorAppProps } from "@src/engines/Simulator/apps/core/types";
import { useFileReviewBatchActions } from "@src/hooks/fileReview/useFileReview";
import { createLogger } from "@src/hooks/logger";
import { usePublishWorkstationTabHeader } from "@src/hooks/workStation";
import {
  type DiffFileNavigationItem,
  DiffFileNavigationList,
  type DiffFileSectionData,
  DiffSectionList,
  NoTabsPlaceholder,
  SimulatorReplayChrome,
  WorkStationShell,
  buildConsolidatedSessionReplayDiffSectionItems,
  buildPrimarySidebarConfig,
  useSimulatorAwaitingAgentCaption,
  useSimulatorPlaceholderActions,
} from "@src/modules/WorkStation/shared";
import {
  type PanelSection,
  PrimarySidebarLayoutWithSections,
  type PrimarySidebarTab,
} from "@src/modules/WorkStation/shared/PrimarySidebarLayout";
import type { ReplayTab } from "@src/modules/WorkStation/shared/SessionReplay/ReplayTabBar";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { reposAtom } from "@src/store/repo/atoms";
import { sessionByIdAtom } from "@src/store/session";
import {
  simulatorDiffCommitNavigationRequestAtom,
  simulatorDiffRefreshNonceAtom,
  simulatorDiffScopeRequestAtom,
  simulatorPrimarySidebarCollapsedAtom,
  simulatorPrimarySidebarPositionAtom,
  simulatorPrimarySidebarWidthAtom,
  simulatorPrimarySidebarWidthPersistAtom,
} from "@src/store/ui/simulatorAtom";
import type { SourceControlHistorySelection } from "@src/store/workstation/tabs";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import {
  type SubmissionCommit,
  SubmissionCommitsContent,
  SubmissionPullRequestsContent,
} from "./SubmissionsContent";
import { isDiffScopeActive, resolveScopedSelectedPath } from "./diffScope";
import type { DiffReplayTab } from "./types";
import { useDiff } from "./useDiff";
import {
  type SubmissionRepoContext,
  useSubmissionsData,
} from "./useSubmissionsData";

const SUBMISSION_COMMIT_RESOLVE_LIMIT = 200;
const logger = createLogger("SessionReplayDiff");

/** Exported for unit testing. */
export function finalDiffToSection(
  finalDiff: OrgtrackSessionFinalDiff
): DiffFileNavigationItem<DiffFileSectionData> {
  const isDeleted = Boolean(finalDiff.isDeleted);
  const parsedDiff = finalDiff.diff
    ? parseUnifiedDiffToOldNew(finalDiff.diff, { preserveHunkGaps: false })
    : undefined;
  const contentUnavailable =
    !finalDiff.diff && !finalDiff.oldContent && !finalDiff.newContent;
  const oldContent = contentUnavailable
    ? undefined
    : (finalDiff.oldContent ?? parsedDiff?.oldValue ?? "");
  const newContent = contentUnavailable
    ? undefined
    : isDeleted
      ? ""
      : (finalDiff.newContent ?? parsedDiff?.newValue ?? "");

  return {
    key: finalDiff.filePath,
    file: {
      path: finalDiff.filePath,
      status: isDeleted ? "deleted" : "modified",
      staged: false,
      additions: finalDiff.linesAdded,
      deletions: finalDiff.linesRemoved,
      oldContent,
      newContent,
      oldStartLine: parsedDiff?.oldStartLine,
      newStartLine: parsedDiff?.newStartLine,
      unifiedDiff: finalDiff.diff || undefined,
      isUnavailable: contentUnavailable || undefined,
    },
    entryIds: [finalDiff.recordId],
  };
}

const GitCommitDetailContent = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/GitCommitDetailContent")
);

const TAB_IDS: Record<DiffReplayTab, string> = {
  all: "diff-tab:all",
  diff: "diff-tab:diff",
  submissions: "diff-tab:submissions",
};

const TAB_BY_ID: Record<string, DiffReplayTab> = {
  [TAB_IDS.all]: "all",
  [TAB_IDS.diff]: "diff",
  [TAB_IDS.submissions]: "submissions",
};

function hasRepoContext(context: SubmissionRepoContext | null): boolean {
  return Boolean(context?.repoId || context?.repoPath);
}

function getSessionIdFromUnknown(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.sessionId === "string" ? record.sessionId : null;
}

function getRepoContextFromUnknown(value: unknown): SubmissionRepoContext {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const repoId =
    typeof record.repoId === "string"
      ? record.repoId
      : typeof record.repo_id === "string"
        ? record.repo_id
        : undefined;
  const repoPath =
    typeof record.repoPath === "string"
      ? record.repoPath
      : typeof record.repo_path === "string"
        ? record.repo_path
        : undefined;
  return { repoId: repoId ?? repoPath, repoPath };
}

function resolveLatestRepoContext(
  events: readonly SessionEvent[],
  fallbackRepoContext: SubmissionRepoContext
): SubmissionRepoContext {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.repoId || event.repoPath) {
      return {
        repoId: event.repoId ?? event.repoPath,
        repoPath: event.repoPath,
      };
    }
  }
  return fallbackRepoContext;
}

function getRepoContextKey(context: SubmissionRepoContext): string | null {
  // Key by filesystem path when available so the same repo reached via
  // different repoId formats (UUID vs path) shares one history cache entry.
  return context.repoPath ?? context.repoId ?? null;
}

const SessionReplayDiff: React.FC<SimulatorAppProps> = ({
  currentEvent,
  mode = "simulation",
}) => {
  const { t } = useTranslation("sessions");
  const { t: tCommon } = useTranslation("common");
  const [activeTab, setActiveTab] = useState<DiffReplayTab>("diff");
  const [historySelection, setHistorySelection] =
    useState<SourceControlHistorySelection | null>(null);
  const [historyRepoContext, setHistoryRepoContext] = useState<{
    repoId?: string;
    repoPath?: string;
  } | null>(null);
  const [focusedDiffPath, setFocusedDiffPath] = useState<string | null>(null);
  const [focusedDiffNonce, setFocusedDiffNonce] = useState(0);
  const [collapseAllSignal, setCollapseAllSignal] = useState(0);
  const simulatorEvents = useAtomValue(simulatorEventsAtom);
  const sessionId = useMemo(
    () =>
      getSessionIdFromUnknown(currentEvent) ?? simulatorEvents[0]?.sessionId,
    [currentEvent, simulatorEvents]
  );
  const session = useAtomValue(sessionByIdAtom(sessionId ?? ""));
  const sessionRepoPath = session?.repoPath ?? "";
  const repos = useAtomValue(reposAtom);
  const [diffCommitNavigationRequest, setDiffCommitNavigationRequest] = useAtom(
    simulatorDiffCommitNavigationRequestAtom
  );
  const diffScopeRequest = useAtomValue(simulatorDiffScopeRequestAtom);
  // Bumped on every chat→Diff navigation; forces a fresh read of the canonical
  // final diffs below so a just-edited file isn't shown with a stale diff.
  const diffRefreshNonce = useAtomValue(simulatorDiffRefreshNonceAtom);
  // Replay-cursor entries feed only the cumulative fallback consolidation
  // below; the per-event "focus" view was removed for issue #24.
  const { entries } = useDiff();

  const fallbackRepoContext = useMemo(() => {
    const sessionRepoContext = sessionRepoPath
      ? { repoId: sessionRepoPath, repoPath: sessionRepoPath }
      : {};
    if (hasRepoContext(sessionRepoContext)) return sessionRepoContext;
    const currentEventRepoContext = getRepoContextFromUnknown(currentEvent);
    if (hasRepoContext(currentEventRepoContext)) return currentEventRepoContext;
    return resolveLatestRepoContext(simulatorEvents, {});
  }, [currentEvent, sessionRepoPath, simulatorEvents]);

  const {
    orgtrackFinalDiffs,
    orgtrackFinalDiffsLoading,
    submissionCommits,
    pullRequestsWithStatus,
    submissionsData,
  } = useSubmissionsData({
    sessionId,
    simulatorEvents,
    fallbackRepoContext,
    repos,
    diffRefreshNonce,
  });

  const canonicalFinalSections = useMemo(
    () => orgtrackFinalDiffs.map(finalDiffToSection),
    [orgtrackFinalDiffs]
  );
  const finalDiffCount = canonicalFinalSections.length;

  const simulatorConsolidatedSections = useMemo(
    () => buildConsolidatedSessionReplayDiffSectionItems(entries),
    [entries]
  );
  const hasSimulatorDiffs = simulatorConsolidatedSections.length > 0;

  // The Agent Station diff is always cumulative (whole-session). The chat
  // `TurnFilesFooter` no longer narrows it to a single round (issue #24); it
  // only scrolls the cumulative list to a clicked file (see the scope effect).
  const sidebarItems =
    finalDiffCount > 0 ? canonicalFinalSections : simulatorConsolidatedSections;

  const consolidatedSections = sidebarItems;

  const primarySidebarCollapsed = useAtomValue(
    simulatorPrimarySidebarCollapsedAtom
  );
  const primarySidebarPosition = useAtomValue(
    simulatorPrimarySidebarPositionAtom
  );
  const primarySidebarWidth = useAtomValue(simulatorPrimarySidebarWidthAtom);
  const setPrimarySidebarWidthPersist = useSetAtom(
    simulatorPrimarySidebarWidthPersistAtom
  );
  const handlePrimarySidebarWidthChange = useCallback(
    (width: number) => {
      setPrimarySidebarWidthPersist(width);
    },
    [setPrimarySidebarWidthPersist]
  );

  const simulatorPlaceholderActions = useSimulatorPlaceholderActions(mode);
  const simulatorAwaitingAgentCaption = useSimulatorAwaitingAgentCaption();

  const handleTabClick = useCallback((eventId: string) => {
    const next = TAB_BY_ID[eventId];
    if (!next) return;
    setActiveTab(next);
    if (next === "diff") {
      setHistorySelection(null);
      setHistoryRepoContext(null);
    }
  }, []);

  const handleCollapseAll = useCallback(() => {
    setCollapseAllSignal((prev) => prev + 1);
  }, []);

  const { pendingCount, onUndoAll } = useFileReviewBatchActions(sessionId);
  const [isUndoingAll, setIsUndoingAll] = useState(false);

  const handleUndoAll = useCallback(async () => {
    const confirmed = await confirmDestructiveAction({
      title: tCommon("actions.undoAll"),
      message: tCommon("confirmation.undoAllChanges", {
        count: pendingCount,
      }),
      okLabel: tCommon("actions.undoAll"),
      cancelLabel: tCommon("actions.cancel"),
    });
    if (!confirmed) return;

    setIsUndoingAll(true);
    try {
      await onUndoAll();
    } finally {
      setIsUndoingAll(false);
    }
  }, [tCommon, pendingCount, onUndoAll]);

  const canUndoAll = pendingCount > 0 && !isUndoingAll;

  const diffHeaderContent = useMemo(
    () => ({
      content: null,
      trailing:
        activeTab === "diff" ? (
          <div className="flex items-center gap-px">
            {canUndoAll ? (
              <Button
                htmlType="button"
                variant="tertiary"
                size="small"
                iconOnly
                className="flex-shrink-0"
                onClick={handleUndoAll}
                title={tCommon("actions.undoAll")}
                icon={<RotateCcw size={14} />}
              />
            ) : null}
            {canUndoAll ? <div className="mx-2 h-5 w-px bg-border-2" /> : null}
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              className="flex-shrink-0"
              onClick={handleCollapseAll}
              title={tCommon("actions.collapseAll")}
              icon={<ListChevronsDownUp size={14} />}
            />
          </div>
        ) : undefined,
    }),
    [activeTab, handleUndoAll, canUndoAll, handleCollapseAll, tCommon]
  );

  useEffect(() => {
    logger.info("submission artifacts derived", {
      eventCount: simulatorEvents.length,
      submissionCommitCount: submissionCommits.length,
      pullRequestCount: submissionsData.pullRequests.length,
      fallbackRepoContext,
      currentRepoContext: getRepoContextFromUnknown(currentEvent),
      sessionId,
      sessionRepoPath,
    });
  }, [
    currentEvent,
    fallbackRepoContext,
    sessionId,
    sessionRepoPath,
    simulatorEvents.length,
    submissionCommits.length,
    submissionsData.pullRequests.length,
  ]);
  const hasSubmissions =
    submissionCommits.length > 0 || submissionsData.pullRequests.length > 0;

  const tabs = useMemo<ReplayTab[]>(() => {
    const formatLabel = (base: string, count: number) =>
      count > 0 ? `${base} (${count})` : base;
    const submissionCount =
      submissionCommits.length + submissionsData.pullRequests.length;
    return [
      {
        eventId: TAB_IDS.diff,
        kind: "diff-filter",
        label: formatLabel(
          t("simulator.replay.diffApp.tabLabel"),
          finalDiffCount
        ),
        title: t("simulator.replay.diffApp.tabLabel"),
        icon: <GitBranch size={14} className="shrink-0" />,
      },
      {
        eventId: TAB_IDS.submissions,
        kind: "diff-filter",
        label: formatLabel(
          t("simulator.replay.diffApp.submissions.tabLabel"),
          submissionCount
        ),
        title: t("simulator.replay.diffApp.submissions.tabLabel"),
        icon: <Send size={14} className="shrink-0" />,
      },
    ];
  }, [
    finalDiffCount,
    submissionCommits.length,
    submissionsData.pullRequests.length,
    t,
  ]);

  usePublishWorkstationTabHeader({
    host: "simulator",
    content: diffHeaderContent,
    enabled: finalDiffCount > 0 || hasSimulatorDiffs || hasSubmissions,
  });

  const handleSubmissionCommitSelect = useCallback(
    (commit: SubmissionCommit) => {
      logger.info(
        `submission commit selected sha=${commit.sha} repoId=${commit.repoId ?? ""} repoPath=${commit.repoPath ?? ""}`,
        {
          commitSha: commit.sha,
          shortSha: commit.short_sha,
          summary: commit.summary,
          repoId: commit.repoId,
          repoPath: commit.repoPath,
        }
      );
      setHistorySelection({
        type: "commit",
        commitSha: commit.sha,
        shortSha: commit.short_sha,
        commitMessage: commit.summary,
      });
      setHistoryRepoContext({
        repoId: commit.repoId,
        repoPath: commit.repoPath,
      });
    },
    []
  );

  useEffect(() => {
    if (!diffCommitNavigationRequest?.commitSha) return;
    if (
      diffCommitNavigationRequest.sessionId &&
      sessionId &&
      diffCommitNavigationRequest.sessionId !== sessionId
    ) {
      return;
    }

    const requestedSha = diffCommitNavigationRequest.commitSha;
    let cancelled = false;

    // A commit reached via a chat-message reference card may not exist in
    // any submission list (those only carry commits this session actually
    // produced). Resolve the SHA directly against every registered repo's
    // git history so the diff renders regardless of where it was committed.
    const candidateContexts: SubmissionRepoContext[] = [];
    const seenKeys = new Set<string>();
    const pushCandidate = (context: SubmissionRepoContext) => {
      const key = getRepoContextKey(context);
      if (!key || seenKeys.has(key)) return;
      seenKeys.add(key);
      candidateContexts.push(context);
    };
    pushCandidate(fallbackRepoContext);
    for (const repo of repos) {
      const path = repo.fs_uri ?? repo.path;
      if (path) pushCandidate({ repoId: repo.id, repoPath: path });
    }

    async function resolveAndSelect() {
      for (const context of candidateContexts) {
        if (cancelled) return;
        const contextKey = getRepoContextKey(context);
        if (!contextKey) continue;
        const result = await getGitCommits({
          repo_id: context.repoId ?? context.repoPath ?? "",
          repo_path: context.repoPath,
          limit: SUBMISSION_COMMIT_RESOLVE_LIMIT,
        });
        const match = (result?.commits ?? []).find(
          (candidate) =>
            candidate.sha
              .toLowerCase()
              .startsWith(requestedSha.toLowerCase()) ||
            candidate.short_sha.toLowerCase() === requestedSha.toLowerCase()
        );
        if (match) {
          if (cancelled) return;
          setActiveTab("submissions");
          handleSubmissionCommitSelect({
            sha: match.sha,
            short_sha: match.short_sha,
            summary: match.summary,
            author: match.author,
            repoId: context.repoId,
            repoPath: context.repoPath,
          });
          setDiffCommitNavigationRequest(null);
          return;
        }
      }
      // Not found anywhere — clear the request so it doesn't retry forever.
      if (!cancelled) setDiffCommitNavigationRequest(null);
    }

    void resolveAndSelect();

    return () => {
      cancelled = true;
    };
  }, [
    diffCommitNavigationRequest,
    fallbackRepoContext,
    handleSubmissionCommitSelect,
    repos,
    sessionId,
    setDiffCommitNavigationRequest,
  ]);

  // A chat `TurnFilesFooter` "Review"/file click switches to the (cumulative)
  // diff tab and scrolls to the clicked row, if any. The list is never
  // narrowed to the round (issue #24). `nonce` is part of the dep set so
  // re-clicking the same file refocuses.
  useEffect(() => {
    if (!isDiffScopeActive(diffScopeRequest, sessionId)) return;
    setActiveTab("diff");
    setHistorySelection(null);
    setHistoryRepoContext(null);
    const selected = resolveScopedSelectedPath(diffScopeRequest, sessionId);
    if (selected) {
      setFocusedDiffPath(selected);
      setFocusedDiffNonce((prev) => prev + 1);
    } else {
      setFocusedDiffPath(null);
    }
  }, [diffScopeRequest, sessionId]);

  const handleSidebarItemSelect = useCallback(
    (item: DiffFileNavigationItem<DiffFileSectionData>) => {
      setHistorySelection(null);
      setHistoryRepoContext(null);
      setFocusedDiffPath(item.file.path);
      setFocusedDiffNonce((prev) => prev + 1);
    },
    []
  );

  const sidebarTab = useMemo<PrimarySidebarTab>(() => {
    // Submissions tab: the sidebar lists what the agent shipped (commits +
    // pull requests) and the main pane renders the selected commit's detail,
    // mirroring the Diff tab's file-list ↔ diff master-detail layout.
    if (activeTab === "submissions") {
      const sections: PanelSection[] = [
        {
          key: "submission-commits",
          title: t("simulator.replay.diffApp.submissions.commits", "Commits"),
          content: (
            <SubmissionCommitsContent
              commits={submissionCommits}
              selectedCommitSha={
                historySelection?.type === "commit"
                  ? historySelection.commitSha
                  : null
              }
              onCommitSelect={handleSubmissionCommitSelect}
              emptyLabel={t(
                "simulator.replay.diffApp.submissions.noCommits",
                "No Commits yet"
              )}
            />
          ),
          defaultFlexGrow: 2,
          collapsible: true,
          resizable: pullRequestsWithStatus.length > 0,
        },
      ];

      if (pullRequestsWithStatus.length > 0) {
        sections.push({
          key: "submission-prs",
          title: t("simulator.replay.diffApp.submissions.pr", "PR"),
          content: (
            <SubmissionPullRequestsContent
              pullRequests={pullRequestsWithStatus}
              emptyLabel={t(
                "simulator.replay.diffApp.submissions.noPullRequests",
                "No Pull Requests yet"
              )}
            />
          ),
          defaultFlexGrow: 1,
          collapsible: true,
          resizable: false,
        });
      }

      return {
        key: "submissions-sidebar",
        label: t(
          "simulator.replay.diffApp.submissions.tabLabel",
          "Submissions"
        ),
        sections,
      };
    }

    return {
      key: "diff-sidebar",
      label: t("simulator.replay.diffApp.tabLabel", "Diff"),
      sections: [
        {
          key: "diff-list",
          title: t("simulator.replay.diffApp.tabLabel", "Diff"),
          content: (
            <DiffFileNavigationList
              items={sidebarItems}
              selectedEntryId={null}
              selectedPath={historySelection ? null : focusedDiffPath}
              onSelectItem={handleSidebarItemSelect}
              enableDragToInput
            />
          ),
          defaultFlexGrow: 1,
          collapsible: true,
          resizable: false,
        },
      ],
    };
  }, [
    activeTab,
    submissionCommits,
    pullRequestsWithStatus,
    handleSubmissionCommitSelect,
    sidebarItems,
    historySelection,
    focusedDiffPath,
    handleSidebarItemSelect,
    t,
  ]);

  const noopTabChange = useCallback(() => {
    // single-tab shell — no-op
  }, []);

  const primarySidebarConfig = useMemo(
    () =>
      buildPrimarySidebarConfig({
        content: (
          <PrimarySidebarLayoutWithSections
            tabs={[sidebarTab]}
            activeTab={sidebarTab.key}
            onTabChange={noopTabChange}
            hideTabs
          />
        ),
        collapsed: primarySidebarCollapsed,
        size: primarySidebarWidth,
        onSizeChange: handlePrimarySidebarWidthChange,
        minSize: SIMULATOR_PRIMARY_SIDEBAR.minWidth,
        maxSize: SIMULATOR_PRIMARY_SIDEBAR.maxWidth,
        resetSize: SIMULATOR_PRIMARY_SIDEBAR.defaultWidth,
      }),
    [
      sidebarTab,
      noopTabChange,
      primarySidebarCollapsed,
      primarySidebarWidth,
      handlePrimarySidebarWidthChange,
    ]
  );

  useEffect(() => {
    if (historySelection?.type !== "commit") return;
    const detailRepoPath =
      historyRepoContext?.repoPath ?? fallbackRepoContext.repoPath;
    const detailRepoId =
      historyRepoContext?.repoId ??
      fallbackRepoContext.repoId ??
      detailRepoPath;
    logger.info(
      `commit detail context resolved sha=${historySelection.commitSha} repoId=${detailRepoId ?? ""} repoPath=${detailRepoPath ?? ""} ready=${Boolean(detailRepoPath && detailRepoId)}`,
      {
        commitSha: historySelection.commitSha,
        shortSha: historySelection.shortSha,
        commitMessage: historySelection.commitMessage,
        detailRepoId,
        detailRepoPath,
        repoReady: Boolean(detailRepoPath && detailRepoId),
        historyRepoContext,
        fallbackRepoContext,
      }
    );
  }, [historySelection, historyRepoContext, fallbackRepoContext]);

  const detailContent = useMemo(() => {
    if (historySelection?.type === "commit") {
      const detailRepoPath =
        historyRepoContext?.repoPath ?? fallbackRepoContext.repoPath;
      const detailRepoId =
        historyRepoContext?.repoId ??
        fallbackRepoContext.repoId ??
        detailRepoPath;
      const repoReady = Boolean(detailRepoPath && detailRepoId);
      if (!repoReady) {
        return (
          <Placeholder
            variant="empty"
            placement="detail-panel"
            title={historySelection.commitMessage}
            subtitle={historySelection.shortSha}
            fillParentHeight
          />
        );
      }

      return (
        <React.Suspense
          fallback={
            <Placeholder
              variant="loading"
              placement="detail-panel"
              title={tCommon("actions.loading")}
              fillParentHeight
            />
          }
        >
          <GitCommitDetailContent
            repoId={detailRepoId ?? ""}
            repoPath={detailRepoPath ?? ""}
            commitSha={historySelection.commitSha}
            shortSha={historySelection.shortSha}
            commitMessage={historySelection.commitMessage}
            isRepoReady={repoReady}
            publishHeaderToWorkstation={false}
          />
        </React.Suspense>
      );
    }

    if (activeTab === "submissions") {
      // The commits/PR list lives in the sidebar now (master-detail). A
      // selected commit is rendered by the `historySelection` branch above;
      // here we only need the "nothing selected" / "nothing shipped" states.
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t(
            hasSubmissions
              ? "simulator.replay.diffApp.submissions.selectSubmission"
              : "simulator.replay.diffApp.submissions.empty",
            hasSubmissions
              ? "Select a submission to view details"
              : "No submissions yet"
          )}
          fillParentHeight
        />
      );
    }

    return (
      <DiffSectionList
        sections={consolidatedSections}
        loading={orgtrackFinalDiffsLoading}
        emptyTitle={t(
          "simulator.replay.diffApp.emptyForFilter",
          "No diffs yet"
        )}
        focusedPath={focusedDiffPath}
        focusedNonce={focusedDiffNonce}
        collapseSignal={collapseAllSignal}
        collapseThreshold={3}
        hideBottomPadding
      />
    );
  }, [
    historySelection,
    historyRepoContext,
    fallbackRepoContext,
    tCommon,
    activeTab,
    hasSubmissions,
    consolidatedSections,
    orgtrackFinalDiffsLoading,
    focusedDiffPath,
    focusedDiffNonce,
    collapseAllSignal,
    t,
  ]);

  // A commit-detail selection (or a pending navigation request from a chat
  // reference card) must keep the replay shell mounted even when the session
  // itself produced no diffs/submissions — otherwise the navigated commit's
  // detail panel never gets a chance to render.
  const hasActiveCommitDetail =
    historySelection?.type === "commit" ||
    Boolean(diffCommitNavigationRequest?.commitSha);

  if (
    finalDiffCount === 0 &&
    !hasSimulatorDiffs &&
    !hasSubmissions &&
    !hasActiveCommitDetail
  ) {
    return (
      <SimulatorReplayChrome
        tabs={tabs}
        activeEventId={TAB_IDS[activeTab]}
        onTabClick={handleTabClick}
      >
        <div className="min-h-0 flex-1">
          {orgtrackFinalDiffsLoading ? (
            <Placeholder
              variant="loading"
              placement="detail-panel"
              fillParentHeight
            />
          ) : (
            <NoTabsPlaceholder
              icon="editor"
              caption={simulatorAwaitingAgentCaption}
              actions={simulatorPlaceholderActions}
            />
          )}
        </div>
      </SimulatorReplayChrome>
    );
  }

  return (
    <SimulatorReplayChrome
      tabs={tabs}
      activeEventId={TAB_IDS[activeTab]}
      onTabClick={handleTabClick}
    >
      <div className="flex min-h-0 flex-1">
        <WorkStationShell
          primarySidebarConfig={primarySidebarConfig}
          content={
            <div className="flex h-full min-h-0 w-full flex-col">
              {detailContent}
            </div>
          }
          statusBar={null}
          layoutMode={primarySidebarPosition === "right" ? "right" : "left"}
          appClassName="session-replay-diff"
        />
      </div>
    </SimulatorReplayChrome>
  );
};

export { SessionReplayDiff as SimulatorDiff };
export default memo(SessionReplayDiff);
