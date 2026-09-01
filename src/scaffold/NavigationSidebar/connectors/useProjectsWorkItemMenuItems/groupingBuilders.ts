import type { TFunction } from "i18next";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { SESSION_SIDEBAR_PAGE_SIZE } from "@src/store/session";

import { PROJECTS_WORK_ITEM_GROUP_PREFIX } from "./constants";
import {
  buildLinkedSessionRows,
  buildProjectRow,
  buildWorkItemRow,
  getNavigableLinkedSessions,
  groupLoadMoreRow,
  separator,
} from "./menuRows";
import type { SidebarAnyWorkItem, SidebarProject } from "./types";
import { sortWorkItemsByActivity } from "./workItemMapping";

interface GroupingBuilderContext {
  allWorkItems: readonly SidebarAnyWorkItem[];
  groupVisibleCounts: ReadonlyMap<string, number>;
  searchQuery: string;
  t: TFunction;
  pendingSync?: PendingSyncSets;
  expandedLinkedSessionWorkItemIds?: ReadonlySet<string>;
  onToggleLinkedSessionExpansion?: (workItemId: string) => void;
}

interface PendingSyncSets {
  projectIds: ReadonlySet<string>;
  workItemIds: ReadonlySet<string>;
}

function isWorkItemPendingSync(
  context: GroupingBuilderContext,
  workItem: SidebarAnyWorkItem
): boolean {
  return (
    workItem.source === "local" &&
    (context.pendingSync?.workItemIds.has(workItem.id) ?? false)
  );
}

function isProjectPendingSync(
  context: GroupingBuilderContext,
  project: SidebarProject
): boolean {
  return (
    context.pendingSync?.projectIds.has(project.projectData.meta.id) ?? false
  );
}

interface OrgGroupingBuilderContext extends GroupingBuilderContext {
  localProjects: readonly SidebarProject[];
}

function appendGroupItems(
  items: NavigationMenuItem[],
  groupId: string,
  groupItems: readonly SidebarAnyWorkItem[],
  context: GroupingBuilderContext
) {
  const visibleCount =
    context.groupVisibleCounts.get(groupId) ?? SESSION_SIDEBAR_PAGE_SIZE;
  const visibleItems = groupItems.slice(0, visibleCount);
  for (const workItem of visibleItems) {
    appendWorkItem(items, workItem, context);
  }
  if (groupItems.length > visibleItems.length) {
    items.push(groupLoadMoreRow(groupId, context.t("common:actions.loadMore")));
  }
}

function appendWorkItem(
  items: NavigationMenuItem[],
  workItem: SidebarAnyWorkItem,
  context: GroupingBuilderContext
): void {
  const linkedSessions = getNavigableLinkedSessions(workItem);
  const expanded =
    linkedSessions.length > 0 &&
    (context.expandedLinkedSessionWorkItemIds?.has(workItem.id) ?? false);
  const onToggle = context.onToggleLinkedSessionExpansion;
  items.push(
    buildWorkItemRow(
      context.t,
      workItem,
      isWorkItemPendingSync(context, workItem),
      linkedSessions.length > 0 && onToggle
        ? {
            expanded,
            onToggle: () => onToggle(workItem.id),
          }
        : undefined
    )
  );
  if (expanded) {
    items.push(...buildLinkedSessionRows(context.t, workItem));
  }
}

export function buildByOrgMenuItems(
  context: OrgGroupingBuilderContext
): NavigationMenuItem[] {
  const query = context.searchQuery.trim().toLowerCase();

  const items: NavigationMenuItem[] = [];

  if (!query) {
    items.push(
      separator("recent-projects", context.t("projects:orgs.recentProjects"))
    );
    const recentProjects = [...context.localProjects]
      .sort((projectA, projectB) =>
        projectB.projectData.meta.updated_at.localeCompare(
          projectA.projectData.meta.updated_at
        )
      )
      .slice(0, SESSION_SIDEBAR_PAGE_SIZE);
    for (const project of recentProjects) {
      items.push(
        buildProjectRow(
          context.t,
          project.projectData.slug,
          project.projectData.meta.name,
          isProjectPendingSync(context, project),
          project.projectSyncAdapterId
        )
      );
    }
    const recentWorkItems = sortWorkItemsByActivity(context.allWorkItems);
    if (recentWorkItems.length > 0) {
      const groupId = `${PROJECTS_WORK_ITEM_GROUP_PREFIX}recent`;
      items.push(separator(groupId, context.t("projects:workItems.label")));
      appendGroupItems(items, groupId, recentWorkItems, context);
    }
    return items;
  }

  items.push(separator("org-search-results", context.t("projects:search")));
  for (const project of context.localProjects) {
    const projectName = project.projectData.meta.name;
    if (
      projectName.toLowerCase().includes(query) ||
      project.orgName.toLowerCase().includes(query)
    ) {
      items.push(
        buildProjectRow(
          context.t,
          project.projectData.slug,
          projectName,
          isProjectPendingSync(context, project),
          project.projectSyncAdapterId
        )
      );
    }
  }
  for (const workItem of sortWorkItemsByActivity(context.allWorkItems)) {
    const searchableText = [
      workItem.id,
      workItem.title,
      workItem.projectName,
      workItem.orgName,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (searchableText.includes(query)) {
      appendWorkItem(items, workItem, context);
    }
  }
  return items;
}
