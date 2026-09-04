/**
 * WorkItem Configuration
 *
 * Re-exports from centralized config and additional WorkItem-specific configs.
 */
import React from "react";

import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import {
  Calendar01Icon,
  CircleDotIcon,
  CircleIcon,
  Delete02Icon,
  DeliveryBox01Icon,
  DiamondIcon,
  Flag01Icon,
  HugeiconsIcon,
  ListChevronsDownUpIcon,
  Pen01Icon,
  SignalFull01Icon,
  Tag01Icon,
  UserIcon,
  UserMultipleIcon,
} from "@src/icons";
import {
  ENTITY_COLORS,
  MILESTONE_COLORS,
  WORK_ITEM_PRIORITY_OPTIONS,
  WORK_ITEM_STATUS_OPTIONS,
} from "@src/modules/ProjectManager/config/manage";
import type {
  ContextMenuItem,
  DropdownOption,
  Person,
} from "@src/types/core/shared";
import type {
  WorkItem,
  WorkItemLabel,
  WorkItemMilestone,
  WorkItemProject,
} from "@src/types/core/workItem";

// Re-export from centralized config
export {
  STATUS_COLORS,
  PRIORITY_COLORS,
  ENTITY_COLORS as STORY_COLORS,
  MILESTONE_COLORS,
  LABEL_COLORS,
  DEFAULT_LABELS,
  WORK_ITEM_STATUS_OPTIONS as STATUS_OPTIONS,
  WORK_ITEM_PRIORITY_OPTIONS as PRIORITY_OPTIONS,
  getWorkItemStatusConfig as getStatusConfig,
  getWorkItemPriorityConfig as getPriorityConfig,
} from "@src/modules/ProjectManager/config/manage";

// ============================================
// Project & Milestone Options (mock data)
// ============================================

// i18n keys for labels - consumers must translate using t()
export const MILESTONE_OPTIONS_KEY = "workItems.properties.noMilestone";

// Mock milestone options (replace with API data)
export const MILESTONE_OPTIONS: DropdownOption<string>[] = [
  {
    value: "none",
    label: MILESTONE_OPTIONS_KEY,
    icon: React.createElement(HugeiconsIcon, {
      icon: DiamondIcon,
      size: DROPDOWN_ITEM.iconSize,
      opacity: 0.5,
    }),
    color: MILESTONE_COLORS.active,
  },
];

// ============================================
// Property Field Configuration
// ============================================

export interface PropertyFieldConfig {
  key: string;
  label: string;
  icon: React.ReactNode;
  type:
    | "status"
    | "priority"
    | "person"
    | "label"
    | "project"
    | "milestone"
    | "date"
    | "text";
  editable?: boolean;
}

