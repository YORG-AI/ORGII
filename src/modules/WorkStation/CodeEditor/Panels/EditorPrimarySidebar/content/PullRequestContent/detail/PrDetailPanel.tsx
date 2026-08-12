/**
 * PrDetailPanel
 *
 * GitHub-style tabbed Pull Request detail rendered in the Source Control main
 * pane: a header (status icon · #number · title) over
 * a Conversation / Commits / Checks / Changes sub-tab bar.
 *
 * Mounts `useWorkstationPrDetail` (which parallel-fetches every source and
 * publishes into `workstationSelectedPrAtom`) and renders each tab from that
 * shared state. Reuses commit-history + issue-timeline formatting throughout.
 */
import { useAtom } from "jotai";
import {
  CheckCircle2,
  ChevronRight,
  CircleDot,
  CircleUserRound,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  ListChecks,
  MessageCircle,
  MessagesSquare,
} from "lucide-react";
import React, { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  type GitHubChecksSummary,
  type GitHubPrReview,
  type PrFile,
} from "@src/api/tauri/github";
import Avatar from "@src/components/Avatar";
import Button from "@src/components/Button";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import GitHubDetailSkeleton from "@src/modules/shared/components/GitHubDetailSkeleton";
import {
  DetailHeaderTabs,
  DetailTabStrip,
  PanelHeader,
  PersistentDetailTabPanel,
  ScrollTrail,
} from "@src/modules/shared/layouts/blocks";
import { resolvePullRequestDetailStatus } from "@src/shared/pr/prLevelActions";
import { getPrStatusVariant } from "@src/shared/pr/prStatus";
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
import { PrDetailHeaderContent, PrStatusIcon } from "./PrDetailHeaderContent";
import { PrLevelActions } from "./PrLevelActions";
import { formatPrFilesCount } from "./prFilesDisplay";

export { PrDetailHeaderContent } from "./PrDetailHeaderContent";

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

interface PrSummaryReviewer {
  login: string;
  avatarUrl: string;
}

export function PrDetailExternalLinkButton({
  identity,
  title = "Open on GitHub",
}: {
  identity: PrIdentity;
  title?: string;
}): React.ReactNode {
  return (
    <Button
      href={identity.url}
      target="_blank"
      rel="noopener noreferrer"
      variant="tertiary"
      size="small"
      iconOnly
      icon={<Globe size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />}
      title={title}
      aria-label={title}
    />
  );
}

