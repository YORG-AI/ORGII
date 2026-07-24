import { AtSign, ClipboardList, Inbox } from "lucide-react";
import React, { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  LIST_PANEL_SECTIONS,
  LIST_PANEL_SECTION_HEADER,
} from "@src/components/ListPanel";
import SearchInput from "@src/components/SearchInput";
import TabPill, { type TabPillItem } from "@src/components/TabPill";
import {
  ListPanelScrollArea,
  ListPanelTabPillRow,
  Placeholder,
} from "@src/modules/shared/layouts/blocks";

import {
  type TeamInboxFilter,
  type TeamInboxItem,
  type TeamInboxUnreadCounts,
  getTeamInboxItemKey,
  groupTeamInboxItemsByRecency,
} from "../domain";
import TeamInboxRow from "./TeamInboxRow";

export interface TeamInboxListProps {
  filter: TeamInboxFilter;
  items: readonly TeamInboxItem[];
  selectedItemId: string | null;
  unreadCounts: TeamInboxUnreadCounts;
  query: string;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: TeamInboxFilter) => void;
  onSelectItem: (item: TeamInboxItem) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

function filterCountBadge(count: number, ariaLabel: string): React.ReactNode {
  if (count <= 0) return undefined;
  return (
    <span
      aria-label={ariaLabel}
      className="rounded-full bg-primary-6 px-1.5 text-xs font-semibold leading-tight text-white"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

const TeamInboxList: React.FC<TeamInboxListProps> = ({
  filter,
  items,
  selectedItemId,
  unreadCounts,
  query,
  onQueryChange,
  onFilterChange,
  onSelectItem,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}) => {
  const { t } = useTranslation();
  const hasQuery = query.trim().length > 0;
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectedIndex = useMemo(
    () =>
      items.findIndex((item) => getTeamInboxItemKey(item) === selectedItemId),
    [items, selectedItemId]
  );
  const groups = useMemo(() => groupTeamInboxItemsByRecency(items), [items]);
  const filterTabs = useMemo<TabPillItem[]>(
    () => [
      {
        key: "all",
        label: t("teamInbox.filters.all"),
        icon: <Inbox size={14} aria-hidden />,
        badge: filterCountBadge(
          unreadCounts.all,
          t("teamInbox.unreadCount", { count: unreadCounts.all })
        ),
      },
      {
        key: "mentions",
        label: t("teamInbox.filters.mentions"),
        icon: <AtSign size={14} aria-hidden />,
        badge: filterCountBadge(
          unreadCounts.mentions,
          t("teamInbox.unreadCount", { count: unreadCounts.mentions })
        ),
      },
      {
        key: "assigned",
        label: t("teamInbox.filters.assigned"),
        icon: <ClipboardList size={14} aria-hidden />,
        badge: filterCountBadge(
          unreadCounts.assigned,
          t("teamInbox.unreadCount", { count: unreadCounts.assigned })
        ),
      },
    ],
    [t, unreadCounts.all, unreadCounts.mentions, unreadCounts.assigned]
  );

  const selectAt = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      onSelectItem(item);
      rowRefs.current.get(getTeamInboxItemKey(item))?.focus();
    },
    [items, onSelectItem]
  );

  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (items.length === 0) return;
      const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
      let nextIndex: number | null = null;
      switch (event.key) {
        case "ArrowDown":
          nextIndex = Math.min(currentIndex + 1, items.length - 1);
          break;
        case "ArrowUp":
          nextIndex = Math.max(currentIndex - 1, 0);
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = items.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      selectAt(nextIndex);
    },
    [items.length, selectAt, selectedIndex]
  );

  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t("teamInbox.listLabel")}
    >
      <ListPanelTabPillRow>
        <TabPill
          tabs={filterTabs}
          activeTab={filter}
          onChange={(key) => onFilterChange(key as TeamInboxFilter)}
          variant="pill"
          colorScheme="ghost"
          size="mini"
          fillWidth
        />
      </ListPanelTabPillRow>

      <div className="flex-shrink-0 bg-bg-2 px-3 pb-2">
        <SearchInput
          variant="sidebar"
          value={query}
          onChange={onQueryChange}
          placeholder={t("teamInbox.search.placeholder")}
          ariaLabel={t("teamInbox.search.ariaLabel")}
          showClearButton
        />
      </div>

      {items.length === 0 ? (
        hasQuery ? (
          <Placeholder
            variant="empty"
            title={t("teamInbox.empty.noResults.title")}
            subtitle={t("teamInbox.empty.noResults.subtitle", {
              query: query.trim(),
            })}
            fillParentHeight
          />
        ) : (
          <Placeholder
            variant="empty"
            title={t(`teamInbox.empty.${filter}.title`, {
              defaultValue: t("teamInbox.empty.title"),
            })}
            subtitle={t(`teamInbox.empty.${filter}.subtitle`, {
              defaultValue: t("teamInbox.empty.subtitle"),
            })}
            fillParentHeight
          />
        )
      ) : (
        <ListPanelScrollArea listPaddingTop="default">
          <div
            className="flex flex-col gap-4"
            role="listbox"
            aria-label={t("teamInbox.itemsLabel")}
            aria-activedescendant={selectedItemId ?? undefined}
            onKeyDown={handleListKeyDown}
          >
            {groups.map((group) => {
              const groupLabel = t(`teamInbox.groups.${group.key}`);
              return (
                <div
                  key={group.key}
                  role="group"
                  aria-label={groupLabel}
                  className={LIST_PANEL_SECTIONS.sectionWithHeader}
                >
                  <div
                    className={`${LIST_PANEL_SECTION_HEADER.typography} px-3`}
                  >
                    {groupLabel}
                  </div>
                  <div className={LIST_PANEL_SECTIONS.sectionGroupItems}>
                    {group.items.map((item) => {
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
                </div>
              );
            })}
          </div>
          {hasMore && onLoadMore ? (
            <div className="flex justify-center px-3 pb-2 pt-1">
              <Button
                variant="tertiary"
                size="small"
                loading={loadingMore}
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                {t("teamInbox.loadMore", { defaultValue: "Load more" })}
              </Button>
            </div>
          ) : null}
        </ListPanelScrollArea>
      )}
    </section>
  );
};

export default TeamInboxList;
