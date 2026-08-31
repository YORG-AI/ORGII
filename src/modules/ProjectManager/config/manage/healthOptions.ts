/**
 * Health Options
 *
 * Health status configurations for projects.
 */
import React from "react";

import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import {
  Alert01Icon,
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  Clock01Icon,
  HugeiconsIcon,
} from "@src/icons";
import type { ProjectHealth } from "@src/types/core/project";

import { HEALTH_COLORS } from "./colors";

// ============================================
// Health Options
// ============================================

export interface HealthOption {
  value: ProjectHealth;
  label: string;
  icon: React.ReactNode;
  color: string;
}

export const HEALTH_OPTIONS: HealthOption[] = [
  {
    value: "on_track",
    label: "On Track",
    icon: React.createElement(HugeiconsIcon, {
      icon: CheckmarkCircle01Icon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: HEALTH_COLORS.on_track,
  },
  {
    value: "at_risk",
    label: "At Risk",
    icon: React.createElement(HugeiconsIcon, {
      icon: Alert01Icon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: HEALTH_COLORS.at_risk,
  },
  {
    value: "off_track",
    label: "Off Track",
    icon: React.createElement(HugeiconsIcon, {
      icon: CancelCircleIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: HEALTH_COLORS.off_track,
  },
  {
    value: "no_updates",
    label: "No updates",
    icon: React.createElement(HugeiconsIcon, {
      icon: Clock01Icon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color: HEALTH_COLORS.no_updates,
  },
];

// ============================================
// Helper Functions
// ============================================

export function getHealthConfig(health: ProjectHealth) {
  return (
    HEALTH_OPTIONS.find((opt) => opt.value === health) || HEALTH_OPTIONS[3]
  );
}
