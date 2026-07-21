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
import { ArrowUpRight, GitPullRequest } from "lucide-react";
import React, { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import IntegrationIcon from "@src/components/IntegrationIcon";
import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { getPrStatusVariant } from "@src/shared/pr/prStatus";
import {
  type PrDetailTab,
  type PrIdentity,
  workstationPrDetailTabAtomFamily,
  workstationPrScopeKey,
  workstationSelectedPrAtomFamily,
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
  /**
   * Render the internal status·#number·title·base←head header row. Set false
   * when the host publishes this info elsewhere (e.g. the My Station PR tab
   * lifts it into the 40px tab-header strip via {@link PrDetailHeaderContent}).
   */
  showHeader?: boolean;
  onFileSelect?: (path: string) => void;
}

/**
 * The inner status pill · #number · title · base←head content of the PR detail
 * header. Extracted so both the panel's own header and the My Station PR tab's
 * 40px strip render the same thing. Callers provide the flex/padding wrapper.
 */
export function PrDetailHeaderContent({
  identity,
  baseBranch,
}: {
  identity: PrIdentity;
  baseBranch: string;
}): React.ReactNode {
  const { t } = useTranslation("common");
  const statusVariant = getPrStatusVariant(identity.status);

  return (
    <>
      <IntegrationIcon
        type="github"
        size={HEADER_ICON_SIZE.sm}
        className="shrink-0"
      />
      <span
        className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium ${statusVariant.badgeClass}`}
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
      {baseBranch ? (
        <span className="hidden shrink-0 items-center gap-1 text-[11px] text-text-3 sm:flex">
          <span className="rounded bg-fill-2 px-1.5 py-0.5">{baseBranch}</span>
          <span>←</span>
          <span className="rounded bg-fill-2 px-1.5 py-0.5">
            {identity.headBranch}
          </span>
        </span>
      ) : null}
    </>
  );
}

export const PrDetailPanel: React.FC<PrDetailPanelProps> = ({
  identity,
  repoPath,
  repoId,
  showHeader = true,
  onFileSelect,
}) => {
  const { t } = useTranslation("common");
  const scopeKey = workstationPrScopeKey(repoId, repoPath, identity.number);
  const state = useAtomValue(workstationSelectedPrAtomFamily(scopeKey));
  const [activeTab, setActiveTab] = useAtom(
    workstationPrDetailTabAtomFamily(scopeKey)
  );

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

  const baseBranch =
    state.baseRef ?? identity.baseBranch ?? t("git.pr.baseBranch", "base");

  const tabs: TabPillItem[] = useMemo(
    () => [
      {
        key: "conversation",
        label: t("git.pr.tabs.conversation", "Conversation"),
        badge:
          state.conversation.length + state.reviews.length > 0 ? (
            <span className="rounded-full bg-fill-2 px-1.5 text-[10px] tabular-nums text-text-3">
              {state.conversation.length + state.reviews.length}
            </span>
          ) : undefined,
      },
      {
        key: "changes",
        label: t("git.pr.tabs.changes", "Changes"),
        badge:
          state.files.length > 0 ? (
            <span className="rounded-full bg-fill-2 px-1.5 text-[10px] tabular-nums text-text-3">
              {state.files.length}
            </span>
          ) : undefined,
      },
      {
        key: "commits",
        label: t("git.pr.tabs.commits", "Commits"),
        badge:
          state.commits.length > 0 ? (
            <span className="rounded-full bg-fill-2 px-1.5 text-[10px] tabular-nums text-text-3">
              {state.commits.length}
            </span>
          ) : undefined,
      },
      {
        key: "checks",
        label: t("git.pr.tabs.checks", "Checks"),
      },
    ],
    [
      t,
      state.conversation.length,
      state.reviews.length,
      state.commits.length,
      state.files.length,
    ]
  );

  if (state.loading) {
    return (
      <Placeholder
        variant="loading"
        placement="detail-panel"
        fillParentHeight
      />
    );
  }

  return (
    <div className="allow-select-deep flex h-full min-h-0 flex-col overflow-hidden">
      {/* Header */}
      {showHeader ? (
        <div className="flex shrink-0 items-center gap-2 px-4 py-2.5">
          <PrDetailHeaderContent identity={identity} baseBranch={baseBranch} />
        </div>
      ) : null}

      {/* Sub-tab bar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border-1 py-1 pl-3 pr-2">
        <TabPill
          tabs={tabs}
          activeTab={activeTab}
          onChange={(key) => setActiveTab(key as PrDetailTab)}
          variant="pill"
          fillWidth={false}
          size="small"
          buttonStyle
          height={28}
        />
        <a
          href={identity.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
          aria-label={t("actions.openOnGitHub", "Open on GitHub")}
          title={t("actions.openOnGitHub", "Open on GitHub")}
        >
          <ArrowUpRight size={14} strokeWidth={2} />
        </a>
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
