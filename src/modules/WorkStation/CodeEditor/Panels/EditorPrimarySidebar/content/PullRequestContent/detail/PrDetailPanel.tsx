/**
 * PrDetailPanel
 *
 * GitHub-style tabbed Pull Request detail rendered in the Source Control main
 * pane: a header (status pill · #number title · base←head · open on GitHub) over
 * a Conversation / Commits / Checks / Changes sub-tab bar.
 *
 * Mounts `useWorkstationPrDetail` (which parallel-fetches every source and
 * publishes into `workstationSelectedPrAtom`) and renders each tab from that
 * shared state. Reuses commit-history + issue-timeline formatting throughout.
 */
import { useAtom, useAtomValue } from "jotai";
import {
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Loader,
  XCircle,
} from "lucide-react";
import React, { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { getPrStatusVariant } from "@src/shared/pr/prStatus";
import {
  type PrDetailTab,
  type PrIdentity,
  workstationPrDetailTabAtom,
  workstationSelectedPrAtom,
} from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

import { useWorkstationPrDetail } from "../../../hooks/useWorkstationPrDetail";
import { PrChangesTab } from "./PrChangesTab";
import { PrChecksTab } from "./PrChecksTab";
import { PrCommitsTab } from "./PrCommitsTab";
import { PrConversationTab } from "./PrConversationTab";

interface PrDetailPanelProps {
  identity: PrIdentity;
  repoPath: string;
  repoId?: string;
  onFileSelect?: (path: string) => void;
}

function ChecksStateDot({ state }: { state: string }): React.ReactNode {
  if (state === "success")
    return (
      <CheckCircle2 size={12} strokeWidth={2} className="text-success-6" />
    );
  if (state === "failure")
    return <XCircle size={12} strokeWidth={2} className="text-danger-6" />;
  return (
    <Loader size={12} strokeWidth={2} className="animate-spin text-warning-6" />
  );
}

interface TabDef {
  key: PrDetailTab;
  label: string;
  count?: number;
  badge?: React.ReactNode;
}

export const PrDetailPanel: React.FC<PrDetailPanelProps> = ({
  identity,
  repoPath,
  repoId,
  onFileSelect,
}) => {
  const { t } = useTranslation("common");
  const state = useAtomValue(workstationSelectedPrAtom);
  const [activeTab, setActiveTab] = useAtom(workstationPrDetailTabAtom);

  const { repoFullName, addComment, submitReview, replyInlineComment } =
    useWorkstationPrDetail({
      repoPath,
      repoId,
      pr: identity,
    });

  // Reset to Conversation when switching to a different PR.
  useEffect(() => {
    setActiveTab("conversation");
  }, [identity.number, setActiveTab]);

  const statusVariant = getPrStatusVariant(identity.status);
  const baseBranch =
    state.baseRef ?? identity.baseBranch ?? t("git.pr.baseBranch", "base");

  const tabs: TabDef[] = useMemo(
    () => [
      {
        key: "conversation",
        label: t("git.pr.tabs.conversation", "Conversation"),
        count: state.conversation.length + state.reviews.length,
      },
      {
        key: "commits",
        label: t("git.pr.tabs.commits", "Commits"),
        count: state.commits.length,
      },
      {
        key: "checks",
        label: t("git.pr.tabs.checks", "Checks"),
        badge: state.checks ? (
          <ChecksStateDot state={state.checks.state} />
        ) : undefined,
      },
      {
        key: "changes",
        label: t("git.pr.tabs.changes", "Changes"),
        count: state.files.length,
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-1 px-4 py-2.5">
        <span
          className={`inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium ${statusVariant.badgeClass}`}
        >
          <GitPullRequest size={12} strokeWidth={2} />
          {t(`git.pr.status.${identity.status}`, identity.status)}
        </span>
        <span className="shrink-0 select-text text-[11px] text-text-3">
          #{identity.number}
        </span>
        <span
          className="min-w-0 flex-1 select-text truncate text-[13px] font-medium text-text-1"
          title={identity.title}
        >
          {identity.title}
        </span>
        <span className="hidden shrink-0 items-center gap-1 text-[11px] text-text-3 sm:flex">
          <span className="rounded bg-fill-2 px-1.5 py-0.5">{baseBranch}</span>
          <span>←</span>
          <span className="rounded bg-fill-2 px-1.5 py-0.5">
            {identity.headBranch}
          </span>
        </span>
        <Button
          href={identity.url}
          target="_blank"
          rel="noopener noreferrer"
          variant="tertiary"
          size="small"
          iconOnly
          icon={<ExternalLink size={14} strokeWidth={2} />}
          title={t("actions.openOnGitHub", "Open on GitHub")}
        />
      </div>

      {/* Sub-tab bar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border-1 px-3">
        {tabs.map((tab) => {
          const isActive = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[12px] transition-colors ${
                isActive
                  ? "border-primary-6 font-medium text-text-1"
                  : "border-transparent text-text-3 hover:text-text-1"
              }`}
            >
              <span>{tab.label}</span>
              {tab.badge}
              {tab.count != null && tab.count > 0 ? (
                <span className="rounded-full bg-fill-2 px-1.5 text-[10px] tabular-nums text-text-3">
                  {tab.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Error banner */}
      {state.error ? (
        <div className="text-danger-7 shrink-0 border-b border-border-1 bg-danger-1 px-4 py-1.5 text-[11px]">
          {state.error}
        </div>
      ) : null}

      {/* Active tab */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTab === "conversation" && (
          <PrConversationTab
            detail={state.detail}
            identity={identity}
            conversation={state.conversation}
            reviews={state.reviews}
            reviewComments={state.reviewComments}
            loading={state.loading}
            submittingComment={state.submittingComment}
            submittingReview={state.submittingReview}
            onAddComment={addComment}
            onSubmitReview={submitReview}
          />
        )}
        {activeTab === "commits" && (
          <PrCommitsTab
            commits={state.commits}
            prNumber={identity.number}
            repoPath={repoPath}
            repoId={repoId}
            loading={state.loading}
            onFileSelect={onFileSelect}
          />
        )}
        {activeTab === "checks" && (
          <PrChecksTab checks={state.checks} loading={state.loading} />
        )}
        {activeTab === "changes" && (
          <PrChangesTab
            repoFullName={repoFullName}
            detail={state.detail}
            headSha={state.headSha}
            baseRef={state.baseRef}
            files={state.files}
            loading={state.loading}
            reviewComments={state.reviewComments}
            onFileSelect={onFileSelect}
            onReplyInlineComment={replyInlineComment}
          />
        )}
      </div>
    </div>
  );
};

PrDetailPanel.displayName = "PrDetailPanel";
