/**
 * StatusCountBadge Component
 *
 * Displays status counts with icons (errors, warnings, passed, etc.)
 * Used in Problems panel, Test Results, and other summary displays.
 *
 * Workstation-specific service status badge.
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

export type StatusVariant =
  | "error"
  | "warning"
  | "success"
  | "info"
  | "neutral";

export interface StatusCountBadgeProps {
  /** Status type determines icon and color */
  variant: StatusVariant;
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

const VARIANT_CONFIG: Record<StatusVariant, VariantConfig> = {
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

export const StatusCountBadge: React.FC<StatusCountBadgeProps> = memo(
  ({
    variant,
    count,
    label,
    showZero = false,
    iconSize = 14,
    className = "",
  }) => {
    if (count === 0 && !showZero) {
      return null;
    }

    const config = VARIANT_CONFIG[variant];
    const Icon = config.icon;
    const displayLabel = label ?? config.defaultLabel;

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

StatusCountBadge.displayName = "StatusCountBadge";

// ============================================
// StatusSummary - Multiple badges in a row
// ============================================

export interface StatusSummaryProps {
  /** Error count */
  errors?: number;
  /** Warning count */
  warnings?: number;
  /** Passed/success count */
  passed?: number;
  /** Info count */
  info?: number;
  /** Gap between badges */
  gap?: "sm" | "md" | "lg";
  /** Additional class name */
  className?: string;
}

const GAP_CLASSES = {
  sm: "gap-2",
  md: "gap-3",
  lg: "gap-4",
} as const;

export const StatusSummary: React.FC<StatusSummaryProps> = memo(
  ({
    errors = 0,
    warnings = 0,
    passed = 0,
    info = 0,
    gap = "md",
    className = "",
  }) => {
    const hasAny = errors > 0 || warnings > 0 || passed > 0 || info > 0;

    if (!hasAny) {
      return null;
    }

    return (
      <div className={`flex items-center ${GAP_CLASSES[gap]} ${className}`}>
        <StatusCountBadge variant="error" count={errors} />
        <StatusCountBadge variant="warning" count={warnings} />
        <StatusCountBadge variant="success" count={passed} />
        <StatusCountBadge variant="info" count={info} />
      </div>
    );
  }
);

StatusSummary.displayName = "StatusSummary";

export default StatusCountBadge;
