/**
 * SectionHeader Component
 *
 * Reusable collapsible section header for source control sections
 * (Merge Changes, Staged Changes, Changes)
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import React, { memo } from "react";

import {
  COUNT_BADGE,
  getCountBadgeSizeClass,
} from "@src/modules/WorkStation/shared/tokens";

export interface SectionHeaderProps {
  title: string;
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
  /** Icon to show before the title */
  icon?: React.ReactNode;
  /** Additional action buttons (shown on hover) */
  actions?: React.ReactNode;
  /** Badge color variant */
  variant?: "default" | "warning";
  /** Header height class. Defaults to compact source-control section height. */
  heightClassName?: string;
  /** Keep warning style only on count badge */
  warningCountOnly?: boolean;
}

export const SectionHeader: React.FC<SectionHeaderProps> = memo(
  ({
    title,
    count,
    isCollapsed,
    onToggle,
    icon,
    actions,
    variant = "default",
    heightClassName = "h-[28px]",
    warningCountOnly = false,
  }) => {
    const isWarning = variant === "warning";
    const useWarningText = isWarning && !warningCountOnly;
    const countBadgeVariant = isWarning
      ? COUNT_BADGE.danger
      : count === 0
        ? COUNT_BADGE.muted
        : COUNT_BADGE.primary;

    return (
      <div
        className={`group/header flex ${heightClassName} w-full min-w-0 items-center gap-1.5 px-3${
          useWarningText ? "hover:bg-warning-1" : ""
        }`}
      >
        <button
          className="flex min-w-0 items-center gap-1.5"
          onClick={onToggle}
        >
          {isCollapsed ? (
            <ChevronRight
              size={14}
              className={useWarningText ? "text-warning-6" : "text-text-3"}
            />
          ) : (
            <ChevronDown
              size={14}
              className={useWarningText ? "text-warning-6" : "text-text-3"}
            />
          )}
          {icon}
          <span
            className={`min-w-0 truncate text-[11px] font-medium uppercase ${
              useWarningText ? "text-warning-6" : "text-text-2"
            }`}
          >
            {title}
          </span>
        </button>
        <div className="flex-1" />
        <div className="relative flex flex-shrink-0 items-center">
          {/* Action buttons - show on hover without affecting layout */}
          {actions && (
            <div className="absolute right-full mr-1 flex items-center">
              {actions}
            </div>
          )}
          {/* Count badge */}
          <span
            className={`${COUNT_BADGE.base} ${getCountBadgeSizeClass(count)} ${countBadgeVariant}`}
          >
            {count}
          </span>
        </div>
      </div>
    );
  }
);

SectionHeader.displayName = "SectionHeader";

export default SectionHeader;
