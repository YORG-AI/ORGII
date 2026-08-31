import {
  CircleDotIcon,
  DeliveryBox01Icon,
  GitPullRequestIcon,
  ListTodoIcon,
  PlayCircleIcon,
} from "@src/icons";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import {
  WORK_MANAGEMENT_PROJECTS_VIEW,
  WORK_MANAGEMENT_SECTION,
  type WorkManagementProjectsView,
  type WorkManagementSection,
} from "@src/store/workstation";

import {
  KANBAN_MENU_ITEM_ID,
  WORK_ITEMS_GITHUB_ISSUES_MENU_ITEM_ID,
  WORK_ITEMS_GITHUB_PRS_MENU_ITEM_ID,
  WORK_ITEMS_MENU_ITEM_ID,
  WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
  WORK_ITEMS_RUNS_MENU_ITEM_ID,
} from "../sidebarConnectorUtils";

export function resolveWorkItemsSidebarMenuItemId({
  homeTab,
  projectsView,
}: {
  homeTab: WorkManagementSection;
  projectsView: WorkManagementProjectsView;
}): string {
  if (homeTab === WORK_MANAGEMENT_SECTION.PROJECTS) {
    return projectsView === WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS
      ? WORK_ITEMS_PROJECTS_MENU_ITEM_ID
      : WORK_ITEMS_MENU_ITEM_ID;
  }
  if (homeTab === WORK_MANAGEMENT_SECTION.GITHUB_ISSUES) {
    return WORK_ITEMS_GITHUB_ISSUES_MENU_ITEM_ID;
  }
  if (homeTab === WORK_MANAGEMENT_SECTION.GITHUB_PRS) {
    return WORK_ITEMS_GITHUB_PRS_MENU_ITEM_ID;
  }
  if (homeTab === WORK_MANAGEMENT_SECTION.RUNS) {
    return WORK_ITEMS_RUNS_MENU_ITEM_ID;
  }
  return KANBAN_MENU_ITEM_ID;
}

export function buildWorkItemsSidebarMenuItems(labels: {
  workItems: string;
  projects: string;
  githubIssues: string;
  githubPrs: string;
  runs: string;
}): NavigationMenuItem[] {
  return [
    {
      id: WORK_ITEMS_GITHUB_PRS_MENU_ITEM_ID,
      key: WORK_ITEMS_GITHUB_PRS_MENU_ITEM_ID,
      label: labels.githubPrs,
      icon: GitPullRequestIcon,
      iconName: "git-pull-request",
      dataTestId: "sidebar-work-items-github-prs",
    },
    {
      id: WORK_ITEMS_GITHUB_ISSUES_MENU_ITEM_ID,
      key: WORK_ITEMS_GITHUB_ISSUES_MENU_ITEM_ID,
      label: labels.githubIssues,
      icon: CircleDotIcon,
      iconName: "circle-dot",
      dataTestId: "sidebar-work-items-github-issues",
    },
    {
      id: WORK_ITEMS_MENU_ITEM_ID,
      key: WORK_ITEMS_MENU_ITEM_ID,
      label: labels.workItems,
      icon: ListTodoIcon,
      iconName: "list-todo",
      dataTestId: "sidebar-work-items",
    },
    {
      id: WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
      key: WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
      label: labels.projects,
      icon: DeliveryBox01Icon,
      iconName: "box",
      dataTestId: "sidebar-work-items-projects",
    },
    {
      id: WORK_ITEMS_RUNS_MENU_ITEM_ID,
      key: WORK_ITEMS_RUNS_MENU_ITEM_ID,
      label: labels.runs,
      icon: PlayCircleIcon,
      iconName: "play-circle",
      dataTestId: "sidebar-work-items-runs",
    },
  ];
}
