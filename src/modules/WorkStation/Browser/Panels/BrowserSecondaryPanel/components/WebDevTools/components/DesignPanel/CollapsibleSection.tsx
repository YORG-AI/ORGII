/**
 * CollapsibleSection Component
 *
 * A simple collapsible section for the DesignPanel.
 * Follows the same styling as PanelSectionHeader.
 */
import React, { memo, useEffect } from "react";

import { useCollapsible } from "@src/hooks/ui/useCollapsible";
import { ArrowDown01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

// ============================================
// Types
// ============================================

export interface CollapsibleSectionProps {
  /** Section title */
  title: string;
  /** Optional right-side content (e.g., value badge) */
  rightContent?: React.ReactNode;
  /** Header action buttons */
  headerActions?: React.ReactNode;
  /** Section content */
  children: React.ReactNode;
  /** Whether section starts expanded */
  defaultExpanded?: boolean;
  /** Force all sections to collapse (increments to trigger) */
  collapseAllKey?: number;
  /** Force all sections to expand (increments to trigger) */
  expandAllKey?: number;
}

export interface SubSectionProps {
  /** Subsection title */
  title: string;
  /** Header action buttons (e.g., link toggle) */
  headerActions?: React.ReactNode;
  /** Section content */
  children: React.ReactNode;
}

// ============================================
// SubSection Component (smaller inline header)
// ============================================

export const SubSection: React.FC<SubSectionProps> = memo(
  ({ title, headerActions, children }) => {
    return (
      <div className="mb-2 last:mb-0">
        <div className="mb-2 flex items-center justify-between pr-1">
          <span className="text-[12px] text-text-1">{title}</span>
          {headerActions && (
            <div className="flex items-center">{headerActions}</div>
          )}
        </div>
        {children}
      </div>
    );
  }
);

SubSection.displayName = "SubSection";

// ============================================
// CollapsibleSection Component
// ============================================

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = memo(
  ({
    title,
    rightContent,
    headerActions,
    children,
    defaultExpanded = true,
    collapseAllKey,
    expandAllKey,
  }) => {
    const {
      isOpen: isExpanded,
      toggle: handleToggle,
      open,
      close,
    } = useCollapsible({
      defaultOpen: defaultExpanded,
    });

    useEffect(() => {
      if (collapseAllKey !== undefined) close();
    }, [collapseAllKey, close]);

    useEffect(() => {
      if (expandAllKey !== undefined) open();
    }, [expandAllKey, open]);

    return (
      <div className="mb-2 last:mb-0">
        {/* Header */}
        <div className="flex items-center gap-1.5 py-1.5">
          <button
            onClick={handleToggle}
            className="flex flex-1 items-center gap-1.5 text-left"
          >
            {isExpanded ? (
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                data-icon="chevron-down"
                size={14}
                className="shrink-0 text-text-3"
              />
            ) : (
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={14}
                className="shrink-0 text-text-3"
              />
            )}
            <span className="flex-1 text-[12px] font-medium text-text-2 uppercase">
              {title}
            </span>
            {rightContent && (
              <span className="text-[11px] text-text-3">{rightContent}</span>
            )}
          </button>
          {headerActions && (
            <div className="flex items-center">{headerActions}</div>
          )}
        </div>

        {/* Content */}
        {isExpanded && <div className="pt-2 pb-2">{children}</div>}
      </div>
    );
  }
);

CollapsibleSection.displayName = "CollapsibleSection";

export default CollapsibleSection;
