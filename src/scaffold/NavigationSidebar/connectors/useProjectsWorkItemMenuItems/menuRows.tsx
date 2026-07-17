import type { TFunction } from "i18next";
import { Box, Loader2, MoreHorizontal, Network, SquarePen } from "lucide-react";
import React from "react";

import IntegrationIcon from "@src/components/IntegrationIcon";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import {
  LOAD_MORE_GROUP_PREFIX,
  PROJECTS_LINEAR_LOAD_PREFIX,
  PROJECTS_WORK_ITEM_CREATE_PREFIX,
} from "./constants";
import {
  getLinearOrgMenuItemId,
  getLinearWorkItemMenuItemId,
  getLocalOrgMenuItemId,
  getProjectOverviewMenuItemId,
  getWorkItemMenuItemId,
} from "./idHelpers";
import type { SidebarAnyWorkItem } from "./types";
import { statusIconElement, toWorkItemStatus } from "./workItemMapping";

export function separator(id: string, title = ""): NavigationMenuItem {
  return { id: `separator-${id}`, key: `separator-${id}`, label: title };
}

function localOrgMenuRow(id: string, label: string): NavigationMenuItem {
  return {
    id,
    key: id,
    label,
    icon: Network,
    iconName: "network",
    visualTone: "secondary",
  };
}

export function localOrgRow(orgId: string, label: string): NavigationMenuItem {
  return localOrgMenuRow(getLocalOrgMenuItemId(orgId), label);
}

export function linearOrgRow(orgId: string, label: string): NavigationMenuItem {
  const id = getLinearOrgMenuItemId(orgId);
  return {
    id,
    key: id,
    label,
    iconElement: <IntegrationIcon type="linear" size={14} />,
    visualTone: "secondary",
  };
}

export function groupLoadMoreRow(
  groupId: string,
  label: string
): NavigationMenuItem {
  return {
    id: `${LOAD_MORE_GROUP_PREFIX}${groupId}`,
    key: `${LOAD_MORE_GROUP_PREFIX}${groupId}`,
    label,
    icon: MoreHorizontal,
    iconName: "more-horizontal",
    visualTone: "secondary",
  };
}

export function linearLoadRow(
  orgId: string,
  label: string,
  loading: boolean
): NavigationMenuItem {
  return {
    id: `${PROJECTS_LINEAR_LOAD_PREFIX}${orgId}`,
    key: `${PROJECTS_LINEAR_LOAD_PREFIX}${orgId}`,
    label,
    icon: loading ? undefined : MoreHorizontal,
    iconName: loading ? undefined : "more-horizontal",
    iconElement: loading ? (
      <Loader2 size={14} strokeWidth={2} className="animate-spin" />
    ) : undefined,
    visualTone: "secondary",
    disabled: loading,
  };
}

export function createWorkItemRow(
  orgId: string,
  label: string
): NavigationMenuItem {
  const id = `${PROJECTS_WORK_ITEM_CREATE_PREFIX}${orgId}`;
  return {
    id,
    key: id,
    label,
    icon: SquarePen,
    iconName: "square-pen",
    visualTone: "secondary",
    dataTestId: `projects-work-item-create-${orgId}`,
  };
}

export function buildProjectOverviewRow(
  t: TFunction,
  projectSlug: string,
  projectName?: string
): NavigationMenuItem {
  const id = getProjectOverviewMenuItemId(projectSlug);
  return {
    id,
    key: id,
    label: t("projects:orgs.management.overview"),
    icon: Box,
    iconName: "box",
    visualTone: "secondary",
    dataTestId: `sidebar-project-overview-${projectSlug}`,
    dragPayload: {
      path: projectSlug,
      name: projectName ?? projectSlug,
      iconType: "project",
    },
  };
}

export function pendingSyncIndicator(t: TFunction): React.ReactElement {
  const label = t("projects:orgs.pendingSync");
  return (
    <span
      title={label}
      aria-label={label}
      className="flex items-center"
      data-testid="sidebar-pending-sync-indicator"
    >
      <Loader2 size={12} strokeWidth={2} className="animate-spin text-text-4" />
    </span>
  );
}

export function buildProjectRow(
  t: TFunction,
  projectSlug: string,
  projectName: string,
  pendingSync = false
): NavigationMenuItem {
  const id = getProjectOverviewMenuItemId(projectSlug);
  return {
    id,
    key: id,
    label: projectName,
    icon: Box,
    iconName: "box",
    visualTone: "secondary",
    dataTestId: `sidebar-project-overview-${projectSlug}`,
    workingIndicator: pendingSync ? pendingSyncIndicator(t) : undefined,
    dragPayload: {
      path: projectSlug,
      name: projectName,
      iconType: "project",
    },
  };
}

export function buildWorkItemRow(
  t: TFunction,
  workItem: SidebarAnyWorkItem,
  pendingSync = false
): NavigationMenuItem {
  const id =
    workItem.source === "local"
      ? getWorkItemMenuItemId(workItem.id)
      : getLinearWorkItemMenuItemId(workItem.id);

  const workItemPath =
    workItem.source === "local"
      ? `${(workItem as { projectSlug?: string }).projectSlug ?? ""}/${workItem.id}`
      : workItem.id;

  return {
    id,
    key: id,
    label: workItem.title || t("projects:workItems.untitledWorkItem"),
    iconElement: statusIconElement(toWorkItemStatus(workItem.status)),
    dataTestId: `sidebar-work-item-${workItem.id}`,
    workingIndicator: pendingSync ? pendingSyncIndicator(t) : undefined,
    dragPayload: {
      path: workItemPath,
      name: workItem.title || t("projects:workItems.untitledWorkItem"),
      iconType: "workitem",
    },
  };
}
