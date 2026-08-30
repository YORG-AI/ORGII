/**
 * PrDetailPanel
 *
 * GitHub-style tabbed Pull Request detail rendered in the Source Control main
 * pane with a Conversation / Commits / Checks / Changes tab bar.
 *
 * Mounts `useWorkstationPrDetail` (which parallel-fetches every source and
 * publishes into `workstationSelectedPrAtom`) and renders each tab from that
 * shared state. The Conversation tab gets the GitHub-flow title header, and a
 * Workstation-trail details rail (reviewers / assignees / labels / merge
 * actions) stays beside the content. Reuses commit-history + issue-timeline
 * formatting throughout.
 */
import { useAtom } from "jotai";
import React, { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import InlineBanner, {
  useDismissibleMessage,
} from "@src/components/InlineBanner";
import {
  FileDiffIcon,
  GitCommitHorizontalIcon,
  HugeiconsIcon,
  ListChecksIcon,
  MessageMultiple01Icon,
} from "@src/icons";
import { ExternalBrowserButton } from "@src/modules/WorkStation/shared/ExternalBrowserButton";
import GitHubDetailSkeleton from "@src/modules/shared/components/GitHubDetailSkeleton";
import {
  DetailTabStrip,
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
import { PrFlowHeader } from "./PrFlowHeader";
import { PrSidebar } from "./PrSidebar";
import { formatPrFilesCount } from "./prFilesDisplay";

interface PrDetailPanelProps {
  identity: PrIdentity;
  repoPath: string;
  repoId?: string;
  /** Host-owned actions displayed at the end of the tab strip. */
  tabActions?: React.ReactNode;
  /** Render tabs in the host's header instead of above the panel body. */
  tabsPlacement?: "panel" | "hostHeader";
  onFileSelect?: (path: string) => void;
}

type PrDetailTab = "conversation" | "commits" | "checks" | "changes";

interface PrDetailTabsProps {
  identity: PrIdentity;
  repoPath: string;
  repoId?: string;
  trailing?: React.ReactNode;
  variant?: "row" | "header";
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

/** Shared PR navigation, suitable for either a panel or a host-owned header. */
export const PrDetailTabs: React.FC<PrDetailTabsProps> = ({
  identity,
  repoPath,
  repoId,
  trailing,
  variant = "row",
}) => {
  const { t } = useTranslation("common");
  const scopeKey = workstationPrScopeKey(repoId, repoPath, identity.number);
  const [state, setState] = useAtom(workstationSelectedPrAtomFamily(scopeKey));
  const activeTab = state.viewState.activeTab;
  const tabs = useMemo(
    () => [
      {
        key: "conversation" as const,
        label: t("git.pr.tabs.conversation", "Conversation"),
        icon: (
          <HugeiconsIcon
            icon={MessageMultiple01Icon}
            data-icon="messages-square"
            size={15}
            strokeWidth={1.8}
          />
        ),
        count: state.conversation.length + state.reviews.length,
      },
      {
        key: "commits" as const,
        label: t("git.pr.tabs.commits", "Commits"),
        icon: (
          <HugeiconsIcon
            icon={GitCommitHorizontalIcon}
            data-icon="git-commit-horizontal"
            size={15}
            strokeWidth={1.8}
          />
        ),
        count: state.commits.length,
      },
      {
        key: "checks" as const,
        label: t("git.pr.tabs.checks", "Checks"),
        icon: (
          <HugeiconsIcon
            icon={ListChecksIcon}
            data-icon="list-checks"
            size={15}
            strokeWidth={1.8}
          />
        ),
        count:
          (state.checks?.check_runs.length ?? 0) +
          (state.checks?.statuses.length ?? 0),
      },
      {
        key: "changes" as const,
        label: t("git.pr.changes.title", "Files changed"),
        icon: (
          <HugeiconsIcon
            icon={FileDiffIcon}
            data-icon="file-diff"
            size={15}
            strokeWidth={1.8}
          />
        ),
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

  return (
    <DetailTabStrip<PrDetailTab>
      activeTab={activeTab}
      ariaLabel={t("git.pr.summary.label", "Pull request summary")}
      idPrefix="pr-detail"
      tabs={tabs}
      trailing={trailing}
      variant={variant}
      onChange={(nextTab) => {
        setState((current) => ({
          ...current,
          viewState: {
            ...current.viewState,
            activeTab: nextTab,
          },
        }));
      }}
    />
  );
};

PrDetailTabs.displayName = "PrDetailTabs";

export const PrDetailPanel: React.FC<PrDetailPanelProps> = ({
  identity,
  repoPath,
  repoId,
  tabActions,
  tabsPlacement = "panel",
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

  // The conversation scroll trail shares the details column, sitting under the
  // rail exactly as the session/Work Item trail does.
  const navigationTrail = (
    <div
      className="relative ml-auto min-h-0 w-11 flex-1"
      data-testid="pr-detail-navigation-rail"
    >
      <ScrollTrail
        scrollContainerRef={trailScrollContainerRef}
        contentRef={trailContentRef}
        ariaLabel={t("git.pr.navigationTrail", "Pull request navigation")}
        alignment="start"
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

  if (state.loading || (state.detail === null && state.error === null)) {
    return (
      <GitHubDetailSkeleton
        kind="pr"
        showHeader={false}
        showTabs={tabsPlacement === "panel"}
      />
    );
  }

  return (
    <div className="allow-select-deep flex h-full min-h-0 flex-col overflow-hidden">
      {tabsPlacement === "panel" ? (
        <PrDetailTabs
          identity={identity}
          repoPath={repoPath}
          repoId={repoId}
          trailing={
            tabActions ?? <PrDetailExternalLinkButton identity={identity} />
          }
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
      <div className="flex min-h-0 flex-1 overflow-hidden">
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

        <div
          className={`box-border flex h-full shrink-0 flex-col ${WORKSTATION_TRAIL_RAIL_PADDING_CLASS}`}
          style={{ width: WORKSTATION_TRAIL_WIDTH.expandedPx }}
          data-testid="pr-detail-sidebar-rail"
        >
          {sidebar}
          {activeTab === "conversation" ? navigationTrail : null}
        </div>
      </div>
    </div>
  );
};

PrDetailPanel.displayName = "PrDetailPanel";
