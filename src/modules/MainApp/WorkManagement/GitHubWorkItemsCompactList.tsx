import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import Avatar from "@src/components/Avatar";
import Button from "@src/components/Button";
import {
  CheckmarkCircle01Icon,
  CircleDotIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HugeiconsIcon,
  type IconSvgElement,
} from "@src/icons";
import CompactListPanel, {
  type CompactListPanelEntry,
} from "@src/modules/shared/components/CompactListPanel";
import { compactRepositoryLabel } from "@src/modules/shared/githubRepositoryLabel";
import {
  type PrStatusIconName,
  getPrStatusIconName,
  getPrStatusVariant,
  normalizePrStatus,
} from "@src/shared/pr/prStatus";

import {
  GITHUB_ITEM_KIND,
  type ManagedGitHubItem,
  getManagedGitHubItemKey,
} from "./githubManagedItemModel";
import type { GitHubQueryScope } from "./githubWorkItemsSearchQuery";

const PULL_REQUEST_ICONS: Record<PrStatusIconName, IconSvgElement> = {
  "pull-request": GitPullRequestIcon,
  merge: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
  draft: GitPullRequestDraftIcon,
};

interface GitHubWorkItemsCompactListProps {
  scope: Extract<GitHubQueryScope, "issue" | "pr">;
  items: readonly ManagedGitHubItem[];
  selectedItem: ManagedGitHubItem | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onSelectItem: (item: ManagedGitHubItem) => void;
  onLoadMore: () => void;
}

const GitHubWorkItemsCompactList: React.FC<GitHubWorkItemsCompactListProps> = ({
  scope,
  items,
  selectedItem,
  loading,
  loadingMore,
  hasMore,
  onSelectItem,
  onLoadMore,
}) => {
  const { t } = useTranslation(["sessions", "common"]);
  const entries = useMemo<CompactListPanelEntry[]>(
    () =>
      items.map((item) => {
        const key = getManagedGitHubItemKey(item);
        const repository = compactRepositoryLabel(item.repo);
        if (item.kind === GITHUB_ITEM_KIND.PR) {
          const status = normalizePrStatus({
            state: item.state,
            merged: item.state === "merged",
            draft: item.rawPr.draft,
          });
          const PullRequestIcon =
            PULL_REQUEST_ICONS[getPrStatusIconName(status)];
          return {
            key,
            title: item.title,
            titlePrefix: `#${item.id}`,
            time: item.timeAgo,
            metadata: (
              <>
                <Avatar
                  size={16}
                  src={item.rawPr.author_avatar_url ?? undefined}
                  hideOnError
                />
                <span className="truncate">
                  {repository} · {item.sourceBranch}
                </span>
              </>
            ),
            leading: (
              <AnyIcon icon={PullRequestIcon} size={14} strokeWidth={1.8} />
            ),
            leadingClassName: getPrStatusVariant(status).textClass,
            ariaLabel: `${item.title}, #${item.id}, ${item.author}, ${item.repo}`,
            dataAttributes: {
              "data-testid": "github-compact-row",
              "data-item-kind": item.kind,
              "data-item-id": item.id,
            },
            onSelect: () => onSelectItem(item),
          };
        }
        const open = item.state === "open";
        return {
          key,
          title: item.title,
          titlePrefix: `#${item.id}`,
          time: item.timeAgo,
          metadata: (
            <>
              <Avatar
                size={16}
                src={item.rawIssue.user.avatar_url ?? undefined}
                hideOnError
              />
              <span className="truncate">
                {repository} · {item.author}
              </span>
            </>
          ),
          leading: (
            <HugeiconsIcon
              icon={open ? CircleDotIcon : CheckmarkCircle01Icon}
              data-icon={open ? "circle-dot" : "check-circle-2"}
              size={14}
              strokeWidth={1.8}
            />
          ),
          leadingClassName: open ? "text-success-6" : "text-text-2",
          ariaLabel: `${item.title}, #${item.id}, ${item.author}, ${item.repo}`,
          dataAttributes: {
            "data-testid": "github-compact-row",
            "data-item-kind": item.kind,
            "data-item-id": item.id,
          },
          onSelect: () => onSelectItem(item),
        };
      }),
    [items, onSelectItem]
  );
  const title = t(
    scope === "pr" ? "sidebar.githubPrs" : "sidebar.githubIssues"
  );

  return (
    <CompactListPanel
      ariaLabel={title}
      entries={entries}
      selectedEntryKey={
        selectedItem ? getManagedGitHubItemKey(selectedItem) : null
      }
      loading={loading || loadingMore}
      testId={`github-${scope}-compact-list`}
      footer={
        hasMore ? (
          <div className="flex shrink-0 justify-center px-3 pt-1 pb-2">
            <Button
              variant="tertiary"
              size="small"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              {t("common:actions.loadMore")}
            </Button>
          </div>
        ) : null
      }
    />
  );
};

export default GitHubWorkItemsCompactList;