function readNumber(
  detail: Record<string, unknown> | null,
  key: string
): number | null {
  const value = detail?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRequestedReviewers(
  detail: Record<string, unknown> | null
): PrSummaryReviewer[] {
  const value = detail?.requested_reviewers;
  if (!Array.isArray(value)) return [];
  return value.flatMap((reviewer) => {
    if (!reviewer || typeof reviewer !== "object") return [];
    const record = reviewer as Record<string, unknown>;
    if (typeof record.login !== "string" || !record.login) return [];
    return [
      {
        login: record.login,
        avatarUrl:
          typeof record.avatar_url === "string" ? record.avatar_url : "",
      },
    ];
  });
}

function collectReviewers(
  detail: Record<string, unknown> | null,
  reviews: GitHubPrReview[]
): PrSummaryReviewer[] {
  const unique = new Map<string, PrSummaryReviewer>();
  for (const reviewer of readRequestedReviewers(detail)) {
    unique.set(reviewer.login, reviewer);
  }
  for (const review of reviews) {
    if (!review.user.login) continue;
    unique.set(review.user.login, {
      login: review.user.login,
      avatarUrl: review.user.avatar_url,
    });
  }
  return [...unique.values()];
}

function checksLabel(
  checks: GitHubChecksSummary | null,
  t: (key: string, fallback: string) => string
): string {
  const count =
    (checks?.check_runs.length ?? 0) + (checks?.statuses.length ?? 0);
  if (count === 0) return t("git.pr.summary.noChecks", "No CI checks");
  if (checks?.state === "success") {
    return t("git.pr.checks.allPassed", "All checks passed");
  }
  if (checks?.state === "failure") {
    return t("git.pr.summary.checksFailed", "Checks failed");
  }
  return t("git.pr.checks.pending", "Checks in progress");
}

interface PrDetailSummaryProps {
  identity: PrIdentity;
  baseBranch: string;
  detail: Record<string, unknown> | null;
  conversationCount: number;
  reviews: GitHubPrReview[];
  files: PrFile[];
  checks: GitHubChecksSummary | null;
}

export function PrDetailSummary({
  identity,
  baseBranch,
  detail,
  conversationCount,
  reviews,
  files,
  checks,
}: PrDetailSummaryProps): React.ReactNode {
  const { t } = useTranslation("common");
  const reviewers = collectReviewers(detail, reviews);
  const additions =
    readNumber(detail, "additions") ??
    files.reduce((total, file) => total + file.additions, 0);
  const deletions =
    readNumber(detail, "deletions") ??
    files.reduce((total, file) => total + file.deletions, 0);
  const commentCount = readNumber(detail, "comments") ?? conversationCount;
  const statusColorClass = getPrStatusVariant(identity.status).textClass;

  return (
    <section
      data-testid="pr-detail-summary"
      aria-label={t("git.pr.summary.label", "Pull request summary")}
    >
      <div
        className={`${DETAIL_PANEL_TOKENS.headerWidth} grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 px-6 pt-4 text-[13px]`}
      >
        <div className="flex items-center gap-2 text-text-3">
          <GitBranch size={14} strokeWidth={1.75} />
          <span>{t("git.pr.summary.branch", "Branch")}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-text-1">
          <span className="max-w-full truncate" title={identity.headBranch}>
            {identity.headBranch}
          </span>
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            className="shrink-0 text-text-3"
          />
          <span className="shrink-0">{baseBranch}</span>
          <span className="shrink-0 tabular-nums text-success-6">
            +{additions.toLocaleString("en-US")}
          </span>
          <span className="shrink-0 tabular-nums text-danger-6">
            -{deletions.toLocaleString("en-US")}
          </span>
        </div>

        <div className="flex items-center gap-2 text-text-3">
          <CircleUserRound size={14} strokeWidth={1.75} />
          <span>{t("git.pr.summary.reviewers", "Reviewers")}</span>
        </div>
        <div
          className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-text-1"
          data-testid="pr-summary-reviewers"
        >
          {reviewers.length > 0 ? (
            <>
              {reviewers.slice(0, 5).map((reviewer) => (
                <span
                  key={reviewer.login}
                  className="inline-flex min-w-0 items-center gap-1.5"
                  title={reviewer.login}
                >
                  <Avatar size={20} src={reviewer.avatarUrl} />
                  <span className="truncate">{reviewer.login}</span>
                </span>
              ))}
              {reviewers.length > 5 ? (
                <span className="text-[11px] text-text-3">
                  +{reviewers.length - 5}
                </span>
              ) : null}
            </>
          ) : (
            <span>{t("git.pr.summary.noReviewers", "No reviewers")}</span>
          )}
        </div>

        <div className="flex items-center gap-2 text-text-3">
          <MessageCircle size={14} strokeWidth={1.75} />
          <span>{t("git.pr.summary.comments", "Comments")}</span>
        </div>
        <div className="text-text-1">
          {t("git.pr.summary.commentCount", {
            count: commentCount,
            defaultValue: "{{count}} comment",
            defaultValue_other: "{{count}} comments",
          })}
        </div>

        <div className="flex items-center gap-2 text-text-3">
          <CheckCircle2 size={14} strokeWidth={1.75} />
          <span>{t("git.pr.summary.checks", "Checks")}</span>
        </div>
        <div className="text-text-1">{checksLabel(checks, t)}</div>

        <div
          className="flex items-center gap-2 text-text-3"
          data-testid="pr-summary-status-label"
        >
          <CircleDot size={14} strokeWidth={1.75} />
          <span>{t("git.pr.summary.status", "Status")}</span>
        </div>
        <div
          className={`inline-flex items-center gap-1 capitalize ${statusColorClass}`}
          data-testid="pr-summary-status"
        >
          <PrStatusIcon status={identity.status} />
          <span>{identity.status}</span>
        </div>
      </div>
    </section>
  );
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
    updatePullRequestState,
    updateRequestedReviewers,
    loadReviewerCandidates,
    reviewerCandidates,
    loadingReviewerCandidates,
    reviewerCandidatesError,
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
    <div className="allow-select-deep flex h-full min-h-0 flex-col overflow-hidden">
      {/* Header */}
      {showHeader ? (
        <PanelHeader
          className={headerClassName ?? DETAIL_PANEL_TOKENS.headerPadding}
          dataTestId="pr-detail-header"
          borderBottom={combineHeaderAndTabs}
          actions={
            headerActions ?? (
              <PrDetailExternalLinkButton
                identity={identity}
                title={t("actions.openOnGitHub", "Open on GitHub")}
              />
            )
          }
        >
          {combineHeaderAndTabs ? (
            <DetailHeaderTabs
              title={<PrDetailHeaderContent identity={currentIdentity} />}
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

      {/* Error banner */}
      {state.error ? (
        <div className="text-danger-7 shrink-0 border-b border-border-1 bg-danger-1 px-4 py-1.5 text-[11px]">
          {state.error}
        </div>
      ) : null}

      {/* Detail tabs mount lazily, then remain mounted to preserve view state. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
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
              levelActions={
                <PrLevelActions
                  identity={currentIdentity}
                  detail={state.detail}
                  checks={state.checks}
                  disabled={!repoFullName}
                  pending={prActionPending}
                  reviewerCandidates={reviewerCandidates}
                  loadingReviewerCandidates={loadingReviewerCandidates}
                  reviewerCandidatesError={reviewerCandidatesError}
                  onLoadReviewerCandidates={loadReviewerCandidates}
                  onMerge={mergePullRequest}
                  onSetAutoMerge={setPullRequestAutoMerge}
                  onStateChange={updatePullRequestState}
                  onRequestedReviewersChange={updateRequestedReviewers}
                />
              }
              summary={
                <PrDetailSummary
                  identity={currentIdentity}
                  baseBranch={baseBranch}
                  detail={state.detail}
                  conversationCount={state.conversation.length}
                  reviews={state.reviews}
                  files={state.files}
                  checks={state.checks}
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
          <div
            className="relative w-11 shrink-0"
            data-testid="pr-detail-navigation-rail"
          >
            <ScrollTrail
              scrollContainerRef={trailScrollContainerRef}
              contentRef={trailContentRef}
              ariaLabel={t("git.pr.navigationTrail", "Pull request navigation")}
              placement="rail"
              testId="pr-detail-navigation-trail"
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
    </div>
  );
};

PrDetailPanel.displayName = "PrDetailPanel";
