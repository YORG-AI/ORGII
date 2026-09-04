/**
 * Status Options
 *
 * Status configurations for work items and projects.
 */
import React from "react";

import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import {
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  CircleDashedIcon,
  CircleIcon,
  Clock01Icon,
  HugeiconsIcon,
  Layers01Icon,
} from "@src/icons";
import type { ProjectStatus } from "@src/types/core/project";
import type { DropdownOption } from "@src/types/core/shared";
import {
  GITHUB_ISSUE_STATUS,
  type GitHubIssueStatus,
  WORK_ITEM_STATUS,
  type WorkItemStatus,
} from "@src/types/core/workItem";

import { STATUS_BG_COLORS, STATUS_COLORS } from "./colors";

// ============================================
// Work Item Status Options
// ============================================

export const GITHUB_ISSUE_STATUS_OPTIONS: DropdownOption<GitHubIssueStatus>[] =
  [
    {
      value: GITHUB_ISSUE_STATUS.OPEN,
      label: "Open",
      icon: React.createElement(HugeiconsIcon, {
        icon: CircleIcon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      color: STATUS_COLORS.in_progress,
    },
    {
      value: GITHUB_ISSUE_STATUS.CLOSED,
      label: "Closed",
      icon: React.createElement(HugeiconsIcon, {
        icon: CheckmarkCircle01Icon,
        size: DROPDOWN_ITEM.iconSize,
      }),
      color: STATUS_COLORS.completed,
    },
  ];

export const WORK_ITEM_STATUS_OPTIONS: DropdownOption<WorkItemStatus>[] = [
  {
    value: WORK_ITEM_STATUS.PLANNED,
    label: "Todo",
    icon: React.createElement(HugeiconsIcon, {
      icon: CircleIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: STATUS_COLORS.planned,
  },
  {
    value: WORK_ITEM_STATUS.IN_PROGRESS,
    label: "In Progress",
    icon: React.createElement(HugeiconsIcon, {
      icon: Clock01Icon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: STATUS_COLORS.in_progress,
  },
  {
    value: WORK_ITEM_STATUS.IN_REVIEW,
    label: "In Review",
    icon: React.createElement(HugeiconsIcon, {
      icon: Layers01Icon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: STATUS_COLORS.in_review,
  },
  {
    value: WORK_ITEM_STATUS.COMPLETED,
    label: "Done",
    icon: React.createElement(HugeiconsIcon, {
      icon: CheckmarkCircle01Icon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: STATUS_COLORS.completed,
  },
  {
    value: WORK_ITEM_STATUS.BACKLOG,
    label: "Backlog",
    icon: React.createElement(HugeiconsIcon, {
      icon: CircleDashedIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: STATUS_COLORS.backlog,
  },
  {
    value: WORK_ITEM_STATUS.CANCELLED,
    label: "Cancelled",
    icon: React.createElement(HugeiconsIcon, {
      icon: CancelCircleIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: STATUS_COLORS.cancelled,
  },
  {
    value: WORK_ITEM_STATUS.DUPLICATE,
    label: "Duplicate",
    icon: React.createElement(HugeiconsIcon, {
      icon: CancelCircleIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: STATUS_COLORS.duplicate,
  },
];

// ============================================
// Project Status Options
// ============================================

export interface ProjectStatusOption {
  value: ProjectStatus;
  label: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
}

export const STORY_STATUS_OPTIONS: ProjectStatusOption[] = [
  {
    value: "backlog",
    label: "Backlog",
    icon: React.createElement(HugeiconsIcon, {
      icon: CircleDashedIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: STATUS_COLORS.backlog,
    bgColor: STATUS_BG_COLORS.backlog,
  },
  {
    value: "planned",
    label: "Planned",
    icon: React.createElement(HugeiconsIcon, {
      icon: CircleIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: STATUS_COLORS.planned,
    bgColor: STATUS_BG_COLORS.planned,
  },
  {
    value: "in_progress",
    label: "In Progress",
    icon: React.createElement(HugeiconsIcon, {
      icon: Clock01Icon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: STATUS_COLORS.in_progress,
    bgColor: STATUS_BG_COLORS.in_progress,
  },
  {
    value: "completed",
    label: "Completed",
    icon: React.createElement(HugeiconsIcon, {
      icon: CheckmarkCircle01Icon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: STATUS_COLORS.completed,
    bgColor: STATUS_BG_COLORS.completed,
  },
  {
    value: "canceled",
    label: "Canceled",
    icon: React.createElement(HugeiconsIcon, {
      icon: CancelCircleIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: STATUS_COLORS.canceled,
    bgColor: STATUS_BG_COLORS.canceled,
  },
];

// ============================================
// Helper Functions
// ============================================

export function getWorkItemStatusConfig(status: WorkItemStatus) {
  return (
    GITHUB_ISSUE_STATUS_OPTIONS.find((opt) => opt.value === status) ||
    WORK_ITEM_STATUS_OPTIONS.find((opt) => opt.value === status) ||
    WORK_ITEM_STATUS_OPTIONS[0]
  );
}

export function getProjectStatusConfig(status: ProjectStatus) {
  return (
    STORY_STATUS_OPTIONS.find((opt) => opt.value === status) ||
    STORY_STATUS_OPTIONS[0]
  );
}
