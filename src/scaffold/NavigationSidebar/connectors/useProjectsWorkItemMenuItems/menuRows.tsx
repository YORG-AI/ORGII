import type { TFunction } from "i18next";
import React from "react";

import { STORY_SYNC_ADAPTER } from "@src/api/http/integrations/syncConnections";
import type { LinkedSession } from "@src/api/http/project";
import IntegrationIcon from "@src/components/IntegrationIcon";
import {
  BotIcon,
  ChevronsDownUpIcon,
  ComputerTerminal01Icon,
  DeliveryBox01Icon,
  HugeiconsIcon,
  Loading03Icon,
  MoreHorizontalIcon,
  UnfoldMoreIcon,
} from "@src/icons";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { renderBreathingStatusDot } from "@src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/statusIndicators";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { LOAD_MORE_GROUP_PREFIX } from "./constants";
import {
  getLinearWorkItemMenuItemId,
  getProjectOverviewMenuItemId,
  getWorkItemMenuItemId,
} from "./idHelpers";
import type { SidebarAnyWorkItem } from "./types";
import { statusIconElement, toWorkItemStatus } from "./workItemMapping";

const LINKED_SESSION_ROLE_LABEL_KEYS: Record<string, string> = {
  coding: "projects:workItems.agentWorkflow.roleSde",
  sde: "projects:workItems.agentWorkflow.roleSde",
  review: "projects:workItems.agentWorkflow.roleReview",
  follow_up: "projects:workItems.agentWorkflow.roleFollowUp",
  sub_agent: "projects:workItems.agentWorkflow.subAgentDefault",
};

const LINKED_SESSION_STATUS_LABEL_KEYS: Record<
  LinkedSession["status"],
  string
> = {
  running: "projects:workItems.agentWorkflow.statusRunning",
  completed: "projects:workItems.agentWorkflow.statusCompleted",
  failed: "projects:workItems.agentWorkflow.statusFailed",
  cancelled: "projects:workItems.agentWorkflow.statusCancelled",
};

const LINKED_SESSION_STATUS_DOT_CLASSES: Record<
  LinkedSession["status"],
  string
> = {
  running: "bg-primary-6",
  completed: "bg-success-6",
  failed: "bg-danger-6",
  cancelled: "bg-warning-6",
};

const LINKED_SESSION_NAME_MAX_LENGTH = 30;

interface WorkItemLinkedSessionExpansion {
  expanded: boolean;
  onToggle: () => void;
}

export function separator(id: string, title = ""): NavigationMenuItem {
  return { id: `separator-${id}`, key: `separator-${id}`, label: title };
}

export function groupLoadMoreRow(
  groupId: string,
  label: string
): NavigationMenuItem {
  return {
    id: `${LOAD_MORE_GROUP_PREFIX}${groupId}`,
    key: `${LOAD_MORE_GROUP_PREFIX}${groupId}`,
    label,
    icon: MoreHorizontalIcon,
    iconName: "more-horizontal",
    visualTone: "secondary",
  };
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
    visualTone: "secondary",
    dataTestId: `sidebar-project-overview-${projectSlug}`,
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
  pendingSync = false,
  linkedSessionExpansion?: WorkItemLinkedSessionExpansion
): NavigationMenuItem {
  const id =
    workItem.source === "local"
      ? getWorkItemMenuItemId(workItem.id)
      : getLinearWorkItemMenuItemId(workItem.id);

  const workItemPath =
    workItem.source === "local"
      ? `${(workItem as { projectSlug?: string }).projectSlug ?? ""}/${workItem.id}`
      : workItem.id;
  const statusIcon = statusIconElement(toWorkItemStatus(workItem.status));
  const isGitHubWorkItem =
    workItem.source === "local" &&
    workItem.projectSyncAdapterId === STORY_SYNC_ADAPTER.GITHUB;

  return {
    id,
    key: id,
    label: workItem.title || t("projects:workItems.untitledWorkItem"),
    iconElement: isGitHubWorkItem ? (
      <span
        className="inline-flex items-center gap-3"
        data-testid="sidebar-github-work-item-icons"
      >
        {statusIcon}
        <IntegrationIcon type={STORY_SYNC_ADAPTER.GITHUB} size={12} />
      </span>
    ) : (
      statusIcon
    ),
    dataTestId: `sidebar-work-item-${workItem.id}`,
    workingIndicator: pendingSync ? pendingSyncIndicator(t) : undefined,
    showMoreActions: Boolean(linkedSessionExpansion),
    rowActions: linkedSessionExpansion
      ? [
          {
            icon: linkedSessionExpansion.expanded
              ? ChevronsDownUpIcon
              : UnfoldMoreIcon,
            label: t("projects:workItems.sessions.linkedSessions"),
            active: linkedSessionExpansion.expanded,
            dataTestId: `sidebar-work-item-linked-sessions-toggle-${workItem.id}`,
            onClick: linkedSessionExpansion.onToggle,
          },
        ]
      : undefined,
    dragPayload: {
      path: workItemPath,
      name: workItem.title || t("projects:workItems.untitledWorkItem"),
      iconType: "workitem",
    },
  };
}

