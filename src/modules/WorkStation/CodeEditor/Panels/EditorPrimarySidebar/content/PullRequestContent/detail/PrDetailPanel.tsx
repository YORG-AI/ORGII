/**
 * PrDetailPanel
 *
 * GitHub-style tabbed Pull Request detail rendered in the Source Control main
 * pane: a header (status icon · #number · title) over
 * a Conversation / Commits / Checks / Changes sub-tab bar.
 *
 * Mounts `useWorkstationPrDetail` (which parallel-fetches every source and
 * publishes into `workstationSelectedPrAtom`) and renders each tab from that
 * shared state. The Conversation tab gets the GitHub-flow title header, and a
 * Workstation-trail details rail (reviewers / assignees / labels / merge
 * actions) is always shown: beside the tabs while the body is wide enough,
 * otherwise stacked under the flow title above the description. Reuses
 * commit-history + issue-timeline formatting throughout.
 */
import { useAtom } from "jotai";
import {
  FileDiff,
  GitCommitHorizontal,
  ListChecks,
  MessagesSquare,
} from "lucide-react";
import React, { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import InlineBanner, {
  useDismissibleMessage,
} from "@src/components/InlineBanner";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { useElementDimensions } from "@src/hooks/ui/layout/useElementDimensions";
import { ExternalBrowserButton } from "@src/modules/WorkStation/shared/ExternalBrowserButton";
import GitHubDetailSkeleton from "@src/modules/shared/components/GitHubDetailSkeleton";
import {
  DetailHeaderTabs,
  DetailTabStrip,
  PanelHeader,
  PersistentDetailTabPanel,
  ScrollTrail,
  WORKSTATION_TRAIL_RAIL_PADDING_CLASS,
  WORKSTATION_TRAIL_WIDTH,
} from "@src/modules/shared/layouts/blocks";
import { resolvePullRequestDetailStatus } from "@src/shared/pr/prLevelActions";
import {
  type PrIdentity,
  workstationPrScopeKey,
  workstationSelectedPrAtomFamily,
} from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

import { useWorkstationPrDetail } from "../../../hooks/useWorkstationPrDetail";
import { PrChangesTab } from "./PrChangesTab";
import { PrChecksTab } from "./PrChecksTab";
import { PrCommitsTab } from "./PrCommitsTab";
import { PrConversationTab } from "./PrConversationTab";
import { PrDetailHeaderContent } from "./PrDetailHeaderContent";
import { PrFlowHeader } from "./PrFlowHeader";
import { PrSidebar } from "./PrSidebar";
import { formatPrFilesCount } from "./prFilesDisplay";

export { PrDetailHeaderContent } from "./PrDetailHeaderContent";

/**
 * Body width below which the details rail stops being a second column. The
 * rail is 256px plus its gutter, so anything narrower leaves the conversation
 * column too cramped to read comfortably.
 */
const PR_DETAIL_TWO_COLUMN_WIDTH = 820;

interface PrDetailPanelProps {
  identity: PrIdentity;
  repoPath: string;
  repoId?: string;
  /** Host-owned action group replacing the default GitHub link action. */
  headerActions?: React.ReactNode;
  /** Optional host-specific header spacing and surface overrides. */
  headerClassName?: string;
  /**
   * Render the internal status·#number·title header row. Set false
   * when the host publishes this info elsewhere (e.g. the My Station PR tab
   * lifts it into the 40px tab-header strip via {@link PrDetailHeaderContent}).
   */
  showHeader?: boolean;
  /** Place the title and detail tabs together in the same 40px header row. */
  combineHeaderAndTabs?: boolean;
  onFileSelect?: (path: string) => void;
}

export function PrDetailExternalLinkButton({
  identity,
  title,
}: {
  identity: PrIdentity;
  title?: string;
}): React.ReactNode {
  return <ExternalBrowserButton href={identity.url} label={title} />;
}

export const PrDetailPanel: React.FC<PrDetailPanelProps> = ({
  identity,
  repoPath,
  repoId,
  headerActions,
  headerClassName,
  showHeader = true,
  combineHeaderAndTabs = false,
  onFileSelect,
}) => {
  const { t } = useTranslation("common");
  const tabContentRef = useRef<HTMLDivElement>(null);
  const trailScrollContainerRef = useRef<HTMLElement>(null);
  const trailContentRef = useRef<HTMLElement>(null);
  const scopeKey = workstationPrScopeKey(repoId, repoPath, identity.number);
  const [state, setState] = useAtom(workstationSelectedPrAtomFamily(scopeKey));
  const detailViewState = state.viewState;
  const setDetailViewState = useCallback(
    (
      update: (current: typeof detailViewState) => typeof detailViewState
    ): void => {
      setState((current) => ({
        ...current,
        viewState: update(current.viewState),
      }));
    },
    [setState]
  );
  const activeTab = detailViewState.activeTab;
  const setActiveTab = useCallback(
    (nextTab: typeof activeTab) => {
      setDetailViewState((current) => ({
        ...current,
        activeTab: nextTab,
      }));
    },
    [setDetailViewState]
  );
  const setConversationDraft = useCallback(
    (conversationDraft: string) => {
      setDetailViewState((current) => ({
        ...current,
        conversationDraft,
      }));
    },
    [setDetailViewState]
  );
  const setSelectedCommitSha = useCallback(
    (selectedCommitSha: string | null) => {
      setDetailViewState((current) => ({
        ...current,
        selectedCommitSha,
      }));
    },
    [setDetailViewState]
  );
  const setSelectedChangedFilePath = useCallback(
    (selectedChangedFilePath: string | null) => {
      setDetailViewState((current) => ({
        ...current,
        selectedChangedFilePath,
      }));
    },
    [setDetailViewState]
  );
  const setTabContentNode = useCallback((node: HTMLDivElement | null) => {
    tabContentRef.current = node;
  }, []);
  const setConversationScrollNode = useCallback(
    (node: HTMLDivElement | null) => {
      trailScrollContainerRef.current = node ?? tabContentRef.current;
    },
    []
  );
  const setConversationContentNode = useCallback(
    (node: HTMLDivElement | null) => {
      trailContentRef.current = node ?? tabContentRef.current;
    },
    []
  );

  const {
    repoFullName,
    addComment,
    submitReview,
    replyInlineComment,
    mergePullRequest,
    setPullRequestAutoMerge,
    updatePullRequestDraft,
    updatePullRequestState,
    updateRequestedReviewers,
    updateAssignees,
    updateLabels,
    loadReviewerCandidates,
    reviewerCandidates,
    assigneeCandidates,
    loadingReviewerCandidates,
    reviewerCandidatesError,
    loadLabelCandidates,
    labelCandidates,
    loadingLabelCandidates,
    labelCandidatesError,
    prActionPending,
  } = useWorkstationPrDetail({
    repoPath,
    repoId,
    pr: identity,
  });

  const currentIdentity = useMemo(
    () => ({
      ...identity,
      status: resolvePullRequestDetailStatus(state.detail, identity.status),
    }),
    [identity, state.detail]
  );

  const { visibleMessage: visibleError, dismiss: dismissError } =
    useDismissibleMessage(state.error);

  // The details rail is always present. It is the right-hand column while the
  // body can spare the width, and stacks under the flow title (above the
  // description) once two columns would squeeze the conversation.
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyWidth = useElementDimensions(bodyRef, { dimension: "width" });
  const stackSidebar = bodyWidth > 0 && bodyWidth < PR_DETAIL_TWO_COLUMN_WIDTH;
  // The conversation scroll trail shares the details column, sitting under the
  // rail exactly as the session/Work Item trail does.
  const navigationTrail = (
    <div
      className={
        stackSidebar
          ? "relative w-11 shrink-0"
          : "relative ml-auto min-h-0 w-11 flex-1"
      }
      data-testid="pr-detail-navigation-rail"
    >
      <ScrollTrail
        scrollContainerRef={trailScrollContainerRef}
        contentRef={trailContentRef}
        ariaLabel={t("git.pr.navigationTrail", "Pull request navigation")}
        alignment={stackSidebar ? "center" : "start"}
        placement="rail"
        testId="pr-detail-navigation-trail"
      />
    </div>
  );
  const sidebar = (
    <PrSidebar
      identity={currentIdentity}
      detail={state.detail}
      checks={state.checks}
      reviews={state.reviews}
      disabled={!repoFullName}
      pending={prActionPending}
      reviewerCandidates={reviewerCandidates}
      loadingReviewerCandidates={loadingReviewerCandidates}
      reviewerCandidatesError={reviewerCandidatesError}
      onLoadReviewerCandidates={loadReviewerCandidates}
      onMerge={mergePullRequest}
      onSetAutoMerge={setPullRequestAutoMerge}
      onDraftChange={updatePullRequestDraft}
      onStateChange={updatePullRequestState}
      onRequestedReviewersChange={updateRequestedReviewers}
      assigneeCandidates={assigneeCandidates}
      onAssigneesChange={updateAssignees}
      labelCandidates={labelCandidates}
      loadingLabelCandidates={loadingLabelCandidates}
      labelCandidatesError={labelCandidatesError}
      onLoadLabelCandidates={loadLabelCandidates}
      onLabelsChange={updateLabels}
    />
  );

  const baseBranch =
    state.baseRef ?? identity.baseBranch ?? t("git.pr.baseBranch", "base");

  const tabs = useMemo(
    () => [
      {
        key: "conversation" as const,
        label: t("git.pr.tabs.conversation", "Conversation"),
        icon: <MessagesSquare size={15} strokeWidth={1.8} />,
        count: state.conversation.length + state.reviews.length,
      },
      {
        key: "commits" as const,
        label: t("git.pr.tabs.commits", "Commits"),
        icon: <GitCommitHorizontal size={15} strokeWidth={1.8} />,
        count: state.commits.length,
      },
      {
        key: "checks" as const,
        label: t("git.pr.tabs.checks", "Checks"),
        icon: <ListChecks size={15} strokeWidth={1.8} />,
        count:
          (state.checks?.check_runs.length ?? 0) +
          (state.checks?.statuses.length ?? 0),
      },
      {
        key: "changes" as const,
        label: t("git.pr.changes.title", "Files changed"),
        icon: <FileDiff size={15} strokeWidth={1.8} />,
        count: formatPrFilesCount(state.files.length),
      },
    ],
    [
      t,
      state.conversation.length,
      state.reviews.length,
      state.commits.length,
      state.checks,
      state.files.length,
    ]
  );

  if (state.loading || (state.detail === null && state.error === null)) {
    return <GitHubDetailSkeleton kind="pr" showHeader={showHeader} />;
  }

  return (
    <div className="allow-select-deep flex h-full min-h-0 flex-col overflow-hidden @container/detailheader">
      {/* Header */}
      {showHeader ? (
        <PanelHeader
          className={`${headerClassName ?? DETAIL_PANEL_TOKENS.headerPadding} ${
            combineHeaderAndTabs
              ? "!h-auto [&>div:last-child]:mt-1.5 [&>div:last-child]:self-start @[960px]/detailheader:[&>div:last-child]:mt-0 @[960px]/detailheader:[&>div:last-child]:self-auto"
              : ""
          }`.trim()}
          dataTestId="pr-detail-header"
          borderBottom={combineHeaderAndTabs}
          actions={
            headerActions ?? <PrDetailExternalLinkButton identity={identity} />
          }
        >
          {combineHeaderAndTabs ? (
            <DetailHeaderTabs
              title={<PrDetailHeaderContent identity={currentIdentity} />}
              stackTabsBelow
              tabs={
                <DetailTabStrip
                  activeTab={activeTab}
                  ariaLabel={t("git.pr.summary.label", "Pull request summary")}
                  idPrefix="pr-detail"
                  tabs={tabs}
                  onChange={setActiveTab}
                  variant="header"
                />
              }
            />
          ) : (
            <PrDetailHeaderContent identity={currentIdentity} />
          )}
        </PanelHeader>
      ) : null}

      {/* GitHub-style PR navigation */}
      {!combineHeaderAndTabs || !showHeader ? (
        <DetailTabStrip
          activeTab={activeTab}
          ariaLabel={t("git.pr.summary.label", "Pull request summary")}
          idPrefix="pr-detail"
          tabs={tabs}
          onChange={setActiveTab}
        />
      ) : null}

      {/* A background reconcile clears `state.error` as soon as it succeeds, so
          the strip holds the message until the reader dismisses it. */}
      {visibleError ? (
        <InlineBanner onDismiss={dismissError} dataTestId="pr-detail-error">
          {visibleError}
        </InlineBanner>
      ) : null}

      {/* Detail tabs mount lazily, then remain mounted to preserve view state. */}
      <div ref={bodyRef} className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <PersistentDetailTabPanel
            active={activeTab === "conversation"}
            id="pr-detail-tabpanel-conversation"
            ariaLabelledBy="pr-detail-tab-conversation"
            className="min-w-0 overflow-hidden"
          >
            <div
              ref={setTabContentNode}
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            >
              <PrConversationTab
                flowHeader={
                  <PrFlowHeader
                    identity={currentIdentity}
                    detail={state.detail}
                    baseBranch={baseBranch}
                    commitCount={state.commits.length}
                    files={state.files}
                  />
                }
                sidebar={stackSidebar ? sidebar : undefined}
                detail={state.detail}
                identity={currentIdentity}
                conversation={state.conversation}
                reviews={state.reviews}
                reviewComments={state.reviewComments}
                loading={state.loading}
                submittingComment={state.submittingComment}
                submittingReview={state.submittingReview}
                draft={detailViewState.conversationDraft}
                onDraftChange={setConversationDraft}
                onAddComment={addComment}
                onSubmitReview={submitReview}
                trailScrollContainerRef={setConversationScrollNode}
                trailContentRef={setConversationContentNode}
              />
            </div>
            {/* Without a rail column of its own, the trail keeps its own
                narrow column beside the conversation. */}
            {stackSidebar ? navigationTrail : null}
          </PersistentDetailTabPanel>

          <PersistentDetailTabPanel
            active={activeTab === "commits"}
            id="pr-detail-tabpanel-commits"
            ariaLabelledBy="pr-detail-tab-commits"
            className="min-w-0 flex-col overflow-hidden"
          >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <PrCommitsTab
                commits={state.commits}
                prNumber={identity.number}
                repoPath={repoPath}
                repoId={repoId}
                loading={state.loading}
                checks={state.checks}
                selectedCommitSha={detailViewState.selectedCommitSha}
                onSelectedCommitShaChange={setSelectedCommitSha}
                onFileSelect={onFileSelect}
              />
            </div>
          </PersistentDetailTabPanel>

          <PersistentDetailTabPanel
            active={activeTab === "checks"}
            id="pr-detail-tabpanel-checks"
            ariaLabelledBy="pr-detail-tab-checks"
            className="min-w-0 flex-col overflow-hidden"
          >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <PrChecksTab checks={state.checks} loading={state.loading} />
            </div>
          </PersistentDetailTabPanel>

          <PersistentDetailTabPanel
            active={activeTab === "changes"}
            id="pr-detail-tabpanel-changes"
            ariaLabelledBy="pr-detail-tab-changes"
            className="min-w-0 flex-col overflow-hidden"
          >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <PrChangesTab
                repoFullName={repoFullName}
                detail={state.detail}
                headSha={state.headSha}
                baseRef={state.baseRef}
                files={state.files}
                loading={state.loading}
                reviewComments={state.reviewComments}
                selectedFilePath={detailViewState.selectedChangedFilePath}
                onSelectedFilePathChange={setSelectedChangedFilePath}
                onFileSelect={onFileSelect}
                onReplyInlineComment={replyInlineComment}
              />
            </div>
          </PersistentDetailTabPanel>
        </div>

        {/* Details rail — the GitHub-style operations sidebar on the shared
            Workstation trail surface, beside every tab while the body is wide
            enough. Narrower bodies stack it under the flow title instead. */}
        {!stackSidebar ? (
          <div
            className={`box-border flex h-full shrink-0 flex-col ${WORKSTATION_TRAIL_RAIL_PADDING_CLASS}`}
            style={{ width: WORKSTATION_TRAIL_WIDTH.expandedPx }}
            data-testid="pr-detail-sidebar-rail"
          >
            {sidebar}
            {activeTab === "conversation" ? navigationTrail : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};

PrDetailPanel.displayName = "PrDetailPanel";
