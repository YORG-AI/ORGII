import React from "react";

import { AlertCircleIcon, HugeiconsIcon } from "@src/icons";

import type { TaskPriority } from "../types";

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  urgent: "#FF4757",
  high: "#FF8C42",
  medium: "#4096FF",
  low: "#8B8B8B",
};

const DEFAULT_PRIORITY_COLOR = "var(--color-text-3)";

export function getPriorityColor(priority?: string): string {
  if (!priority) return DEFAULT_PRIORITY_COLOR;
  return PRIORITY_COLORS[priority as TaskPriority] ?? DEFAULT_PRIORITY_COLOR;
}

export const PriorityIndicator: React.FC<{
  priority?: string;
  showEmpty?: boolean;
}> = ({ priority, showEmpty = false }) => {
  if (!priority && !showEmpty) return null;

  const color = getPriorityColor(priority);
  const label = priority || "No priority";
  return (
    <div className="flex items-center gap-1">
      <HugeiconsIcon
        icon={AlertCircleIcon}
        data-icon="alert-circle"
        size={14}
        style={{ color }}
      />
      <span className="text-[11px] capitalize" style={{ color }}>
        {label}
      </span>
    </div>
  );
};
