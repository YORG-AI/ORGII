import React from "react";
import { useTranslation } from "react-i18next";

import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { HugeiconsIcon, LinkSquare02Icon } from "@src/icons";
import { IssueDetailPanel } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel";
import { ExternalBrowserButton } from "@src/modules/WorkStation/shared/ExternalBrowserButton";
import DetailHeaderIconAction from "@src/modules/shared/components/DetailHeaderIconAction";
import GitHubDetailSkeleton from "@src/modules/shared/components/GitHubDetailSkeleton";
import GitHubIssueHeaderContent from "@src/modules/shared/components/GitHubIssueHeaderContent";
import GitHubPrDetailTabs from "@src/modules/shared/components/GitHubPrDetailTabs";
import { useGitHubIssueDetailState } from "@src/modules/shared/hooks/useGitHubIssueDetailState";
import DetailPaneLayout, {
  DetailPaneCloseAction,
  DetailPanePlaceholder,
} from "@src/modules/shared/layouts/DetailPaneLayout";
import { normalizePrStatus } from "@src/shared/pr/prStatus";
import { workstationIssueDetailScopeKey } from "@src/store/workstation/codeEditor/workstationIssueAtom";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

import {
  GITHUB_ITEM_KIND,
  type ManagedGitHubItem,
  type ManagedIssueItem,
  type ManagedPrItem,
} from "./githubManagedItemModel";

const PullRequestDetailPanel = React.lazy(() =>
  import("@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrDetailPanel").then(
    (module) => ({ default: module.PrDetailPanel })
  )
);

interface GitHubWorkItemDetailPaneProps {
  selectedItem: ManagedGitHubItem | null;
  onOpenIssueInNewTab: (issue: ManagedIssueItem) => void;
  onOpenPrInNewTab: (pullRequest: ManagedPrItem) => void;
  onClose: () => void;
}

function OpenInNewTabAction({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation("common");
  return (
    <DetailHeaderIconAction
      label={t("actions.openInNewTab")}
      icon={
        <HugeiconsIcon
          icon={LinkSquare02Icon}
          data-icon="link-square-02"
          size={HEADER_ICON_SIZE.sm}
          strokeWidth={1.75}
          aria-hidden
        />
      }
      onClick={onClick}
      testId="work-management-open-in-new-tab"
    />
  );
}

function DetailActions({
  href,
  onOpenInNewTab,
  onClose,
}: {
  href: string;
  onOpenInNewTab: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-px"
      data-testid="work-management-detail-actions"
    >
      <ExternalBrowserButton
        href={href}
        dataTestId="work-management-open-in-browser"
      />
      <OpenInNewTabAction onClick={onOpenInNewTab} />
      <DetailPaneCloseAction
        onClose={onClose}
        testId="work-management-close-detail"
      />
    </div>
  );
}

function IssueDetail({
  item,
  onOpenInNewTab,
  onClose,
}: {
  item: ManagedIssueItem;
  onOpenInNewTab: () => void;
  onClose: () => void;
}) {
  const stateScopeKey = workstationIssueDetailScopeKey(item.repoPath, item.id);
  const { selectedState, interaction, assigneeConfig } =
    useGitHubIssueDetailState({
      issueNumber: item.id,
      repoPath: item.repoPath,
      remoteUrl: item.remoteUrl,
      stateScopeKey,
      authScope: item.authScope ?? undefined,
      viewerLogin: item.viewerLogin,
      repoPermissions: item.repoPermissions,
    });
  const issue = selectedState.issue;

  return (
    <DetailPaneLayout
      testId="work-management-github-issue-detail-pane"
      header={{
        children: <GitHubIssueHeaderContent issue={issue ?? item.rawIssue} />,
        actions: (
          <DetailActions
            href={(issue ?? item.rawIssue).html_url}
            onOpenInNewTab={onOpenInNewTab}
            onClose={onClose}
          />
        ),
      }}
    >
      {selectedState.error && !issue ? (
        <DetailPanePlaceholder variant="error" subtitle={selectedState.error} />
      ) : !issue || selectedState.loading ? (
        <GitHubDetailSkeleton kind="issue" showHeader={false} />
      ) : (
        <IssueDetailPanel
          issue={issue}
          timeline={selectedState.timeline}
          timelineLoading={selectedState.timelineLoading}
          interaction={interaction}
          showHeader={false}
          assigneeConfig={assigneeConfig}
        />
      )}
    </DetailPaneLayout>
  );
}

function PullRequestDetail({
  item,
  onOpenInNewTab,
  onClose,
}: {
  item: ManagedPrItem;
  onOpenInNewTab: () => void;
  onClose: () => void;
}) {
  const identity: PrIdentity = {
    number: item.id,
    title: item.title,
    url: item.rawPr.url,
    status: normalizePrStatus({
      state: item.state,
      merged: item.state === "merged",
      draft: item.rawPr.draft,
    }),
    headBranch: item.sourceBranch,
    baseBranch: item.targetBranch,
  };
  const actions = (
    <DetailActions
      href={identity.url}
      onOpenInNewTab={onOpenInNewTab}
      onClose={onClose}
    />
  );

  return (
    <DetailPaneLayout testId="work-management-github-pr-detail-pane">
      <React.Suspense
        fallback={
          <GitHubDetailSkeleton
            kind="pr"
            showHeader={false}
            title={identity.title}
            number={identity.number}
            tabs={<GitHubPrDetailTabs trailing={actions} />}
          />
        }
      >
        <PullRequestDetailPanel
          identity={identity}
          repoPath={item.repoPath}
          repoId={item.repoId}
          tabActions={actions}
        />
      </React.Suspense>
    </DetailPaneLayout>
  );
}

const GitHubWorkItemDetailPane: React.FC<GitHubWorkItemDetailPaneProps> = ({
  selectedItem,
  onOpenIssueInNewTab,
  onOpenPrInNewTab,
  onClose,
}) => {
  const { t } = useTranslation("common");
  if (!selectedItem) {
    return (
      <DetailPaneLayout>
        <DetailPanePlaceholder
          variant="empty"
          title={t("teamInbox.empty.selectTitle")}
          subtitle={t("teamInbox.empty.selectSubtitle")}
        />
      </DetailPaneLayout>
    );
  }

  if (selectedItem.kind === GITHUB_ITEM_KIND.ISSUE) {
    return (
      <IssueDetail
        key={`${selectedItem.repoPath}:${selectedItem.id}`}
        item={selectedItem}
        onOpenInNewTab={() => onOpenIssueInNewTab(selectedItem)}
        onClose={onClose}
      />
    );
  }

  return (
    <PullRequestDetail
      key={`${selectedItem.repoPath}:${selectedItem.id}`}
      item={selectedItem}
      onOpenInNewTab={() => onOpenPrInNewTab(selectedItem)}
      onClose={onClose}
    />
  );
};

export default GitHubWorkItemDetailPane;
