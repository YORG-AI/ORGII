import {
  Calendar,
  Circle,
  CircleDot,
  Code2,
  Copy,
  ExternalLink,
  Flag,
  HeartPulse,
  MoreHorizontal,
  Tag,
  Trash2,
  User,
  Users,
} from "lucide-react";
import { createElement } from "react";

import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import {
  getHealthConfig,
  getProjectPriorityConfig,
} from "@src/modules/ProjectManager/config/manage";
import type {
  ContextMenuItem,
  Label,
  Person,
  Team,
} from "@src/types/core/shared";

import {
  HEALTH_OPTIONS,
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
} from "../shared/components/PropertiesPanel/config";
import type {
  LinkedRepoOption,
  ProjectData,
  ProjectPropertyFieldKey,
} from "../shared/components/PropertiesPanel/types";

type ProjectPropertyAction = Exclude<ProjectPropertyFieldKey, "completion">;

type ProjectContextMenuTranslator = (
  key: string,
  options?: Record<string, unknown>
) => string;

interface ProjectContextMenuOptions {
  project: ProjectData;
  t: ProjectContextMenuTranslator;
  onPropertyAction?: (action: ProjectPropertyAction, value?: string) => void;
  availableMembers?: Person[];
  availableTeams?: Team[];
  availableLabels?: Label[];
  availableRepos?: LinkedRepoOption[];
  propertyFields?: ProjectPropertyAction[];
  onOpen?: () => void;
  onCopy?: () => void;
  onDelete?: () => void;
  includeBaseActions?: boolean;
}

const DEFAULT_PROPERTY_FIELDS: ProjectPropertyAction[] = [
  "status",
  "priority",
  "lead",
  "targetDate",
  "health",
  "members",
  "teams",
  "labels",
  "linkedRepos",
  "startDate",
];

