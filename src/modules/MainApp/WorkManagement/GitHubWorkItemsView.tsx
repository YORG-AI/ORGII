import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import PrCiStatusIndicator from "@src/components/PrCiStatusIndicator";
import type { SelectOption } from "@src/components/Select";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import {
  CheckmarkCircle01Icon,
  CircleDotIcon,
  CircleSlashIcon,
  Copy01Icon,
  GitMergeIcon,
  GitPullRequestDraftIcon,
  HugeiconsIcon,
} from "@src/icons";
import {
  WorkManagementTable,
  type WorkManagementTableRow,
} from "@src/modules/shared/components/WorkManagementTable";
import InboxListDetailLayout from "@src/modules/shared/layouts/InboxListDetailLayout";

import { CreateIssueModal } from "./CreateIssueModal";
import {
  ManagedIssueActionsCell,
  ManagedIssueAssigneeCell,
  ManagedIssueContextMeta,
  ManagedPrActionsCell,
} from "./GitHubWorkItemControls";
import GitHubWorkItemDetailPane from "./GitHubWorkItemDetailPane";
import GitHubWorkItemsCompactList from "./GitHubWorkItemsCompactList";
import {
  GitHubWorkItemsHeaderControls,
  GitHubWorkItemsRepositorySelect,
} from "./GitHubWorkItemsHeaderControls";
import {
  GITHUB_ITEM_KIND,
  type ManagedGitHubItem,
  type ManagedIssueItem,
  type ManagedPrItem,
  getManagedGitHubItemKey,
} from "./githubManagedItemModel";
import {
  canManageIssueAssignees,
  canManageIssueStatus,
  canManagePrStatus,
  findGitHubRepoSource,
} from "./githubWorkItemPermissions";
import {
  GITHUB_WORK_ITEMS_PAGE_SIZE,
  canAdvanceGitHubWorkItemsPage,
} from "./githubWorkItemsPagination";
import {
  GITHUB_QUERY_SCOPE,
  GITHUB_QUERY_STATE,
  type GitHubQueryScope,
  type ParsedGitHubSearchQuery,
} from "./githubWorkItemsSearchQuery";
import type { GitHubWorkItemsSort } from "./githubWorkItemsSort";
import type {
  GitHubRepoSource,
  IssueRepoFilter,
  RepoFilterOption,
} from "./githubWorkItemsTypes";
import type { IssueAssigneeControlState } from "./useGitHubIssueAssigneeMutations";
import type {
  ManagedIssueStatusValue,
  ManagedPrStatusValue,
} from "./useGitHubWorkItemStatusMutations";

interface GitHubWorkItemsViewProps {
  scope: Extract<GitHubQueryScope, "issue" | "pr">;
  loading: boolean;
  loadError: string | null;
  loadingMore: boolean;
  allItemsCount: number;
  filteredItems: ManagedGitHubItem[];
  pagedItems: ManagedGitHubItem[];
  selectedItem: ManagedGitHubItem | null;
  repoSources: GitHubRepoSource[];
  repoOptions: RepoFilterOption[];
  effectiveSelectedRepo: IssueRepoFilter;
  selectedRepoSourceForCreate: GitHubRepoSource | null;
  searchQuery: string;
  parsedSearchQuery: ParsedGitHubSearchQuery;
  issuePersonalFilterOptions: SelectOption[];
  selectedIssuePersonalFilters: string[];
  currentPage: number;
  totalLoadedPages: number;
  hasMoreFilteredIssues: boolean;
  sort: GitHubWorkItemsSort;
  createFormOpen: boolean;
  creatingIssue: boolean;
  updateSearchQuery: (mutate: (query: ParsedGitHubSearchQuery) => void) => void;
  onSearchQueryChange: (query: string) => void;
  onRepoSelect: (repo: IssueRepoFilter) => void;
  onIssuePersonalFiltersSelect: (values: (string | number)[]) => void;
  onRefresh: () => void;
  /** Jump directly to an already-loaded page (1-based). */
  onGoToPage: (page: number) => void;
  onNextPage: () => Promise<void>;
  onLoadMore: () => void;
  onSortChange: (sort: GitHubWorkItemsSort) => void;
  onSelectItem: (item: ManagedGitHubItem) => void;
  onCloseItem: () => void;
  onOpenIssue: (issue: ManagedIssueItem) => void;
  onOpenIssueInBrowser: (issue: ManagedIssueItem) => void;
  onAddIssue: (issue: ManagedIssueItem) => void;
  onIssueStatusChange: (
    issue: ManagedIssueItem,
    status: ManagedIssueStatusValue
  ) => Promise<void>;
  getIssueAssigneeControlState: (
    issue: ManagedIssueItem
  ) => IssueAssigneeControlState;
  onLoadIssueAssignees: (issue: ManagedIssueItem) => void | Promise<void>;
  onIssueAssigneesChange: (
    issue: ManagedIssueItem,
    assignees: string[]
  ) => void | Promise<void>;
  onOpenPr: (pr: ManagedPrItem) => void;
  onAddPr: (pr: ManagedPrItem) => void;
  onPrStatusChange: (
    pr: ManagedPrItem,
    status: ManagedPrStatusValue
  ) => Promise<void>;
  onSetCreateFormOpen: (open: boolean) => void;
  onCreateIssue: (
    source: GitHubRepoSource,
    title: string,
    body: string
  ) => void;
}

