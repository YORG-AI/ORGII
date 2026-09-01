/**
 * PanelSectionHeader Component
 *
 * A simple, reusable header for panel sections.
 * Follows the same styling as CollapsibleSection header but without collapse functionality.
 *
 * Used for: section headers in DevTools, Browser panels, etc.
 */
import React, { memo } from "react";

import { HEADER_CLASSES } from "../tokens";

// ============================================
// Types
// ============================================

export interface PanelSectionHeaderProps {
  /** Header title */
  title: string;
  /** Action buttons for the header (shown on hover by default) */
  actions?: React.ReactNode;
  actionsAlwaysVisible?: boolean;
  /** Whether to show border at the bottom */
  showBorder?: boolean;
  /** Optional loading indicator */
  loading?: boolean;
}

// ============================================
// Main Component
// ============================================

export const PanelSectionHeader: React.FC<PanelSectionHeaderProps> = memo(
  ({
    title,
    actions,
    actionsAlwaysVisible = false,
    showBorder = true,
    loading = false,
  }) => {
    return (
      <div
        className={`group/panel-header ${HEADER_CLASSES.sectionHeader} ${
          showBorder ? "border-b border-border-1" : ""
        }`}
      >
        {/* Title */}
        <span className="relative min-w-0 flex-1 truncate text-[12px] font-medium text-text-2 uppercase">
          {title}
          {/* Loading progress indicator */}
          {loading && (
            <span className="absolute -bottom-0.5 left-0 h-[2px] w-full overflow-hidden rounded-full bg-fill-3">
              <span className="absolute h-full w-1/3 animate-progress-slide rounded-full bg-primary-6" />
            </span>
          )}
        </span>

        {actions && (
          <div
            className={`items-center gap-0.5 ${
              actionsAlwaysVisible
                ? "flex"
                : "hidden group-focus-within/panel-header:flex group-hover/panel-header:flex"
            }`}
          >
            {actions}
          </div>
        )}
      </div>
    );
  }
);

PanelSectionHeader.displayName = "PanelSectionHeader";

export default PanelSectionHeader;