function formatMenuDate(dateString: string | undefined, fallback: string) {
  if (!dateString) return fallback;
  return new Date(dateString).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function getRepoDisplayName(repo: LinkedRepoOption) {
  const rawName = repo.name || repo.id;
  const parts = rawName.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? rawName;
}

function createMemberSubmenu(
  selectedMemberIds: Set<string>,
  availableMembers: Person[],
  onAction: ((value?: string) => void) | undefined,
  emptyLabel: string
): ContextMenuItem[] {
  if (availableMembers.length === 0) {
    return [{ id: "members-empty", label: emptyLabel, disabled: true }];
  }
  return availableMembers.map((member) => ({
    id: `member-${member.id}`,
    label: member.name,
    secondary: selectedMemberIds.has(member.id) ? "✓" : undefined,
    action: onAction ? () => onAction(member.id) : undefined,
    disabled: !onAction,
  }));
}

function createTeamSubmenu(
  selectedTeamIds: Set<string>,
  availableTeams: Team[],
  onAction: ((value?: string) => void) | undefined,
  emptyLabel: string
): ContextMenuItem[] {
  if (availableTeams.length === 0) {
    return [{ id: "teams-empty", label: emptyLabel, disabled: true }];
  }
  return availableTeams.map((team) => ({
    id: `team-${team.id}`,
    label: team.name,
    secondary: selectedTeamIds.has(team.id) ? "✓" : undefined,
    action: onAction ? () => onAction(team.id) : undefined,
    disabled: !onAction,
  }));
}

function createLabelSubmenu(
  selectedLabelIds: Set<string>,
  availableLabels: Label[],
  onAction: ((value?: string) => void) | undefined,
  emptyLabel: string
): ContextMenuItem[] {
  if (availableLabels.length === 0) {
    return [{ id: "labels-empty", label: emptyLabel, disabled: true }];
  }
  return availableLabels.map((label) => ({
    id: `label-${label.id}`,
    label: label.name,
    icon: createElement("span", {
      className: "h-2 w-2 rounded-full",
      style: { backgroundColor: label.color },
    }),
    secondary: selectedLabelIds.has(label.id) ? "✓" : undefined,
    action: onAction ? () => onAction(label.id) : undefined,
    disabled: !onAction,
  }));
}

function createRepoSubmenu(
  selectedRepoIds: Set<string>,
  availableRepos: LinkedRepoOption[],
  onAction: ((value?: string) => void) | undefined,
  emptyLabel: string
): ContextMenuItem[] {
  if (availableRepos.length === 0) {
    return [{ id: "repos-empty", label: emptyLabel, disabled: true }];
  }
  return availableRepos.map((repo) => ({
    id: `repo-${repo.id}`,
    label: getRepoDisplayName(repo),
    icon: createElement(Code2, { size: DROPDOWN_ITEM.iconSize }),
    secondary: selectedRepoIds.has(repo.id) ? "✓" : undefined,
    action: onAction ? () => onAction(repo.id) : undefined,
    disabled: !onAction,
  }));
}

export function getProjectPropertyContextMenuItems({
  project,
  t,
  onPropertyAction,
  availableMembers = [],
  availableTeams = [],
  availableLabels = [],
  availableRepos = [],
  propertyFields = DEFAULT_PROPERTY_FIELDS,
}: ProjectContextMenuOptions): ContextMenuItem[] {
  const fieldSet = new Set<ProjectPropertyAction>(propertyFields);
  const selectedMemberIds = new Set(
    project.members?.map((member) => member.id)
  );
  const selectedTeamIds = new Set(project.teams?.map((team) => team.id));
  const selectedLabelIds = new Set(project.labels?.map((label) => label.id));
  const selectedRepoIds = new Set(project.linkedRepos?.map((repo) => repo.id));

  const primaryItems: ContextMenuItem[] = [];

  if (fieldSet.has("status")) {
    const currentStatus = STATUS_OPTIONS.find(
      (option) => option.value === project.status
    );
    primaryItems.push({
      id: "status",
      label: t("properties.status"),
      icon: createElement(CircleDot, { size: DROPDOWN_ITEM.iconSize }),
      secondary: currentStatus
        ? t(currentStatus.labelKey)
        : t("properties.noStatus"),
      keybinding: "s",
      submenu: STATUS_OPTIONS.map((option) => ({
        id: `status-${option.value}`,
        label: t(option.labelKey),
        icon: createElement(Circle, { size: DROPDOWN_ITEM.iconSize }),
        iconColor: option.color,
        action: onPropertyAction
          ? () => onPropertyAction("status", option.value)
          : undefined,
        disabled: !onPropertyAction,
      })),
    });
  }

  if (fieldSet.has("priority")) {
    const currentPriority = PRIORITY_OPTIONS.find(
      (option) => option.value === project.priority
    );
    primaryItems.push({
      id: "priority",
      label: t("properties.priority"),
      icon: createElement(Flag, { size: DROPDOWN_ITEM.iconSize }),
      secondary: currentPriority
        ? t(currentPriority.labelKey)
        : t("properties.noPriority"),
      keybinding: "p",
      submenu: PRIORITY_OPTIONS.map((option) => {
        const priorityConfig = getProjectPriorityConfig(option.value);
        return {
          id: `priority-${option.value}`,
          label: t(option.labelKey),
          icon: priorityConfig.icon,
          iconColor: priorityConfig.color,
          action: onPropertyAction
            ? () => onPropertyAction("priority", option.value)
            : undefined,
          disabled: !onPropertyAction,
        };
      }),
    });
  }

  if (fieldSet.has("lead")) {
    primaryItems.push({
      id: "lead",
      label: t("properties.lead"),
      icon: createElement(User, { size: DROPDOWN_ITEM.iconSize }),
      secondary: project.lead?.name ?? t("properties.noLead"),
      keybinding: "l",
      submenu: [
        {
          id: "lead-none",
          label: t("properties.noLead"),
          action: onPropertyAction
            ? () => onPropertyAction("lead", undefined)
            : undefined,
          disabled: !onPropertyAction,
        },
        ...availableMembers.map((member) => ({
          id: `lead-${member.id}`,
          label: member.name,
          secondary: project.lead?.id === member.id ? "✓" : undefined,
          action: onPropertyAction
            ? () => onPropertyAction("lead", member.id)
            : undefined,
          disabled: !onPropertyAction,
        })),
      ],
    });
  }

  if (fieldSet.has("targetDate")) {
    primaryItems.push({
      id: "targetDate",
      label: t("properties.targetDate"),
      icon: createElement(Calendar, { size: DROPDOWN_ITEM.iconSize }),
      secondary: formatMenuDate(project.targetDate, t("properties.addDate")),
      action: onPropertyAction
        ? () => onPropertyAction("targetDate")
        : undefined,
      disabled: !onPropertyAction,
    });
  }

  const moreItems: ContextMenuItem[] = [];
  if (fieldSet.has("health")) {
    const currentHealth = HEALTH_OPTIONS.find(
      (option) => option.value === project.health
    );
    moreItems.push({
      id: "health",
      label: t("properties.health"),
      icon: createElement(HeartPulse, { size: DROPDOWN_ITEM.iconSize }),
      secondary: currentHealth
        ? t(currentHealth.labelKey)
        : t("properties.noUpdates"),
      submenu: HEALTH_OPTIONS.map((option) => {
        const healthConfig = getHealthConfig(option.value);
        return {
          id: `health-${option.value}`,
          label: t(option.labelKey),
          icon: healthConfig.icon,
          iconColor: healthConfig.color,
          action: onPropertyAction
            ? () => onPropertyAction("health", option.value)
            : undefined,
          disabled: !onPropertyAction,
        };
      }),
    });
  }
  if (fieldSet.has("members")) {
    moreItems.push({
      id: "members",
      label: t("properties.members"),
      icon: createElement(Users, { size: DROPDOWN_ITEM.iconSize }),
      secondary: project.members?.length
        ? t("properties.memberCount", { count: project.members.length })
        : t("properties.addMembers"),
      submenu: createMemberSubmenu(
        selectedMemberIds,
        availableMembers,
        onPropertyAction
          ? (value) => onPropertyAction("members", value)
          : undefined,
        t("properties.addMembers")
      ),
    });
  }
  if (fieldSet.has("teams")) {
    moreItems.push({
      id: "teams",
      label: t("properties.teams"),
      icon: createElement(Users, { size: DROPDOWN_ITEM.iconSize }),
      secondary: project.teams?.length
        ? project.teams.map((team) => team.name).join(", ")
        : t("properties.addTeams"),
      submenu: createTeamSubmenu(
        selectedTeamIds,
        availableTeams,
        onPropertyAction
          ? (value) => onPropertyAction("teams", value)
          : undefined,
        t("properties.noTeamsHint")
      ),
    });
  }
  if (fieldSet.has("labels")) {
    moreItems.push({
      id: "labels",
      label: t("properties.labels"),
      icon: createElement(Tag, { size: DROPDOWN_ITEM.iconSize }),
      secondary: project.labels?.length
        ? project.labels.map((label) => label.name).join(", ")
        : t("properties.addLabels"),
      submenu: createLabelSubmenu(
        selectedLabelIds,
        availableLabels,
        onPropertyAction
          ? (value) => onPropertyAction("labels", value)
          : undefined,
        t("properties.addLabels")
      ),
    });
  }
  if (fieldSet.has("linkedRepos")) {
    moreItems.push({
      id: "linkedRepos",
      label: t("properties.repos"),
      icon: createElement(Code2, { size: DROPDOWN_ITEM.iconSize }),
      secondary: project.linkedRepos?.length
        ? project.linkedRepos.map(getRepoDisplayName).join(", ")
        : t("properties.addRepos"),
      submenu: createRepoSubmenu(
        selectedRepoIds,
        availableRepos,
        onPropertyAction
          ? (value) => onPropertyAction("linkedRepos", value)
          : undefined,
        t("properties.noReposHint")
      ),
    });
  }
  if (fieldSet.has("startDate")) {
    moreItems.push({
      id: "startDate",
      label: t("properties.startDate"),
      icon: createElement(Calendar, { size: DROPDOWN_ITEM.iconSize }),
      secondary: formatMenuDate(project.startDate, t("properties.addDate")),
      action: onPropertyAction
        ? () => onPropertyAction("startDate")
        : undefined,
      disabled: !onPropertyAction,
    });
  }

  if (moreItems.length === 0) return primaryItems;

  return [
    ...primaryItems,
    {
      id: "more-properties",
      label: t("workItems.contextMenu.moreProperties"),
      icon: createElement(MoreHorizontal, { size: DROPDOWN_ITEM.iconSize }),
      submenu: moreItems,
    },
  ];
}

export function getProjectContextMenuItems(options: ProjectContextMenuOptions) {
  const {
    project,
    t,
    onOpen,
    onCopy,
    onDelete,
    includeBaseActions = true,
  } = options;
  const propertyItems = getProjectPropertyContextMenuItems(options);
  if (!includeBaseActions) return propertyItems;

  const items: ContextMenuItem[] = [
    {
      id: "open",
      label: t("common:actions.open"),
      icon: createElement(ExternalLink, { size: DROPDOWN_ITEM.iconSize }),
      secondary:
        project.completionPercentage === undefined
          ? undefined
          : String(project.completionPercentage),
      action: onOpen,
      disabled: !onOpen,
    },
    {
      id: "copy",
      label: t("common:actions.copy"),
      icon: createElement(Copy, { size: DROPDOWN_ITEM.iconSize }),
      secondary: project.name,
      action: onCopy,
      disabled: !onCopy,
    },
    { id: "divider-properties", label: "", divider: true },
    ...propertyItems,
  ];
  if (onDelete) {
    items.push(
      { id: "divider-delete", label: "", divider: true },
      {
        id: "delete",
        label: t("common:actions.delete"),
        icon: createElement(Trash2, { size: DROPDOWN_ITEM.iconSize }),
        shortcutId: "workitem_delete",
        action: onDelete,
      }
    );
  }
  return items;
}
