/**
 * ConfigListItem Component
 *
 * Generic list item for ListDetailSubpage left panels.
 * Uses ListPanel tokens for consistent styling across:
 * - Connectivity channels
 * - Code Accounts (future migration)
 * - Any list+detail settings page
 *
 * Renders: icon (left) + label (middle) + optional status dot (right)
 */
import React, { memo, useCallback } from "react";

import {
  getListIconClasses,
  getListItemClasses,
} from "@src/components/ListPanel/tokens";
import Tooltip from "@src/components/Tooltip";
import { HugeiconsIcon, type IconSvgElement } from "@src/icons";

// ============================================
// Types
// ============================================

export interface ConfigListItemProps {
  /** Unique identifier for the item */
  id: string;
  /** Icon glyph (static `@src/icons` data) */
  icon?: IconSvgElement;
  /** Custom icon element for non-glyph icons (takes precedence over icon) */
  iconElement?: React.ReactNode;
  /** Display label */
  label: string;
  /** Optional secondary line below the label */
  subtitle?: string;
  /** Whether this item is currently selected */
  isSelected: boolean;
  /** Click handler */
  onClick: (id: string) => void;
  /** Status dot color class (e.g. "bg-success-6", "bg-fill-3") */
  statusColor?: string;
  /** Tooltip text for the status dot */
  statusTooltip?: string;
  /** Optional trailing element (e.g. count badge) rendered after the label */
  trailing?: React.ReactNode;
}

// ============================================
// Component
// ============================================

const ConfigListItem: React.FC<ConfigListItemProps> = ({
  id,
  icon: Icon,
  iconElement,
  label,
  subtitle,
  isSelected,
  onClick,
  statusColor,
  statusTooltip,
  trailing,
}) => {
  const handleClick = useCallback(() => {
    onClick(id);
  }, [id, onClick]);

  return (
    <button
      type="button"
      className={`w-full text-left ${getListItemClasses(isSelected)}`}
      onClick={handleClick}
    >
      {/* Left: Icon */}
      {iconElement ? (
        <span className="shrink-0 text-text-1">{iconElement}</span>
      ) : (
        Icon && (
          <HugeiconsIcon
            icon={Icon}
            size={16}
            className={getListIconClasses(isSelected)}
          />
        )
      )}

      {/* Middle: Label + optional subtitle */}
      {subtitle ? (
        <div className="min-w-0 flex-1">
          <div className="truncate">{label}</div>
          <div className="truncate text-[11px] font-normal text-text-3">
            {subtitle}
          </div>
        </div>
      ) : (
        <span className="min-w-0 flex-1 truncate">{label}</span>
      )}

      {/* Optional trailing element */}
      {trailing && (
        <span className="shrink-0 text-[11px] text-text-3">{trailing}</span>
      )}

      {/* Right: Status dot */}
      {statusColor && (
        <div className="flex shrink-0 items-center">
          {statusTooltip ? (
            <Tooltip content={statusTooltip} position="top">
              <div className={`h-2 w-2 shrink-0 rounded-full ${statusColor}`} />
            </Tooltip>
          ) : (
            <div className={`h-2 w-2 shrink-0 rounded-full ${statusColor}`} />
          )}
        </div>
      )}
    </button>
  );
};

export default memo(ConfigListItem);