export function getNavigableLinkedSessions(
  workItem: SidebarAnyWorkItem
): LinkedSession[] {
  if (workItem.source !== "local") return [];
  return (workItem.linkedSessions ?? []).filter(
    (session) =>
      session.session_id.trim().length > 0 && session.session_id !== "pending"
  );
}

function linkedSessionStatusIndicator(
  t: TFunction,
  session: LinkedSession
): React.ReactElement {
  const label = t(LINKED_SESSION_STATUS_LABEL_KEYS[session.status]);
  return (
    <span
      aria-label={label}
      title={label}
      className={`h-1.5 w-1.5 rounded-full ${LINKED_SESSION_STATUS_DOT_CLASSES[session.status]}`}
    />
  );
}

function linkedSessionLabel(
  t: TFunction,
  session: LinkedSession,
  roleRunNumber: number
): string {
  const resultName = session.result_preview?.trim().replace(/\s+/g, " ");
  if (resultName) {
    return Array.from(resultName)
      .slice(0, LINKED_SESSION_NAME_MAX_LENGTH)
      .join("");
  }
  const roleLabelKey = LINKED_SESSION_ROLE_LABEL_KEYS[session.agent_role];
  const roleLabel = roleLabelKey
    ? t(roleLabelKey)
    : session.agent_role.replace(/_/g, " ");
  const baseLabel = session.sub_agent_name?.trim() || roleLabel;
  const runNumber = session.sub_agent_instance ?? roleRunNumber;
  return Array.from(`${baseLabel} #${runNumber}`)
    .slice(0, LINKED_SESSION_NAME_MAX_LENGTH)
    .join("");
}

export function buildLinkedSessionRows(
  t: TFunction,
  workItem: SidebarAnyWorkItem
): NavigationMenuItem[] {
  const roleRunCounts = new Map<string, number>();
  return getNavigableLinkedSessions(workItem).map((session) => {
    const roleRunNumber = (roleRunCounts.get(session.agent_role) ?? 0) + 1;
    roleRunCounts.set(session.agent_role, roleRunNumber);
    const label = linkedSessionLabel(t, session, roleRunNumber);
    const timestamp = session.completed_at ?? session.started_at;

    return {
      id: session.session_id,
      key: `work-item-linked-session:${workItem.id}:${session.session_id}`,
      label,
      searchText: `${label} ${session.session_id}`,
      icon: session.session_type === "cli" ? ComputerTerminal01Icon : BotIcon,
      visualTone: "secondary",
      showIndentGuide: true,
      dataTestId: `sidebar-work-item-linked-session-${workItem.id}-${session.session_id}`,
      iconBadge:
        session.status === "running"
          ? renderBreathingStatusDot()
          : linkedSessionStatusIndicator(t, session),
      shortcut: formatRelativeTime(timestamp, "nano"),
      dragPayload: {
        path: `session://${session.session_id}`,
        name: label,
        iconType: "session",
      },
    };
  });
}
