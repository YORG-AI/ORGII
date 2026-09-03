import type { TFunction } from "i18next";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { SESSION_SIDEBAR_PAGE_SIZE } from "@src/store/session";

import { buildProjectRow, separator } from "./menuRows";
import type { SidebarProject } from "./types";

interface GroupingBuilderContext {
  searchQuery: string;
  t: TFunction;
  pendingSync?: PendingSyncSets;
}

interface PendingSyncSets {
  projectIds: ReadonlySet<string>;
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
  return items;
}
