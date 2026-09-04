import type { TFunction } from "i18next";
import React from "react";

import { DeliveryBox01Icon, HugeiconsIcon, Loading03Icon } from "@src/icons";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import { getProjectOverviewMenuItemId } from "./idHelpers";

export function separator(id: string, title = ""): NavigationMenuItem {
  return { id: `separator-${id}`, key: `separator-${id}`, label: title };
}

export function buildProjectOverviewRow(
  t: TFunction,
  projectSlug: string,
  projectName?: string,
  _projectSyncAdapterId?: string | null
): NavigationMenuItem {
  const id = getProjectOverviewMenuItemId(projectSlug);
  return {
    id,
    key: id,
    label: t("projects:orgs.management.overview"),
    icon: DeliveryBox01Icon,
    iconName: "box",
    dataTestId: `sidebar-project-overview-${projectSlug}`,
    opensChatPanelTab: true,
    dragPayload: {
      path: projectSlug,
      name: projectName ?? projectSlug,
      iconType: "project",
    },
  };
}

function pendingSyncIndicator(t: TFunction): React.ReactElement {
  const label = t("projects:orgs.pendingSync");
  return (
    <span
      title={label}
      aria-label={label}
      className="flex items-center"
      data-testid="sidebar-pending-sync-indicator"
    >
      <HugeiconsIcon
        icon={Loading03Icon}
        data-icon="loader-2"
        size={12}
        strokeWidth={2}
        className="animate-spin text-text-4"
      />
    </span>
  );
}

export function buildProjectRow(
  t: TFunction,
  projectSlug: string,
  projectName: string,
  pendingSync = false,
  _projectSyncAdapterId?: string | null
): NavigationMenuItem {
  const id = getProjectOverviewMenuItemId(projectSlug);
  return {
    id,
    key: id,
    label: projectName,
    icon: DeliveryBox01Icon,
    iconName: "box",
    dataTestId: `sidebar-project-overview-${projectSlug}`,
    opensChatPanelTab: true,
    workingIndicator: pendingSync ? pendingSyncIndicator(t) : undefined,
    dragPayload: {
      path: projectSlug,
      name: projectName,
      iconType: "project",
    },
  };
}
