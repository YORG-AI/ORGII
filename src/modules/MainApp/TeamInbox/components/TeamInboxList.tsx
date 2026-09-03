import React, {
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import Avatar from "@src/components/Avatar";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import { LIST_PANEL_SECTIONS, ListPanelItem } from "@src/components/ListPanel";
import { Placeholder } from "@src/components/Placeholder";
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HugeiconsIcon,
  type IconSvgElement,
  InboxIcon,
  InformationCircleIcon,
  ListChecksIcon,
  MessageSquareMoreIcon,
  TickDouble01Icon,
} from "@src/icons";
import {
  type ManagedPrItem,
  getManagedPullRequestKey,
} from "@src/modules/MainApp/WorkManagement/githubManagedItemModel";
import { WorkManagementRefreshButton } from "@src/modules/shared/components/WorkManagementRefreshButton";
import { WorkManagementSearchInput } from "@src/modules/shared/components/WorkManagementSearchInput";
import { compactRepositoryLabel } from "@src/modules/shared/githubRepositoryLabel";
import CompactListHeader from "@src/modules/shared/layouts/CompactListHeader";
import {
  CollapsibleSection,
  ListPanelScrollArea,
  LoadingBar,
} from "@src/modules/shared/layouts/blocks";
import {
  type PrStatusIconName,
  getPrStatusIconName,
  getPrStatusVariant,
  normalizePrStatus,
} from "@src/shared/pr/prStatus";

import {
  type TeamInboxFilter,
  type TeamInboxItem,
  type TeamInboxUnreadCounts,
  getTeamInboxItemKey,
} from "../domain";
import TeamInboxRow from "./TeamInboxRow";

export interface TeamInboxListProps {
  filter: TeamInboxFilter;
  items: readonly TeamInboxItem[];
  selectedItemId: string | null;
  unreadCounts: TeamInboxUnreadCounts;
  query: string;
  loading: boolean;
  pullRequests?: readonly ManagedPrItem[];
  pullRequestsLoading?: boolean;
  pullRequestsError?: string | null;
  selectedPullRequestKey?: string | null;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: TeamInboxFilter) => void;
  onSelectItem: (item: TeamInboxItem) => void;
  onSelectPullRequest?: (pullRequest: ManagedPrItem) => void;
  onRefresh?: () => void;
  onMarkAllRead?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** The shared split layout can own this row instead. */
  showControls?: boolean;
}

interface TeamInboxFilterControl {
  key: TeamInboxFilter;
  label: string;
  icon: React.ReactNode;
  iconClassName: string;
  unreadCount: number;
}

const PULL_REQUEST_ICONS: Record<PrStatusIconName, IconSvgElement> = {
  "pull-request": GitPullRequestIcon,
  merge: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
  draft: GitPullRequestDraftIcon,
};

interface TeamInboxPullRequestSections {
  reviewRequested: ManagedPrItem[];
  authoredByViewer: ManagedPrItem[];
}

interface TeamInboxItemSections {
  mentions: TeamInboxItem[];
  assigned: TeamInboxItem[];
}

function groupTeamInboxPullRequests(
  pullRequests: readonly ManagedPrItem[]
): TeamInboxPullRequestSections {
  return pullRequests.reduce<TeamInboxPullRequestSections>(
    (sections, pullRequest) => {
      if (pullRequest.state !== "open") return sections;
      if (pullRequest.reviewRequestedFromViewer) {
        sections.reviewRequested.push(pullRequest);
      } else if (pullRequest.authoredByViewer) {
        sections.authoredByViewer.push(pullRequest);
      }
      return sections;
    },
    { reviewRequested: [], authoredByViewer: [] }
  );
}

function groupTeamInboxItems(
  items: readonly TeamInboxItem[]
): TeamInboxItemSections {
  return items.reduce<TeamInboxItemSections>(
    (sections, item) => {
      if (item.kind === "comment_mention") sections.mentions.push(item);
      else sections.assigned.push(item);
      return sections;
    },
    { mentions: [], assigned: [] }
  );
}