export function getManagedIssueStatusAccent(status: ManagedIssueStatusValue): {
  iconColor: string;
  valueClassName: string;
} {
  if (status === "open") {
    return {
      iconColor: "var(--color-success-6)",
      valueClassName: "text-success-6",
    };
  }
  if (status === "closed_completed") {
    return {
      iconColor: "var(--color-purple-6)",
      valueClassName: "text-purple-6",
    };
  }
  return {
    iconColor: "var(--color-text-3)",
    valueClassName: "text-text-2",
  };
}

export function GitHubWorkItemsView({
  scope,
  loading,
  loadError,
  loadingMore,
  allItemsCount,
  filteredItems,
  pagedItems,
  selectedItem,
  repoSources,
  repoOptions,
  effectiveSelectedRepo,
  selectedRepoSourceForCreate,
  searchQuery,
  parsedSearchQuery,
  issuePersonalFilterOptions,
  selectedIssuePersonalFilters,
  currentPage,
  totalLoadedPages,
  hasMoreFilteredIssues,
  sort,
  createFormOpen,
  creatingIssue,
  updateSearchQuery,
  onSearchQueryChange,
  onRepoSelect,
  onIssuePersonalFiltersSelect,
  onRefresh,
  onGoToPage,
  onNextPage,
  onLoadMore,
  onSortChange,
  onSelectItem,
  onCloseItem,
  onOpenIssue,
  onOpenIssueInBrowser,
  onAddIssue,
  onIssueStatusChange,
  getIssueAssigneeControlState,
  onLoadIssueAssignees,
  onIssueAssigneesChange,
  onOpenPr,
  onAddPr,
  onPrStatusChange,
  onSetCreateFormOpen,
  onCreateIssue,
}: GitHubWorkItemsViewProps): React.ReactNode {
  const { t } = useTranslation(["sessions", "common"]);
  const detailOpen = selectedItem !== null;
  const activeState =
    scope === GITHUB_QUERY_SCOPE.PR &&
    parsedSearchQuery.state === GITHUB_QUERY_STATE.MERGED
      ? GITHUB_QUERY_STATE.CLOSED
      : (parsedSearchQuery.state ?? GITHUB_QUERY_STATE.OPEN);
  const stateTabs = useMemo(
    () => [
      {
        key: GITHUB_QUERY_STATE.OPEN,
        label: t("chat.panels.manageIssues.stateOpen"),
      },
      {
        key: GITHUB_QUERY_STATE.CLOSED,
        label: t("chat.panels.manageIssues.stateClosed"),
      },
    ],
    [t]
  );
  const readonlyReason = t("common:errors.forbidden");
  const handleStateChange = useCallback(
    (state: string) => {
      if (
        state !== GITHUB_QUERY_STATE.OPEN &&
        state !== GITHUB_QUERY_STATE.CLOSED
      ) {
        return;
      }
      updateSearchQuery((query) => {
        query.state = state;
      });
    },
    [updateSearchQuery]
  );

  const headerContent = useMemo(
    () => (
      <GitHubWorkItemsRepositorySelect
        repoOptions={repoOptions}
        selectedRepo={effectiveSelectedRepo}
        onRepoSelect={onRepoSelect}
      />
    ),
    [effectiveSelectedRepo, onRepoSelect, repoOptions]
  );
  const sharedHeaderControlsProps = useMemo(
    () => ({
      stateTabs,
      activeState,
      searchQuery,
      personalFilterOptions:
        scope === GITHUB_QUERY_SCOPE.ISSUE
          ? issuePersonalFilterOptions
          : undefined,
      selectedPersonalFilters: selectedIssuePersonalFilters,
      personalFilterLabel: t("common:actions.filter"),
      refreshLabel: t("common:actions.refresh"),
      refreshing: loading,
      createAction:
        scope === GITHUB_QUERY_SCOPE.ISSUE
          ? {
              label: t("chat.panels.manageIssues.createIssueTrigger"),
              disabled: repoSources.length === 0,
              onClick: () => onSetCreateFormOpen(true),
            }
          : undefined,
      onStateChange: handleStateChange,
      onSearchQueryChange,
      onPersonalFiltersSelect: onIssuePersonalFiltersSelect,
      onRefresh,
    }),
    [
      activeState,
      handleStateChange,
      issuePersonalFilterOptions,
      loading,
      onIssuePersonalFiltersSelect,
      onRefresh,
      onSearchQueryChange,
      onSetCreateFormOpen,
      repoSources.length,
      scope,
      searchQuery,
      selectedIssuePersonalFilters,
      stateTabs,
      t,
    ]
  );
  const headerTrailing = useMemo(
    () =>
      detailOpen ? null : (
        <GitHubWorkItemsHeaderControls
          {...sharedHeaderControlsProps}
          placement="header"
        />
      ),
    [detailOpen, sharedHeaderControlsProps]
  );
  const splitListHeader = useMemo(
    () => (
      <GitHubWorkItemsHeaderControls
        {...sharedHeaderControlsProps}
        placement="list"
      />
    ),
    [sharedHeaderControlsProps]
  );
  // WorkManagementPage subscribes to this same header slot. Keep the wrapper
  // stable so publishing it cannot create a render → publish feedback loop.
  const publishedHeader = useMemo(
    () => ({ content: headerContent, trailing: headerTrailing }),
    [headerContent, headerTrailing]
  );

  usePublishWorkstationTabHeader({
    host: "workManagement",
    content: publishedHeader,
  });

  const tableRows = useMemo<ManagedGitHubItem[]>(() => {
    if (scope === GITHUB_QUERY_SCOPE.PR) {
      return pagedItems.filter(
        (item): item is ManagedPrItem => item.kind === GITHUB_ITEM_KIND.PR
      );
    }
    return pagedItems.filter(
      (item): item is ManagedIssueItem => item.kind === GITHUB_ITEM_KIND.ISSUE
    );
  }, [pagedItems, scope]);
  const settingsRows = useMemo<WorkManagementTableRow[]>(
    () =>
      tableRows.map((item) => {
        const source = findGitHubRepoSource(
          repoSources,
          item.repo,
          item.repoPath
        );
        const updated = (
          <span title={item.updatedAt}>{item.timeAgo || "—"}</span>
        );
        if (item.kind === GITHUB_ITEM_KIND.PR) {
          const prStatusValue: ManagedPrStatusValue =
            item.state === GITHUB_QUERY_STATE.OPEN ? "open" : "closed";
          const prStatusLabel =
            item.state === GITHUB_QUERY_STATE.MERGED
              ? t("common:pullRequests.status.merged", {
                  defaultValue: "Merged",
                })
              : item.rawPr.draft
                ? t("common:pullRequests.status.draft", {
                    defaultValue: "Draft",
                  })
                : prStatusValue === "open"
                  ? t("chat.panels.manageIssues.stateOpen")
                  : t("chat.panels.manageIssues.stateClosed");
          const prStatusIcon =
            item.state === GITHUB_QUERY_STATE.MERGED ? (
              <HugeiconsIcon
                icon={GitMergeIcon}
                data-icon="git-merge"
                size={14}
                strokeWidth={1.8}
              />
            ) : item.rawPr.draft ? (
              <HugeiconsIcon
                icon={GitPullRequestDraftIcon}
                data-icon="git-pull-request-draft"
                size={14}
                strokeWidth={1.8}
              />
            ) : prStatusValue === "open" ? (
              <HugeiconsIcon
                icon={CircleDotIcon}
                data-icon="circle-dot"
                size={14}
                strokeWidth={1.8}
              />
            ) : (
              <HugeiconsIcon
                icon={CheckmarkCircle01Icon}
                data-icon="check-circle-2"
                size={14}
                strokeWidth={1.8}
              />
            );
          const prCiLabel =
            item.rawPr.ci_status === "success"
              ? t("common:git.pr.checks.passedShort")
              : item.rawPr.ci_status === "failure"
                ? t("common:git.pr.checks.failedShort")
                : item.rawPr.ci_status === "pending"
                  ? t("common:git.pr.checks.runningShort")
                  : item.rawPr.ci_status === "none"
                    ? t("common:git.pr.checks.noneShort")
                    : t("common:git.pr.checks.unavailableShort");
          return {
            key: getManagedGitHubItemKey(item),
            id: `#${item.id}`,
            idSortValue: item.id,
            title: item.title,
            titleLinkOnRowHover: true,
            metadata: [
              item.repo,
              item.author,
              `${item.sourceBranch} → ${item.targetBranch}`,
            ],
            fillLastMetadata: true,
            statusSelect: {
              value: prStatusValue,
              label: prStatusLabel,
              icon: prStatusIcon,
              iconColor:
                item.state === GITHUB_QUERY_STATE.MERGED
                  ? "var(--color-purple-6)"
                  : item.rawPr.draft
                    ? "var(--color-text-2)"
                    : prStatusValue === "open"
                      ? "var(--color-success-6)"
                      : "var(--color-text-3)",
              valueClassName:
                item.state === GITHUB_QUERY_STATE.MERGED
                  ? "text-purple-6"
                  : item.rawPr.draft
                    ? "text-text-2"
                    : prStatusValue === "open"
                      ? "text-success-6"
                      : "text-text-2",
              options: [
                {
                  value: "open",
                  label: t("chat.panels.manageIssues.stateOpen"),
                  icon: (
                    <HugeiconsIcon
                      icon={CircleDotIcon}
                      data-icon="circle-dot"
                      size={14}
                      strokeWidth={1.8}
                    />
                  ),
                  iconColor: "var(--color-success-6)",
                },
                {
                  value: "closed",
                  label: t("chat.panels.manageIssues.stateClosed"),
                  icon: (
                    <HugeiconsIcon
                      icon={CheckmarkCircle01Icon}
                      data-icon="check-circle-2"
                      size={14}
                      strokeWidth={1.8}
                    />
                  ),
                  iconColor: "var(--color-text-3)",
                },
              ],
              onChange: (value) =>
                onPrStatusChange(item, value as ManagedPrStatusValue),
              readonly:
                item.state === GITHUB_QUERY_STATE.MERGED ||
                !canManagePrStatus(item, source),
              readonlyReason,
              dataTestId: `github-pr-status-${item.id}`,
            },
            ciStatus: (
              <PrCiStatusIndicator
                status={item.rawPr.ci_status}
                label={prCiLabel}
                dataTestId={`github-pr-ci-${item.id}`}
              />
            ),
            updated,
            actions: (
              <ManagedPrActionsCell
                pr={item}
                addLabel={t("chat.panels.manageIssues.addToChat")}
                onAddPr={onAddPr}
              />
            ),
            onClick: () => onSelectItem(item),
          };
        }
        const issueStatusValue: ManagedIssueStatusValue =
          item.state === "open"
            ? "open"
            : item.rawIssue.state_reason === "duplicate"
              ? "closed_duplicate"
              : item.rawIssue.state_reason === "not_planned"
                ? "closed_not_planned"
                : "closed_completed";
        const issueStatusAccent = getManagedIssueStatusAccent(issueStatusValue);
        const issueStatusOptions = [
          {
            value: "open",
            label: t("chat.panels.manageIssues.stateOpen"),
            icon: (
              <HugeiconsIcon
                icon={CircleDotIcon}
                data-icon="circle-dot"
                size={14}
                strokeWidth={1.8}
              />
            ),
            iconColor: getManagedIssueStatusAccent("open").iconColor,
          },
          {
            value: "closed_completed",
            label: t("chat.panels.manageIssues.closeAsCompleted", {
              defaultValue: "Close as completed",
            }),
            icon: (
              <HugeiconsIcon
                icon={CheckmarkCircle01Icon}
                data-icon="check-circle-2"
                size={14}
                strokeWidth={1.8}
              />
            ),
            iconColor:
              getManagedIssueStatusAccent("closed_completed").iconColor,
          },
          {
            value: "closed_not_planned",
            label: t("chat.panels.manageIssues.closeAsNotPlanned", {
              defaultValue: "Close as not planned",
            }),
            icon: (
              <HugeiconsIcon
                icon={CircleSlashIcon}
                data-icon="circle-slash"
                size={14}
                strokeWidth={1.8}
              />
            ),
            iconColor: "var(--color-text-3)",
          },
          ...(issueStatusValue === "closed_duplicate"
            ? [
                {
                  value: "closed_duplicate" as const,
                  label: t("common:git.issues.composer.closeAsDuplicate"),
                  icon: (
                    <HugeiconsIcon
                      icon={Copy01Icon}
                      data-icon="copy"
                      size={14}
                      strokeWidth={1.8}
                    />
                  ),
                  iconColor: "var(--color-text-3)",
                },
              ]
            : []),
        ];
        const selectedIssueStatus = issueStatusOptions.find(
          (option) => option.value === issueStatusValue
        )!;
        const assigneeControl = getIssueAssigneeControlState(item);
        return {
          key: getManagedGitHubItemKey(item),
          id: `#${item.id}`,
          idSortValue: item.id,
          title: item.title,
          titleLinkOnRowHover: true,
          contextLeading: <ManagedIssueContextMeta issue={item} />,
          metadata: [item.repo, item.author],
          tags: item.labels.map((label) => label.name),
          assignee: (
            <ManagedIssueAssigneeCell
              issue={item}
              assignableUsers={assigneeControl.users}
              canManage={canManageIssueAssignees(source)}
              loading={assigneeControl.loading}
              loadError={assigneeControl.error}
              updating={assigneeControl.updating}
              noneLabel={t("common:common.none")}
              loadingLabel={t("common:status.loading")}
              searchPlaceholder={t("common:common.searchPlaceholder")}
              readonlyReason={readonlyReason}
              onOpen={onLoadIssueAssignees}
              onChange={onIssueAssigneesChange}
            />
          ),
          statusSelect: {
            value: issueStatusValue,
            label:
              item.state === "open"
                ? t("chat.panels.manageIssues.stateOpen")
                : t("chat.panels.manageIssues.stateClosed"),
            icon: selectedIssueStatus.icon,
            iconColor: selectedIssueStatus.iconColor,
            valueClassName: issueStatusAccent.valueClassName,
            options: issueStatusOptions,
            onChange: (value) =>
              onIssueStatusChange(item, value as ManagedIssueStatusValue),
            readonly: !canManageIssueStatus(item, source),
            readonlyReason,
            dataTestId: `github-issue-status-${item.id}`,
          },
          updated,
          actions: (
            <ManagedIssueActionsCell
              issue={item}
              addLabel={t("chat.panels.manageIssues.addToChat")}
              openInBrowserLabel={t("common:previews.openInBrowser")}
              moreActionsLabel={t("common:tooltips.moreActions")}
              onOpenIssueInBrowser={onOpenIssueInBrowser}
              onAddIssue={onAddIssue}
            />
          ),
          onClick: () => onSelectItem(item),
        };
      }),
    [
      getIssueAssigneeControlState,
      onAddIssue,
      onAddPr,
      onIssueAssigneesChange,
      onIssueStatusChange,
      onLoadIssueAssignees,
      onOpenIssueInBrowser,
      onSelectItem,
      onPrStatusChange,
      readonlyReason,
      repoSources,
      t,
      tableRows,
    ]
  );

  const tableEmptyState = (() => {
    if (
      scope !== GITHUB_QUERY_SCOPE.PR &&
      loading &&
      filteredItems.length === 0
    ) {
      return (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          fillParentHeight
        />
      );
    }

    if (loadError && allItemsCount === 0) {
      return (
        <Placeholder
          variant="error"
          placement="detail-panel"
          subtitle={loadError}
          action={{ label: t("common:actions.retry"), onClick: onRefresh }}
          fillParentHeight
        />
      );
    }

    if (!loading && repoSources.length === 0) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          fillParentHeight
        />
      );
    }

    if (
      scope !== GITHUB_QUERY_SCOPE.PR &&
      !loading &&
      filteredItems.length === 0
    ) {
      return (
        <Placeholder
          variant="no-results"
          placement="detail-panel"
          fillParentHeight
        />
      );
    }

    return (
      <Placeholder
        variant={loading ? "loading" : loadError ? "error" : "no-results"}
        placement="detail-panel"
        subtitle={loadError ?? undefined}
        action={
          loadError
            ? {
                label: t("common:actions.retry"),
                onClick: onRefresh,
              }
            : undefined
        }
        fillParentHeight
      />
    );
  })();

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="work-management-github"
    >
      <CreateIssueModal
        open={createFormOpen}
        repoSources={repoSources}
        selectedRepo={selectedRepoSourceForCreate}
        creating={creatingIssue}
        labels={{
          title: t("chat.panels.manageIssues.newIssueTitle"),
          issueTitlePlaceholder: t(
            "chat.panels.manageIssues.issueTitlePlaceholder"
          ),
          issueBodyPlaceholder: t(
            "chat.panels.manageIssues.issueBodyPlaceholder"
          ),
          repository: t("chat.panels.manageIssues.repositoryLabel"),
          cancel: t("common:actions.cancel"),
          create: t("chat.panels.manageIssues.createIssue"),
          creating: t("chat.panels.manageIssues.creatingIssue"),
        }}
        onCreateIssue={onCreateIssue}
        onCancel={() => onSetCreateFormOpen(false)}
      />
      <section
        className="flex min-h-0 flex-1"
        data-testid={`work-management-github-${scope}`}
      >
        <InboxListDetailLayout
          testId={`github-${scope}-list-detail-layout`}
          detailOpen={detailOpen}
          listHeader={splitListHeader}
          listContent={
            <GitHubWorkItemsCompactList
              scope={scope}
              items={filteredItems}
              selectedItem={selectedItem}
              loading={loading}
              loadingMore={loadingMore}
              hasMore={hasMoreFilteredIssues}
              onSelectItem={onSelectItem}
              onLoadMore={onLoadMore}
            />
          }
          fullContent={
            <WorkManagementTable
              rows={settingsRows}
              loading={loading}
              noDataElement={tableEmptyState}
              sort={sort}
              onSortChange={onSortChange}
              testId={`github-${scope}-table`}
              pagination={
                filteredItems.length > 0
                  ? {
                      pageIndex: currentPage - 1,
                      pageSize: GITHUB_WORK_ITEMS_PAGE_SIZE,
                      total: filteredItems.length,
                      pageCount: totalLoadedPages,
                      canPreviousPage: currentPage > 1,
                      canNextPage:
                        !loadingMore &&
                        canAdvanceGitHubWorkItemsPage({
                          currentPage,
                          loadedPageCount: totalLoadedPages,
                          hasMoreRemoteItems: hasMoreFilteredIssues,
                        }),
                      onPageChange: (pageIndex) => {
                        const targetPage = pageIndex + 1;
                        if (targetPage <= totalLoadedPages) {
                          onGoToPage(targetPage);
                        } else if (targetPage > currentPage) {
                          // Beyond the loaded range: fetch one more remote page
                          // and advance a single step.
                          void onNextPage();
                        }
                      },
                      openEndedPageCount: hasMoreFilteredIssues,
                    }
                  : undefined
              }
            />
          }
          detailContent={
            <GitHubWorkItemDetailPane
              selectedItem={selectedItem}
              onOpenIssueInNewTab={onOpenIssue}
              onOpenPrInNewTab={onOpenPr}
              onClose={onCloseItem}
            />
          }
        />
      </section>
    </div>
  );
}
