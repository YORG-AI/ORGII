/**
 * Priority Options
 *
 * Priority configurations for work items and projects.
 */
import React from "react";

import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import { AlertCircleIcon, HugeiconsIcon, MinusSignIcon } from "@src/icons";
import type { ProjectPriority } from "@src/types/core/project";
import type { DropdownOption } from "@src/types/core/shared";
import type { WorkItemPriority } from "@src/types/core/workItem";

import { PRIORITY_COLORS } from "./colors";

interface PriorityBarsIconProps {
  level: "low" | "medium" | "high";
  size?: number;
}

const PRIORITY_BAR_HEIGHTS: Record<PriorityBarsIconProps["level"], number[]> = {
  low: [5, 9, 13],
  medium: [8, 12, 16],
  high: [12, 16, 20],
};

const PriorityBarsIcon: React.FC<PriorityBarsIconProps> = ({
  level,
  size = DROPDOWN_ITEM.iconSize,
}) => {
  const heights = PRIORITY_BAR_HEIGHTS[level];
  return React.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 20 20",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg",
      "aria-hidden": true,
      focusable: false,
    },
    heights.map((height, index) => {
      const x = 3 + index * 6;
      return React.createElement("rect", {
        key: `${level}-${index}`,
        x,
        y: 20 - height,
        width: 4,
        height,
        rx: 1.5,
        fill: "currentColor",
      });
    })
  );
};

// ============================================
// Work Item Priority Options
// ============================================

export const WORK_ITEM_PRIORITY_OPTIONS: DropdownOption<WorkItemPriority>[] = [
  {
    value: "none",
    label: "No priority",
    icon: React.createElement(HugeiconsIcon, {
      icon: MinusSignIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: PRIORITY_COLORS.none,
  },
  {
    value: "urgent",
    label: "Urgent",
    icon: React.createElement(HugeiconsIcon, {
      icon: AlertCircleIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: PRIORITY_COLORS.urgent,
  },
  {
    value: "high",
    label: "High",
    icon: React.createElement(PriorityBarsIcon, {
      level: "high",
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: PRIORITY_COLORS.high,
  },
  {
    value: "medium",
    label: "Medium",
    icon: React.createElement(PriorityBarsIcon, {
      level: "medium",
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: PRIORITY_COLORS.medium,
  },
  {
    value: "low",
    label: "Low",
    icon: React.createElement(PriorityBarsIcon, {
      level: "low",
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: PRIORITY_COLORS.low,
  },
];

// ============================================
// Project Priority Options
// ============================================

export interface ProjectPriorityOption {
  value: ProjectPriority;
  label: string;
  icon: React.ReactNode;
  color: string;
}

export const STORY_PRIORITY_OPTIONS: ProjectPriorityOption[] = [
  {
    value: "urgent",
    label: "Urgent",
    icon: React.createElement(HugeiconsIcon, {
      icon: AlertCircleIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: PRIORITY_COLORS.urgent,
  },
  {
    value: "high",
    label: "High",
    icon: React.createElement(PriorityBarsIcon, {
      level: "high",
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: PRIORITY_COLORS.high,
  },
  {
    value: "medium",
    label: "Medium",
    icon: React.createElement(PriorityBarsIcon, {
      level: "medium",
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: PRIORITY_COLORS.medium,
  },
  {
    value: "low",
    label: "Low",
    icon: React.createElement(PriorityBarsIcon, {
      level: "low",
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: PRIORITY_COLORS.low,
  },
  {
    value: "none",
    label: "No priority",
    icon: React.createElement(HugeiconsIcon, {
      icon: MinusSignIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: PRIORITY_COLORS.none,
  },
];

// ============================================
// Helper Functions
// ============================================

export function getWorkItemPriorityConfig(priority: WorkItemPriority) {
  return (
    WORK_ITEM_PRIORITY_OPTIONS.find((opt) => opt.value === priority) ||
    WORK_ITEM_PRIORITY_OPTIONS[0]
  );
}

export function getProjectPriorityConfig(priority: ProjectPriority) {
  return (
    STORY_PRIORITY_OPTIONS.find((opt) => opt.value === priority) ||
    STORY_PRIORITY_OPTIONS[4]
  );
}
