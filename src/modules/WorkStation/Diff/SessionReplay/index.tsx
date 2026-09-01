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
 * `TurnMetadataFooter` "Review"/file click still scrolls the cumulative list to
 * the clicked file, but never filters it down to a single round.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { Placeholder } from "@src/components/Placeholder";
import TabPill from "@src/components/TabPill";
import { SIMULATOR_PRIMARY_SIDEBAR } from "@src/config/simulatorPrimarySidebar";
import { simulatorEventsAtom } from "@src/engines/SessionCore/derived/simulatorEvents";
import type { SimulatorAppProps } from "@src/engines/Simulator/apps/core/types";
import { useFileReviewBatchActions } from "@src/hooks/fileReview/useFileReview";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import {
  HugeiconsIcon,
  ListChevronsDownUpIcon,
  MailSend01Icon,
  RotateLeft01Icon,
  WorkflowCircle05Icon,
} from "@src/icons";
import {
  NoTabsPlaceholder,
  SimulatorReplayChrome,
  WorkStationShell,
  buildConsolidatedSessionReplayDiffSectionItems,
  buildPrimarySidebarConfig,
  useSimulatorAwaitingAgentCaption,
  useSimulatorPlaceholderActions,
} from "@src/modules/WorkStation/shared";
import { PrimarySidebarLayoutWithSections } from "@src/modules/WorkStation/shared/PrimarySidebarLayout";
import type { ReplayTab } from "@src/modules/WorkStation/shared/SessionReplay/ReplayTabBar";
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
import { diffViewModeAtom } from "@src/store/workstation/codeEditor";
import type { SourceControlHistorySelection } from "@src/store/workstation/tabs";
import type { DiffViewMode } from "@src/types/git/types";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import { isDiffScopeActive, resolveScopedSelectedPath } from "./diffScope";
import { finalDiffToSection } from "./diffSessionReplay.finalDiffSection";
import {
  getRepoContextFromUnknown,
  getSessionIdFromUnknown,
  hasRepoContext,
  resolveLatestRepoContext,
} from "./diffSessionReplay.repoContext";
import { TAB_BY_ID, TAB_IDS } from "./diffSessionReplay.tabIds";
import { useDiffCommitNavigation } from "./diffSessionReplay.useCommitNavigation";
import { useDiffDetailContent } from "./diffSessionReplay.useDetailContent";
import { useDiffSidebarTab } from "./diffSessionReplay.useSidebarTab";
import type { DiffReplayTab } from "./types";
import { useDiff } from "./useDiff";
import { useSubmissionsData } from "./useSubmissionsData";

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
  const [diffViewMode, setDiffViewMode] = useAtom(diffViewModeAtom);
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
  // `TurnMetadataFooter` does not narrow it to a single round (issue #24); it
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
            <TabPill
              activeTab={diffViewMode}
              tabs={[
                { key: "unified", label: tCommon("workstation.unified") },
                { key: "split", label: tCommon("workstation.split") },
              ]}
              onChange={(key) => setDiffViewMode(key as DiffViewMode)}
              variant="pill"
              color="fill"
              fillWidth={false}
              size="small"
            />
            <div
              className="mx-1.5 h-4 w-px shrink-0 bg-border-2"
              role="separator"
              aria-hidden
            />
            {canUndoAll ? (
              <Button
                htmlType="button"
                variant="tertiary"
                size="small"
                iconOnly
                className="flex-shrink-0"
                onClick={handleUndoAll}
                title={tCommon("actions.undoAll")}
                icon={
                  <HugeiconsIcon
                    icon={RotateLeft01Icon}
                    data-icon="rotate-ccw"
                    size={14}
                  />
                }
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
              icon={
                <HugeiconsIcon
                  icon={ListChevronsDownUpIcon}
                  data-icon="list-chevrons-down-up"
                  size={14}
                />
              }
            />
          </div>
        ) : undefined,
    }),
    [
      activeTab,
      canUndoAll,
      diffViewMode,
      handleCollapseAll,
      handleUndoAll,
      setDiffViewMode,
      tCommon,
    ]
  );

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
        icon: (
          <HugeiconsIcon
            icon={WorkflowCircle05Icon}
            data-icon="git-branch"
            size={14}
            className="shrink-0"
          />
        ),
      },
      {
        eventId: TAB_IDS.submissions,
        kind: "diff-filter",
        label: formatLabel(
          t("simulator.replay.diffApp.submissions.tabLabel"),
          submissionCount
        ),
        title: t("simulator.replay.diffApp.submissions.tabLabel"),
        icon: (
          <HugeiconsIcon
            icon={MailSend01Icon}
            data-icon="send"
            size={14}
            className="shrink-0"
          />
        ),
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

  const { handleSubmissionCommitSelect } = useDiffCommitNavigation({
    sessionId,
    repos,
    fallbackRepoContext,
    diffCommitNavigationRequest,
    setDiffCommitNavigationRequest,
    setActiveTab,
    setHistorySelection,
    setHistoryRepoContext,
  });

  // A chat `TurnMetadataFooter` "Review"/file click switches to the (cumulative)
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

  const sidebarTab = useDiffSidebarTab({
    activeTab,
    submissionCommits,
    pullRequestsWithStatus,
    handleSubmissionCommitSelect,
    sidebarItems,
    historySelection,
    focusedDiffPath,
    setHistorySelection,
    setHistoryRepoContext,
    setFocusedDiffPath,
    setFocusedDiffNonce,
  });

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

  const detailContent = useDiffDetailContent({
    activeTab,
    historySelection,
    historyRepoContext,
    fallbackRepoContext,
    hasSubmissions,
    consolidatedSections,
    orgtrackFinalDiffsLoading,
    focusedDiffPath,
    focusedDiffNonce,
    collapseAllSignal,
    diffViewMode,
  });

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
export { finalDiffToSection } from "./diffSessionReplay.finalDiffSection";
export default memo(SessionReplayDiff);
