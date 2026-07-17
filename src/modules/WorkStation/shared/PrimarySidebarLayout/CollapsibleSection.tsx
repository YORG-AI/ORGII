/**
 * CollapsibleSection Component
 *
 * A resizable, collapsible section for panel layouts.
 * Used to create multiple stacked sections (Files, Outline, etc.)
 * Uses flex-grow for proportional space distribution.
 *
 * Shared by: CodeEditor, DatabaseManager, Browser
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import React, { memo, useCallback } from "react";

import {
  type SectionHeaderAction,
  isSectionHeaderCustomAction,
} from "@src/components/TreePanelSidebar/types";
import {
  BUTTON_SIZE,
  SECTION_ACTION_BUTTON,
} from "@src/modules/WorkStation/shared/tokens";
import { HorizontalResizeHandle } from "@src/scaffold/Resize";

import { HEADER_CLASSES } from "../tokens";

// ============================================
// Types
// ============================================

export interface CollapsibleSectionProps {
  /** Section title */
  title: string | React.ReactNode;
  /** Section content */
  children: React.ReactNode;
  /** Whether the section is collapsed */
  collapsed?: boolean;
  /** Callback when collapse state changes */
  onCollapseChange?: (collapsed: boolean) => void;
  /** Whether the section can be collapsed */
  collapsible?: boolean;
  /** Flex grow value (proportional size) */
  flexGrow?: number;
  /** Whether this section can be resized */
  resizable?: boolean;
  /** Whether this section is the last one (no resize handle at bottom) */
  isLast?: boolean;
  /** Action buttons for the section header */
  actions?: SectionHeaderAction[];
  /** Callback when resize starts */
  onResizeStart?: (event: React.MouseEvent) => void;
  /** Whether this section should use auto height instead of flex-grow */
  autoHeight?: boolean;
  /** Whether to show top border instead of bottom border (for global sections) */
  showTopBorder?: boolean;
  hideSeparator?: boolean;
  /** Stable selector for automated interaction with the section toggle. */
  headerTestId?: string;
}

// ============================================
// Main Component
// ============================================

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = memo(
  ({
    title,
    children,
    collapsed = false,
    onCollapseChange,
    collapsible = true,
    flexGrow = 1,
    resizable = true,
    isLast = false,
    actions = [],
    onResizeStart,
    autoHeight = false,
    showTopBorder = false,
    hideSeparator = false,
    headerTestId,
  }) => {
    const effectiveCollapsed = collapsible ? collapsed : false;

    // Handle collapse toggle
    const handleToggle = useCallback(() => {
      if (!collapsible) return;
      onCollapseChange?.(!effectiveCollapsed);
    }, [collapsible, effectiveCollapsed, onCollapseChange]);

    // Handle resize start
    const handleResizeStart = useCallback(
      (event: React.MouseEvent) => {
        if (!resizable || isLast || effectiveCollapsed || autoHeight) return;
        event.preventDefault();
        onResizeStart?.(event);
      },
      [resizable, isLast, effectiveCollapsed, autoHeight, onResizeStart]
    );

    // Calculate style based on autoHeight flag
    const sectionStyle: React.CSSProperties = effectiveCollapsed
      ? {
          flexGrow: 0,
          flexShrink: 0,
          flexBasis: "auto",
          minHeight: "auto",
        }
      : autoHeight
        ? {
            flexGrow: 0,
            flexShrink: 0,
            flexBasis: "auto",
            minHeight: "auto",
          }
        : {
            flexGrow: flexGrow,
            flexShrink: 0,
            flexBasis: 0,
            minHeight: "100px",
          };

    const showSeparator = !hideSeparator && (showTopBorder || !isLast);
    const separatorPositionClass = showTopBorder ? "top-0" : "bottom-0";

    return (
      <div
        className={`group/section relative flex flex-col ${
          !autoHeight && !effectiveCollapsed ? "min-h-0" : ""
        }`}
        style={sectionStyle}
      >
        {showSeparator && (
          <div
            className={`pointer-events-none absolute left-2 right-2 ${separatorPositionClass} h-px bg-border-1`}
            aria-hidden
          />
        )}
        {/* Header */}
        <div className={HEADER_CLASSES.sectionHeader}>
          <div
            data-testid={headerTestId}
            data-collapsed={effectiveCollapsed ? "true" : "false"}
            className={`flex min-w-0 flex-1 items-center gap-1.5 ${collapsible ? "cursor-pointer" : ""}`}
            onClick={handleToggle}
          >
            {/* Chevron */}
            {collapsible && (
              <span
                className={`${BUTTON_SIZE.sm} flex flex-shrink-0 items-center justify-center`}
              >
                {effectiveCollapsed ? (
                  <ChevronRight size={14} className="text-text-3" />
                ) : (
                  <ChevronDown size={14} className="text-text-3" />
                )}
              </span>
            )}

            {/* Title */}
            {typeof title === "string" ? (
              <span className="truncate text-[12px] font-medium uppercase text-text-2">
                {title}
              </span>
            ) : (
              <div className="truncate text-[12px] font-medium uppercase text-text-2">
                {title}
              </div>
            )}
          </div>

          {/* Action buttons - show on hover, or always when forceVisible */}
          {actions.length > 0 && (
            <div
              className={`items-center gap-0.5 ${
                actions.some((action) => action.forceVisible)
                  ? "flex"
                  : "hidden group-focus-within/section:flex group-hover/section:flex"
              }`}
            >
              {actions.map((action) => {
                // Support custom rendering for complex actions (dropdowns, etc.)
                if (isSectionHeaderCustomAction(action)) {
                  return <div key={action.key}>{action.customRender}</div>;
                }

                const hasLabel = !!action.label;
                const button = (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      action.onClick();
                    }}
                    className={`${SECTION_ACTION_BUTTON.base} ${
                      hasLabel
                        ? SECTION_ACTION_BUTTON.withLabel
                        : SECTION_ACTION_BUTTON.iconOnly
                    }`}
                    title={
                      action.key === "refresh-git" ? undefined : action.tooltip
                    }
                  >
                    {action.icon}
                    {action.label && <span>{action.label}</span>}
                  </button>
                );

                return <div key={action.key}>{button}</div>;
              })}
            </div>
          )}
        </div>

        {/* Content - only render when not collapsed */}
        {!effectiveCollapsed && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {children}
          </div>
        )}

        {/* Resize handle - only show when not collapsed, resizable, not auto height, and not last */}
        {!effectiveCollapsed && resizable && !autoHeight && !isLast && (
          <HorizontalResizeHandle
            variant="transparent"
            onMouseDown={handleResizeStart}
          />
        )}
      </div>
    );
  }
);

CollapsibleSection.displayName = "CollapsibleSection";

export default CollapsibleSection;
