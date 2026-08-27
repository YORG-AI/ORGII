/**
 * Assembles the Team Sessions section's `NavigationMenuItem[]` list
 * (`cloudSessionsSection.tsx`): the separator header (refresh + member
 * filter row actions), one row per visible fork thread via `buildRowItem`,
 * the "Load more" pagination row, and the empty/loading/error placeholder
 * row.
 */
import type { TFunction } from "i18next";
import { ListFilter, RefreshCw } from "lucide-react";
import React, { useMemo } from "react";

import type { CloudSessionFilter } from "@src/features/Org2Cloud/cloudSessionFilter";
import type { CloudSessionThread } from "@src/features/Org2Cloud/cloudSessionThreads";
import type { CloudRemoteSessionsFetchState } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import { separator } from "../useSessionMenuItems/menuItemBuilders";
import {
  CLOUD_TEAM_SESSIONS_LOAD_MORE_ID,
  CLOUD_TEAM_SESSIONS_SECTION_ID,
  buildCloudSectionLoadMoreItem,
} from "./cloudScopedMenuItems";
import type { BuildCloudSessionRowItem } from "./cloudSessionsSection.rowItemBuilder";
import type { MemberFilterMenuState } from "./cloudSessionsSection.types";

interface UseCloudTeamSessionMenuItemsParams {
  orgId: string | null;
  threads: readonly CloudSessionThread[];
  visibleThreads: readonly CloudSessionThread[];
  state: CloudRemoteSessionsFetchState;
  filter: CloudSessionFilter;
  memberMenu: MemberFilterMenuState | null;
  setMemberMenu: React.Dispatch<
    React.SetStateAction<MemberFilterMenuState | null>
  >;
  refreshSpinClass: string | undefined;
  handleRefreshClick: () => void;
  buildRowItem: BuildCloudSessionRowItem;
  t: TFunction;
  tCommon: TFunction;
}

export function useCloudTeamSessionMenuItems({
  orgId,
  threads,
  visibleThreads,
  state,
  filter,
  memberMenu,
  setMemberMenu,
  refreshSpinClass,
  handleRefreshClick,
  buildRowItem,
  t,
  tCommon,
}: UseCloudTeamSessionMenuItemsParams): NavigationMenuItem[] {
  const cloudMenuItems = useMemo<NavigationMenuItem[]>(() => {
    if (!orgId) return [];
    const header = separator(
      CLOUD_TEAM_SESSIONS_SECTION_ID,
      t("cloud.sidebar.teamSessions")
    );
    header.rowActions = [
      {
        icon: RefreshCw,
        iconClassName: refreshSpinClass,
        label: tCommon("actions.refresh"),
        dataTestId: "cloud-team-sessions-refresh",
        onClick: handleRefreshClick,
      },
      {
        icon: ListFilter,
        label: t("cloud.sidebar.sessionFilter"),
        active: memberMenu !== null || filter.kind !== "all",
        dataTestId: "cloud-team-sessions-filter",
        onClick: (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMemberMenu((current) =>
            current ? null : { top: rect.bottom + 4, left: rect.left }
          );
        },
      },
    ];
    const items: NavigationMenuItem[] = [header];
    for (const thread of visibleThreads) {
      // One conversation, one row: descendants never render as child rows —
      // the conversation surface stitches the whole family, so the fork
      // topology is wiring, not navigation. Descendants still feed the
      // row's aggregated unread badge.
      items.push(buildRowItem(thread.root, thread.descendants));
    }
    if (visibleThreads.length < threads.length) {
      items.push(
        buildCloudSectionLoadMoreItem({
          id: CLOUD_TEAM_SESSIONS_LOAD_MORE_ID,
          label: tCommon("actions.loadMore"),
        })
      );
    }
    if (threads.length === 0) {
      const emptyLabel =
        state === "error"
          ? t("cloud.orgPanel.sessionsLoadError")
          : state === "ready"
            ? t("cloud.orgPanel.sessionsEmpty")
            : t("cloud.orgPanel.loading");
      items.push({
        id: "cloud-team-sessions-empty",
        key: "cloud-team-sessions-empty",
        label: emptyLabel,
        // Stable E2E hook: the section header is a locale-dependent section
        // title (no testid slot), so this row is the deterministic proof the
        // "Team sessions" section rendered (empty, loading, and error states
        // all funnel here).
        dataTestId: "cloud-team-sessions-empty",
        visualTone: "secondary",
        disabled: true,
      });
    }
    return items;
  }, [
    orgId,
    threads.length,
    visibleThreads,
    state,
    filter.kind,
    memberMenu,
    setMemberMenu,
    refreshSpinClass,
    handleRefreshClick,
    buildRowItem,
    t,
    tCommon,
  ]);

  return cloudMenuItems;
}
