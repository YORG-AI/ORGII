/**
 * CountBadge Component
 *
 * Displays diagnostic counts with icons (errors, warnings, passed, etc.)
 * Used in Problems panel, Test Results, and other summary displays.
 *
 * Compact numeric count badge for workstation surfaces.
 */
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Info,
  type LucideIcon,
} from "lucide-react";
import React, { memo } from "react";

// ============================================
// Types
// ============================================

export type CountVariant = "error" | "warning" | "success" | "info" | "neutral";

export interface CountBadgeProps {
  /** Variant determines icon and color */
  variant: CountVariant;
  /** Count to display */
  count: number;
  /** Optional label (e.g., "errors", "passed") */
  label?: string;
  /** Show badge even when count is 0 */
  showZero?: boolean;
  /** Icon size */
  iconSize?: number;
  /** Additional class name */
  className?: string;
}

// ============================================
// Configuration
// ============================================

interface VariantConfig {
  icon: LucideIcon;
  colorClass: string;
  defaultLabel: string;
}

const VARIANT_CONFIG: Record<CountVariant, VariantConfig> = {
  error: {
    icon: AlertCircle,
    colorClass: "text-danger-6",
    defaultLabel: "error",
  },
  warning: {
    icon: AlertTriangle,
    colorClass: "text-warning-6",
    defaultLabel: "warning",
  },
  success: {
    icon: Check,
    colorClass: "text-success-6",
    defaultLabel: "passed",
  },
  info: {
    icon: Info,
    colorClass: "text-primary-6",
    defaultLabel: "info",
  },
  neutral: {
    icon: Info,
    colorClass: "text-text-3",
    defaultLabel: "",
  },
};

// ============================================
// Component
// ============================================

export const CountBadge: React.FC<CountBadgeProps> = memo(
  ({
    variant,
    count,
    label,
    showZero = false,
    iconSize = 14,
    className = "",
  }) => {
    // Don't render if count is 0 and showZero is false
    if (count === 0 && !showZero) {
      return null;
    }

    const config = VARIANT_CONFIG[variant];
    const Icon = config.icon;
    const displayLabel = label ?? config.defaultLabel;

    // Pluralize label if count !== 1
    const pluralizedLabel =
      displayLabel && count !== 1 && !displayLabel.endsWith("s")
        ? `${displayLabel}s`
        : displayLabel;

    return (
      <span
        className={`flex items-center gap-1 text-[12px] ${config.colorClass} ${className}`}
      >
        <Icon size={iconSize} className="shrink-0" />
        <span>
          {count}
          {pluralizedLabel && ` ${pluralizedLabel}`}
        </span>
      </span>
    );
  }
);

CountBadge.displayName = "CountBadge";

export default CountBadge;