export const PROPERTY_FIELDS: PropertyFieldConfig[] = [
  {
    key: "workItemStatus",
    label: "workItems.propertyFields.status",
    icon: React.createElement(HugeiconsIcon, {
      icon: CircleIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    type: "status",
    editable: true,
  },
  {
    key: "priority",
    label: "workItems.propertyFields.priority",
    icon: React.createElement(HugeiconsIcon, {
      icon: SignalFull01Icon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    type: "priority",
    editable: true,
  },
  {
    key: "assignee",
    label: "workItems.propertyFields.assignee",
    icon: React.createElement(HugeiconsIcon, {
      icon: UserIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    type: "person",
    editable: true,
  },
  {
    key: "labels",
    label: "workItems.propertyFields.labels",
    icon: React.createElement(HugeiconsIcon, {
      icon: Tag01Icon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    type: "label",
    editable: true,
  },
  {
    key: "project",
    label: "workItems.propertyFields.project",
    icon: React.createElement(HugeiconsIcon, {
      icon: DeliveryBox01Icon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    type: "project",
    editable: true,
  },
  {
    key: "milestone",
    label: "workItems.propertyFields.milestone",
    icon: React.createElement(HugeiconsIcon, {
      icon: DiamondIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    type: "milestone",
    editable: true,
  },
  {
    key: "endDate",
    label: "workItems.propertyFields.dueDate",
    icon: React.createElement(HugeiconsIcon, {
      icon: Calendar01Icon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    type: "date",
    editable: true,
  },
];

// ============================================
// Work Item ID Prefix
// ============================================

const WORK_ITEM_PREFIX_LENGTH = 3;
const DEFAULT_WORK_ITEM_PREFIX = "STR";

export function deriveWorkItemPrefix(projectName: string): string {
  const alphanumeric = projectName.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!alphanumeric) {
    return DEFAULT_WORK_ITEM_PREFIX;
  }
  return alphanumeric
    .slice(0, WORK_ITEM_PREFIX_LENGTH)
    .padEnd(WORK_ITEM_PREFIX_LENGTH, "X");
}

export function getEffectiveWorkItemPrefix(
  projectName: string,
  storedPrefix: string | undefined,
  isCustom: boolean | undefined
): string {
  if (isCustom && storedPrefix) return storedPrefix;
  return deriveWorkItemPrefix(projectName);
}

// ============================================
// Helper Functions
// ============================================

export function createProjectOption(
  project: WorkItemProject
): DropdownOption<string> {
  return {
    value: project.id,
    label: project.name,
    icon: React.createElement(HugeiconsIcon, {
      icon: DeliveryBox01Icon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: project.color || ENTITY_COLORS.blue,
  };
}

export function createMilestoneOption(
  milestone: WorkItemMilestone
): DropdownOption<string> {
  return {
    value: milestone.id,
    label: milestone.name,
    icon: React.createElement(HugeiconsIcon, {
      icon: DiamondIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: MILESTONE_COLORS.active,
  };
}

// ============================================
// Context Menu Configuration
// ============================================

interface WorkItemContextMenuOptions {
  workItem?: WorkItem;
  availableMembers?: Person[];
  availableLabels?: WorkItemLabel[];
  availableProjects?: WorkItemProject[];
  availableMilestones?: WorkItemMilestone[];
}

function getTranslatedOptionLabel(
  value: string | undefined,
  options: Array<{ value: string; label: string }>,
  namespace: string,
  fallback: string,
  tr: (key: string, fallback: string) => string
) {
  const option = options.find((entry) => entry.value === value);
  if (!option) return fallback;
  return tr(`${namespace}.${option.value}`, option.label);
}

function formatMenuDate(date: string | undefined, fallback: string) {
  if (!date) return fallback;
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function createAssigneeSubmenu(
  workItem: WorkItem | undefined,
  availableMembers: Person[],
  tr: (key: string, fallback: string) => string,
  onAction: (action: string, value?: string) => void
): ContextMenuItem[] {
  return [
    {
      id: "assignee-none",
      label: tr("workItems.properties.noAssignee", "No assignee"),
      icon: React.createElement(HugeiconsIcon, {
        icon: UserIcon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      action: () => onAction("assignee", "none"),
    },
    ...availableMembers.map((member) => ({
      id: `assignee-${member.id}`,
      label: member.name,
      icon: React.createElement(HugeiconsIcon, {
        icon: UserIcon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      secondary: workItem?.assignee?.id === member.id ? "✓" : undefined,
      action: () => onAction("assignee", member.id),
    })),
  ];
}

function createLeadSubmenu(
  workItem: WorkItem | undefined,
  availableMembers: Person[],
  tr: (key: string, fallback: string) => string,
  onAction: (action: string, value?: string) => void
): ContextMenuItem[] {
  return [
    {
      id: "lead-none",
      label: tr("workItems.properties.noAssignee", "No assignee"),
      icon: React.createElement(HugeiconsIcon, {
        icon: UserIcon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      action: () => onAction("lead", "none"),
    },
    ...availableMembers.map((member) => ({
      id: `lead-${member.id}`,
      label: member.name,
      icon: React.createElement(HugeiconsIcon, {
        icon: UserIcon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      secondary: workItem?.lead?.some((person) => person.id === member.id)
        ? "✓"
        : undefined,
      action: () => onAction("lead", member.id),
    })),
  ];
}

function createMembersSubmenu(
  workItem: WorkItem | undefined,
  availableMembers: Person[],
  tr: (key: string, fallback: string) => string,
  onAction: (action: string, value?: string) => void
): ContextMenuItem[] {
  if (availableMembers.length === 0) {
    return [
      {
        id: "members-empty",
        label: tr("workItems.properties.noMembersHint", "No members"),
        disabled: true,
      },
    ];
  }
  return availableMembers.map((member) => ({
    id: `member-${member.id}`,
    label: member.name,
    icon: React.createElement(HugeiconsIcon, {
      icon: UserIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    secondary: workItem?.members?.some((person) => person.id === member.id)
      ? "✓"
      : undefined,
    action: () => onAction("member", member.id),
  }));
}

function createLabelsSubmenu(
  workItem: WorkItem | undefined,
  availableLabels: WorkItemLabel[],
  tr: (key: string, fallback: string) => string,
  onAction: (action: string, value?: string) => void
): ContextMenuItem[] {
  if (availableLabels.length === 0) {
    return [
      {
        id: "labels-empty",
        label: tr("workItems.properties.noLabels", "No labels"),
        disabled: true,
      },
    ];
  }
  return availableLabels.map((label) => ({
    id: `label-${label.id}`,
    label: label.name,
    icon: React.createElement(HugeiconsIcon, {
      icon: Tag01Icon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    iconColor: label.color,
    secondary: workItem?.labels?.some((item) => item.id === label.id)
      ? "✓"
      : undefined,
    action: () => onAction("label", label.id),
  }));
}

function createProjectSubmenu(
  workItem: WorkItem | undefined,
  availableProjects: WorkItemProject[],
  onAction: (action: string, value?: string) => void
): ContextMenuItem[] {
  return [
    ...availableProjects.map((project) => ({
      id: `project-${project.id}`,
      label: project.name,
      icon: React.createElement(HugeiconsIcon, {
        icon: DeliveryBox01Icon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      iconColor: project.color,
      secondary: workItem?.project?.id === project.id ? "✓" : undefined,
      action: () => onAction("project", project.id),
    })),
  ];
}

function createMilestoneSubmenu(
  workItem: WorkItem | undefined,
  availableMilestones: WorkItemMilestone[],
  tr: (key: string, fallback: string) => string,
  onAction: (action: string, value?: string) => void
): ContextMenuItem[] {
  return [
    {
      id: "milestone-none",
      label: tr("workItems.properties.noMilestone", "No milestone"),
      icon: React.createElement(HugeiconsIcon, {
        icon: DiamondIcon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      action: () => onAction("milestone", "none"),
    },
    ...availableMilestones.map((milestone) => ({
      id: `milestone-${milestone.id}`,
      label: milestone.name,
      icon: React.createElement(HugeiconsIcon, {
        icon: DiamondIcon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      secondary: workItem?.milestone?.id === milestone.id ? "✓" : undefined,
      action: () => onAction("milestone", milestone.id),
    })),
  ];
}

export const getContextMenuItems = (
  onAction: (action: string, value?: string) => void,
  t?: (key: string) => string,
  options: WorkItemContextMenuOptions = {}
): ContextMenuItem[] => {
  const tr = (key: string, fallback: string) => {
    if (!t) return fallback;
    const translated = t(key);
    return translated === key ? fallback : translated;
  };
  const workItem = options.workItem;
  const availableMembers = options.availableMembers ?? [];
  const availableLabels = options.availableLabels ?? [];
  const availableProjects = options.availableProjects ?? [];
  const availableMilestones = options.availableMilestones ?? [];
  const statusValue = workItem?.workItemStatus || "planned";
  const priorityValue = workItem?.priority || "none";
  const labelsValue = workItem?.labels?.length
    ? workItem.labels.map((label) => label.name).join(", ")
    : tr("workItems.properties.noLabels", "No labels");
  const leadValue = workItem?.lead?.length
    ? workItem.lead.map((person) => person.name).join(", ")
    : tr("workItems.properties.noAssignee", "No assignee");
  const membersValue = workItem?.members?.length
    ? workItem.members.map((person) => person.name).join(", ")
    : tr("workItems.properties.noMembersHint", "No members");

  return [
    {
      id: "status",
      label: tr("workItems.contextMenu.status", "Status"),
      icon: React.createElement(HugeiconsIcon, {
        icon: CircleDotIcon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      secondary: getTranslatedOptionLabel(
        statusValue,
        WORK_ITEM_STATUS_OPTIONS,
        "workItems.statusLabels",
        tr("properties.noStatus", "No status"),
        tr
      ),
      keybinding: "s",
      submenu: WORK_ITEM_STATUS_OPTIONS.map((opt) => ({
        id: `status-${opt.value}`,
        label: tr(`workItems.statusLabels.${opt.value}`, opt.label),
        icon: opt.icon,
        iconColor: opt.color,
        action: () => onAction("status", opt.value),
      })),
    },
    {
      id: "priority",
      label: tr("workItems.contextMenu.priority", "Priority"),
      icon: React.createElement(HugeiconsIcon, {
        icon: Flag01Icon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      secondary: getTranslatedOptionLabel(
        priorityValue,
        WORK_ITEM_PRIORITY_OPTIONS,
        "workItems.priorityLabels",
        tr("properties.noPriority", "No priority"),
        tr
      ),
      keybinding: "p",
      submenu: WORK_ITEM_PRIORITY_OPTIONS.map((opt) => ({
        id: `priority-${opt.value}`,
        label: tr(`workItems.priorityLabels.${opt.value}`, opt.label),
        icon: opt.icon,
        iconColor: opt.color,
        action: () => onAction("priority", opt.value),
      })),
    },
    {
      id: "assignee",
      label: tr("workItems.contextMenu.assignee", "Assignee"),
      icon: React.createElement(HugeiconsIcon, {
        icon: UserIcon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      secondary:
        workItem?.assignee?.name ??
        tr("workItems.properties.noAssignee", "No assignee"),
      keybinding: "a",
      submenu: createAssigneeSubmenu(workItem, availableMembers, tr, onAction),
    },
    {
      id: "due-date",
      label: tr("workItems.contextMenu.setDueDate", "Set due date"),
      icon: React.createElement(HugeiconsIcon, {
        icon: Calendar01Icon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      secondary: formatMenuDate(
        workItem?.endDate,
        tr("workItems.properties.noDueDate", "No due date")
      ),
      shortcutId: "workitem_due_date",
      action: () => onAction("due-date"),
    },
    {
      id: "labels",
      label: tr("workItems.contextMenu.labels", "Labels"),
      icon: React.createElement(HugeiconsIcon, {
        icon: Tag01Icon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      secondary: labelsValue,
      keybinding: "l",
      submenu: createLabelsSubmenu(workItem, availableLabels, tr, onAction),
    },
    {
      id: "project",
      label: tr("workItems.contextMenu.project", "Project"),
      icon: React.createElement(HugeiconsIcon, {
        icon: DeliveryBox01Icon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      secondary:
        workItem?.project?.name ??
        tr("workItems.untitledProject", "Untitled Project"),
      shortcutId: "workitem_story",
      submenu: createProjectSubmenu(workItem, availableProjects, onAction),
    },
    {
      id: "more-properties",
      label: tr("workItems.contextMenu.moreProperties", "More properties"),
      icon: React.createElement(HugeiconsIcon, {
        icon: ListChevronsDownUpIcon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      submenu: [
        {
          id: "lead",
          label: tr("workItems.contextMenu.lead", "Lead"),
          icon: React.createElement(HugeiconsIcon, {
            icon: UserIcon,
            size: DROPDOWN_ITEM.iconSize,
          }),
          secondary: leadValue,
          submenu: createLeadSubmenu(workItem, availableMembers, tr, onAction),
        },
        {
          id: "members",
          label: tr("workItems.contextMenu.members", "Members"),
          icon: React.createElement(HugeiconsIcon, {
            icon: UserMultipleIcon,
            size: DROPDOWN_ITEM.iconSize,
          }),
          secondary: membersValue,
          submenu: createMembersSubmenu(
            workItem,
            availableMembers,
            tr,
            onAction
          ),
        },
        {
          id: "milestone",
          label: tr("workItems.contextMenu.milestone", "Milestone"),
          icon: React.createElement(HugeiconsIcon, {
            icon: DiamondIcon,
            size: DROPDOWN_ITEM.iconSize,
          }),
          secondary:
            workItem?.milestone?.name ??
            tr("workItems.properties.noMilestone", "No milestone"),
          keybinding: "m",
          submenu: createMilestoneSubmenu(
            workItem,
            availableMilestones,
            tr,
            onAction
          ),
        },
      ],
    },
    { id: "divider-1", label: "", divider: true },
    {
      id: "rename",
      label: tr("workItems.contextMenu.rename", "Rename..."),
      icon: React.createElement(HugeiconsIcon, {
        icon: Pen01Icon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      shortcutId: "workitem_rename",
      action: () => onAction("rename"),
    },
    { id: "divider-2", label: "", divider: true },
    {
      id: "delete",
      label: tr("common:actions.delete", "Delete"),
      icon: React.createElement(HugeiconsIcon, {
        icon: Delete02Icon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      shortcutId: "workitem_delete",
      action: () => onAction("delete"),
    },
  ];
};
