import {
  LOAD_MORE_GROUP_PREFIX,
  PROJECTS_LINEAR_LOAD_PREFIX,
  PROJECTS_LINEAR_ORG_PREFIX,
  PROJECTS_LINEAR_WORK_ITEM_PREFIX,
  PROJECTS_LOCAL_ORG_PREFIX,
  PROJECTS_PROJECT_OVERVIEW_PREFIX,
  PROJECTS_WORK_ITEM_CREATE_PREFIX,
  PROJECTS_WORK_ITEM_GROUP_PREFIX,
  PROJECTS_WORK_ITEM_PREFIX,
} from "./constants";

export function getProjectOverviewMenuItemId(projectSlug: string): string {
  return `${PROJECTS_PROJECT_OVERVIEW_PREFIX}${projectSlug}`;
}

export function getWorkItemMenuItemId(workItemId: string): string {
  return `${PROJECTS_WORK_ITEM_PREFIX}${workItemId}`;
}

export function getLinearWorkItemMenuItemId(workItemId: string): string {
  return `${PROJECTS_LINEAR_WORK_ITEM_PREFIX}${workItemId}`;
}

export function getLocalOrgMenuItemId(orgId: string): string {
  return `${PROJECTS_LOCAL_ORG_PREFIX}${orgId}`;
}

export function getLinearOrgMenuItemId(orgId: string): string {
  return `${PROJECTS_LINEAR_ORG_PREFIX}${orgId}`;
}

export function getProjectsProjectOverviewSlug(
  menuItemId: string
): string | null {
  if (!menuItemId.startsWith(PROJECTS_PROJECT_OVERVIEW_PREFIX)) return null;
  return menuItemId.slice(PROJECTS_PROJECT_OVERVIEW_PREFIX.length) || null;
}

export function getProjectsWorkItemId(menuItemId: string): string | null {
  if (!menuItemId.startsWith(PROJECTS_WORK_ITEM_PREFIX)) return null;
  return menuItemId.slice(PROJECTS_WORK_ITEM_PREFIX.length) || null;
}

export function getProjectsLinearWorkItemId(menuItemId: string): string | null {
  if (!menuItemId.startsWith(PROJECTS_LINEAR_WORK_ITEM_PREFIX)) return null;
  return menuItemId.slice(PROJECTS_LINEAR_WORK_ITEM_PREFIX.length) || null;
}

export function getProjectsLinearLoadOrgId(menuItemId: string): string | null {
  if (!menuItemId.startsWith(PROJECTS_LINEAR_LOAD_PREFIX)) return null;
  return menuItemId.slice(PROJECTS_LINEAR_LOAD_PREFIX.length) || null;
}

export function getProjectsLocalOrgId(menuItemId: string): string | null {
  if (!menuItemId.startsWith(PROJECTS_LOCAL_ORG_PREFIX)) return null;
  return menuItemId.slice(PROJECTS_LOCAL_ORG_PREFIX.length) || null;
}

export function getProjectsLinearOrgId(menuItemId: string): string | null {
  if (!menuItemId.startsWith(PROJECTS_LINEAR_ORG_PREFIX)) return null;
  return menuItemId.slice(PROJECTS_LINEAR_ORG_PREFIX.length) || null;
}

export function getProjectsWorkItemCreateOrgId(
  menuItemId: string
): string | null {
  if (!menuItemId.startsWith(PROJECTS_WORK_ITEM_CREATE_PREFIX)) return null;
  return menuItemId.slice(PROJECTS_WORK_ITEM_CREATE_PREFIX.length) || null;
}

export function isProjectsWorkItemLoadMoreId(id: string): string | null {
  if (!id.startsWith(LOAD_MORE_GROUP_PREFIX)) return null;
  const groupId = id.slice(LOAD_MORE_GROUP_PREFIX.length);
  if (!groupId.startsWith(PROJECTS_WORK_ITEM_GROUP_PREFIX)) return null;
  return groupId;
}

export function getProjectsLinearOrgGroupId(orgId: string): string {
  return `${PROJECTS_WORK_ITEM_GROUP_PREFIX}org:${orgId}`;
}

export function isProjectsLinearOrgGroupId(groupId: string): boolean {
  return groupId.startsWith(`${PROJECTS_WORK_ITEM_GROUP_PREFIX}org:linear:`);
}