export interface TeamInboxListControlsProps {
  filter: TeamInboxFilter;
  unreadCounts: TeamInboxUnreadCounts;
  query: string;
  loading: boolean;
  placement: "header" | "list";
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: TeamInboxFilter) => void;
  onRefresh?: () => void;
  onMarkAllRead?: () => void;
}

/** Shared Inbox controls used in the page header or compact left pane. */
export const TeamInboxListControls: React.FC<TeamInboxListControlsProps> = ({
  filter,
  unreadCounts,
  query,
  loading,
  placement,
  onQueryChange,
  onFilterChange,
  onRefresh,
  onMarkAllRead,
}) => {
  const { t } = useTranslation();
  const activeFilterUnread = unreadCounts[filter];
  const filterTabs = useMemo<TeamInboxFilterControl[]>(
    () => [
      {
        key: "all",
        label: t("teamInbox.filters.all"),
        icon: (
          <HugeiconsIcon
            icon={InboxIcon}
            data-icon="inbox"
            size={14}
            strokeWidth={1.8}
            aria-hidden
          />
        ),
        iconClassName: "text-text-2",
        unreadCount: unreadCounts.all,
      },
      {
        key: "mentions",
        label: t("teamInbox.filters.mentions"),
        icon: (
          <HugeiconsIcon
            icon={MessageSquareMoreIcon}
            data-icon="message-square-more"
            size={14}
            strokeWidth={1.8}
            aria-hidden
          />
        ),
        iconClassName: "text-primary-6",
        unreadCount: unreadCounts.mentions,
      },
      {
        key: "assigned",
        label: t("teamInbox.filters.assigned"),
        icon: (
          <HugeiconsIcon
            icon={ListChecksIcon}
            data-icon="list-checks"
            size={14}
            strokeWidth={1.8}
            aria-hidden
          />
        ),
        iconClassName: "text-success-6",
        unreadCount: unreadCounts.assigned,
      },
    ],
    [t, unreadCounts.all, unreadCounts.assigned, unreadCounts.mentions]
  );

  return (
    <div
      className={`flex min-w-0 items-center gap-2 ${
        placement === "list" ? "flex-1" : ""
      }`.trim()}
    >
      <div
        className="flex shrink-0 items-center gap-1"
        role="group"
        aria-label={t("common:actions.filter")}
      >
        {filterTabs.map((filterTab) => {
          const isActive = filter === filterTab.key;
          const unreadLabel =
            filterTab.unreadCount > 0
              ? `${filterTab.label}, ${t("teamInbox.unreadCount", {
                  count: filterTab.unreadCount,
                })}`
              : filterTab.label;
          return (
            <Button
              key={filterTab.key}
              htmlType="button"
              variant="tertiary"
              size="small"
              icon={
                <span
                  className={
                    filterTab.key === "all" && isActive
                      ? "text-primary-6"
                      : filterTab.iconClassName
                  }
                >
                  {filterTab.icon}
                </span>
              }
              iconOnly
              className={`h-7 w-7 ${isActive ? "bg-fill-2! text-text-1!" : ""}`}
              aria-label={unreadLabel}
              aria-pressed={isActive}
              title={unreadLabel}
              data-testid={`team-inbox-filter-${filterTab.key}`}
              onClick={() => onFilterChange(filterTab.key)}
            />
          );
        })}
      </div>
      <WorkManagementSearchInput
        value={query}
        onChange={onQueryChange}
        placement={placement}
        placeholder={t("common:actions.search")}
        dataTestId="team-inbox-search"
      />
      {activeFilterUnread > 0 && onMarkAllRead ? (
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          icon={
            <HugeiconsIcon
              icon={TickDouble01Icon}
              data-icon="check-check"
              size={14}
              strokeWidth={2}
            />
          }
          iconOnly
          className="shrink-0"
          title={t("inbox.markAllAsRead")}
          aria-label={t("inbox.markAllAsRead")}
          data-testid="team-inbox-mark-all-read"
          onClick={onMarkAllRead}
        />
      ) : null}
      {onRefresh ? (
        <WorkManagementRefreshButton
          label={t("common:actions.refresh")}
          loading={loading}
          onRefresh={onRefresh}
          dataTestId="team-inbox-refresh"
        />
      ) : null}
    </div>
  );
};

// Temporarily hidden until GitHub OAuth failures can name the affected
// repositories and offer a useful recovery path. Keep the warning UI in place
// so it can be restored without rebuilding its shared styling and behavior.
const PULL_REQUEST_LOAD_WARNING_ENABLED = false;

function TeamInboxListSection({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section data-testid={testId} aria-label={title} className="mb-2 last:mb-0">
      <CollapsibleSection
        title={title}
        compact
        headerRowClassName="mb-px h-7"
        titleButtonClassName="group/section-title h-7 w-full gap-2 pl-2 text-xs font-medium uppercase tracking-wider text-text-2 hover:text-text-1"
        titleClassName="order-first min-w-0 truncate text-left"
        chevronContainerClassName="order-last hidden shrink-0 items-center leading-none group-hover/section-title:inline-flex group-focus-visible/section-title:inline-flex"
        chevronSize={14}
        chevronStrokeWidth={2}
        chevronClassName="text-text-2"
        titleButtonTestId={`${testId}-toggle`}
      >
        <div className={LIST_PANEL_SECTIONS.sectionGroupItems}>{children}</div>
      </CollapsibleSection>
    </section>
  );
}

const TeamInboxList: React.FC<TeamInboxListProps> = ({
  filter,
  items,
  selectedItemId,
  unreadCounts,
  query,
  loading,
  pullRequests = [],
  pullRequestsLoading = false,
  pullRequestsError = null,
  selectedPullRequestKey = null,
  onQueryChange,
  onFilterChange,
  onSelectItem,
  onSelectPullRequest,
  onRefresh,
  onMarkAllRead,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  showControls = true,
}) => {
  const { t } = useTranslation();
  const hasQuery = query.trim().length > 0;
  const [pullRequestsErrorUi, setPullRequestsErrorUi] = useState(() => ({
    error: pullRequestsError,
    dismissed: false,
    detailed: false,
  }));
  if (pullRequestsErrorUi.error !== pullRequestsError) {
    setPullRequestsErrorUi({
      error: pullRequestsError,
      dismissed: false,
      detailed: false,
    });
  }
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const inboxItemSections = useMemo(() => groupTeamInboxItems(items), [items]);
  const orderedInboxItems = useMemo(
    () =>
      filter === "all"
        ? [...inboxItemSections.mentions, ...inboxItemSections.assigned]
        : items,
    [filter, inboxItemSections, items]
  );
  const selectedIndex = useMemo(
    () =>
      orderedInboxItems.findIndex(
        (item) => getTeamInboxItemKey(item) === selectedItemId
      ),
    [orderedInboxItems, selectedItemId]
  );
  const visiblePullRequests = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return pullRequests;
    return pullRequests.filter((pullRequest) =>
      [
        pullRequest.title,
        pullRequest.repo,
        pullRequest.author,
        pullRequest.sourceBranch,
        pullRequest.targetBranch,
        `#${pullRequest.id}`,
        `pr #${pullRequest.id}`,
      ].some((part) => part.toLowerCase().includes(normalizedQuery))
    );
  }, [pullRequests, query]);
  const pullRequestSections = useMemo(
    () => groupTeamInboxPullRequests(visiblePullRequests),
    [visiblePullRequests]
  );
  const showPullRequests = filter === "all";
  const actionablePullRequestCount = showPullRequests
    ? pullRequestSections.reviewRequested.length +
      pullRequestSections.authoredByViewer.length
    : 0;
  const hasPullRequestSurface =
    showPullRequests &&
    (actionablePullRequestCount > 0 ||
      pullRequestsLoading ||
      Boolean(pullRequestsError));
  const showPullRequestsError =
    showPullRequests &&
    Boolean(pullRequestsError) &&
    !pullRequestsErrorUi.dismissed;
  const showPullRequestsErrorDetails =
    Boolean(pullRequestsError) && pullRequestsErrorUi.detailed;
  const showLoadingBar = loading || pullRequestsLoading || loadingMore;
  const loadMoreAction =
    hasMore && onLoadMore ? (
      <div className="flex shrink-0 justify-center px-3 pt-1 pb-2">
        <Button
          variant="tertiary"
          size="small"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {t("teamInbox.loadMore")}
        </Button>
      </div>
    ) : null;
  const selectAt = useCallback(
    (index: number) => {
      const item = orderedInboxItems[index];
      if (!item) return;
      onSelectItem(item);
      rowRefs.current.get(getTeamInboxItemKey(item))?.focus();
    },
    [onSelectItem, orderedInboxItems]
  );

  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (orderedInboxItems.length === 0) return;
      const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
      let nextIndex: number | null = null;
      switch (event.key) {
        case "ArrowDown":
          nextIndex = Math.min(currentIndex + 1, orderedInboxItems.length - 1);
          break;
        case "ArrowUp":
          nextIndex = Math.max(currentIndex - 1, 0);
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = orderedInboxItems.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      selectAt(nextIndex);
    },
    [orderedInboxItems.length, selectAt, selectedIndex]
  );
  const renderPullRequestRows = (pullRequestItems: ManagedPrItem[]) =>
    pullRequestItems.map((pullRequest) => {
      const key = getManagedPullRequestKey(pullRequest);
      const status = normalizePrStatus({
        state: pullRequest.state,
        merged: pullRequest.state === "merged",
        draft: pullRequest.rawPr.draft,
      });
      const PullRequestIcon = PULL_REQUEST_ICONS[getPrStatusIconName(status)];
      const statusIconClass = getPrStatusVariant(status).textClass;
      return (
        <ListPanelItem
          key={key}
          id={key}
          selected={selectedPullRequestKey === key}
          title={pullRequest.title}
          titlePrefix={`#${pullRequest.id}`}
          time={pullRequest.timeAgo}
          metadata={
            <>
              <Avatar
                size={16}
                src={pullRequest.rawPr.author_avatar_url ?? undefined}
                hideOnError
              />
              <span className="truncate">
                {compactRepositoryLabel(pullRequest.repo)} ·{" "}
                {pullRequest.sourceBranch}
              </span>
            </>
          }
          leading={
            <AnyIcon icon={PullRequestIcon} size={14} strokeWidth={1.8} />
          }
          leadingClassName={statusIconClass}
          ariaLabel={`${pullRequest.title}, #${pullRequest.id}, ${pullRequest.author}, ${pullRequest.repo}`}
          ariaCurrent={selectedPullRequestKey === key ? "true" : undefined}
          dataAttributes={{
            "data-team-inbox-list-item": true,
            "data-testid": "team-inbox-pr-row",
            "data-pr-number": pullRequest.id,
          }}
          onClick={() => onSelectPullRequest?.(pullRequest)}
        />
      );
    });
  const renderInboxRows = (
    rowItems: readonly TeamInboxItem[],
    label: string,
    sectioned = false
  ) => (
    <div
      className={sectioned ? undefined : LIST_PANEL_SECTIONS.sectionGroupItems}
      role="listbox"
      aria-label={label}
      onKeyDown={handleListKeyDown}
    >
      {rowItems.map((item) => {
        const key = getTeamInboxItemKey(item);
        return (
          <TeamInboxRow
            key={key}
            ref={(node) => {
              if (node) rowRefs.current.set(key, node);
              else rowRefs.current.delete(key);
            }}
            item={item}
            itemKey={key}
            selected={key === selectedItemId}
            onSelect={onSelectItem}
          />
        );
      })}
    </div>
  );

  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t("teamInbox.listLabel")}
    >
      {showControls ? (
        <CompactListHeader>
          <TeamInboxListControls
            filter={filter}
            unreadCounts={unreadCounts}
            query={query}
            loading={showLoadingBar}
            placement="list"
            onQueryChange={onQueryChange}
            onFilterChange={onFilterChange}
            onRefresh={onRefresh}
            onMarkAllRead={onMarkAllRead}
          />
        </CompactListHeader>
      ) : null}
      {showLoadingBar ? <LoadingBar /> : null}

      {items.length === 0 && !hasPullRequestSurface ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {showLoadingBar ? null : hasQuery ? (
            <Placeholder
              variant="no-results"
              placement="sidebar"
              title={t("teamInbox.empty.noResults.title")}
              subtitle={t("teamInbox.empty.noResults.subtitle", {
                query: query.trim(),
              })}
              fillParentHeight
            />
          ) : (
            <Placeholder
              variant="empty"
              placement="sidebar"
              title={t(`teamInbox.empty.${filter}.title`, {
                defaultValue: t("teamInbox.empty.title"),
              })}
              subtitle={t(`teamInbox.empty.${filter}.subtitle`, {
                defaultValue: t("teamInbox.empty.subtitle"),
              })}
              fillParentHeight
            />
          )}
          {loadMoreAction}
        </div>
      ) : (
        <ListPanelScrollArea listPaddingTop="none">
          <div className="flex flex-col" data-testid="team-inbox-sections">
            {PULL_REQUEST_LOAD_WARNING_ENABLED &&
            showPullRequestsError &&
            pullRequestsError ? (
              <InlineAlert
                type="warning"
                className="mx-3 mb-2"
                title={t("teamInbox.errors.pullRequestsPartialLoad")}
                action={
                  <Button
                    htmlType="button"
                    variant="tertiary"
                    size="small"
                    icon={
                      <HugeiconsIcon
                        icon={InformationCircleIcon}
                        data-icon="info"
                        size={14}
                        strokeWidth={1.8}
                      />
                    }
                    iconOnly
                    className="h-7 w-7"
                    aria-label={t("common:common.details")}
                    title={t("common:common.details")}
                    data-testid="team-inbox-partial-load-info"
                    onClick={() =>
                      setPullRequestsErrorUi((current) => ({
                        ...current,
                        detailed: !current.detailed,
                      }))
                    }
                  />
                }
                onClose={() =>
                  setPullRequestsErrorUi((current) => ({
                    ...current,
                    dismissed: true,
                    detailed: false,
                  }))
                }
                closeAriaLabel={t("common:actions.close")}
              >
                {showPullRequestsErrorDetails ? (
                  <div className="space-y-1 text-text-2">
                    <div>
                      {t("teamInbox.errors.pullRequestsPartialLoadHelp")}
                    </div>
                    <div className="text-[11px] wrap-break-word text-text-3">
                      {pullRequestsError}
                    </div>
                  </div>
                ) : null}
              </InlineAlert>
            ) : null}
            {showPullRequests &&
            pullRequestSections.reviewRequested.length > 0 ? (
              <TeamInboxListSection
                title={t("teamInbox.sections.reviewRequested")}
                testId="team-inbox-pr-review-requested"
              >
                {renderPullRequestRows(pullRequestSections.reviewRequested)}
              </TeamInboxListSection>
            ) : null}
            {showPullRequests &&
            pullRequestSections.authoredByViewer.length > 0 ? (
              <TeamInboxListSection
                title={t("teamInbox.sections.authoredByMe")}
                testId="team-inbox-pr-authored"
              >
                {renderPullRequestRows(pullRequestSections.authoredByViewer)}
              </TeamInboxListSection>
            ) : null}
            {filter === "all" ? (
              <>
                {inboxItemSections.mentions.length > 0 ? (
                  <TeamInboxListSection
                    title={t("teamInbox.filters.mentions")}
                    testId="team-inbox-mentions"
                  >
                    {renderInboxRows(
                      inboxItemSections.mentions,
                      t("teamInbox.filters.mentions"),
                      true
                    )}
                  </TeamInboxListSection>
                ) : null}
                {inboxItemSections.assigned.length > 0 ? (
                  <TeamInboxListSection
                    title={t("teamInbox.filters.assigned")}
                    testId="team-inbox-assigned"
                  >
                    {renderInboxRows(
                      inboxItemSections.assigned,
                      t("teamInbox.filters.assigned"),
                      true
                    )}
                  </TeamInboxListSection>
                ) : null}
              </>
            ) : items.length > 0 ? (
              renderInboxRows(items, t("teamInbox.itemsLabel"))
            ) : null}
          </div>
          {loadMoreAction}
        </ListPanelScrollArea>
      )}
    </section>
  );
};

export default TeamInboxList;
