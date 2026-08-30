/**
 * StyleSection Component
 *
 * A collapsible section showing a group of CSS properties.
 */
import React, { memo, useCallback, useState } from "react";

import { ArrowDown01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

import { EditableStyleRow } from "./EditableStyleRow";

// ============================================
// Types
// ============================================

export interface StyleEntry {
  /** CSS property name (kebab-case for display) */
  property: string;
  /** Property key (camelCase for API) */
  key: string;
  /** Current value */
  value: string;
}

export interface StyleSectionProps {
  /** Section title */
  title: string;
  /** Style entries in this section */
  entries: StyleEntry[];
  /** Callback when a value changes */
  onValueChange: (property: string, value: string) => void;
  /** Whether editing is disabled */
  disabled?: boolean;
  /** Whether section is initially expanded */
  defaultExpanded?: boolean;
  /** Force all sections to collapse (increments to trigger) */
  collapseAllKey?: number;
  /** Force all sections to expand (increments to trigger) */
  expandAllKey?: number;
}

// ============================================
// Component
// ============================================

export const StyleSection: React.FC<StyleSectionProps> = memo(
  ({
    title,
    entries,
    onValueChange,
    disabled = false,
    defaultExpanded = true,
    collapseAllKey,
    expandAllKey,
  }) => {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);
    const [prevCollapseKey, setPrevCollapseKey] = useState(collapseAllKey);
    const [prevExpandKey, setPrevExpandKey] = useState(expandAllKey);

    // Update expanded state when keys change (React recommended pattern - setState during render)
    if (collapseAllKey !== undefined && collapseAllKey !== prevCollapseKey) {
      setPrevCollapseKey(collapseAllKey);
      setIsExpanded(false);
    }
    if (expandAllKey !== undefined && expandAllKey !== prevExpandKey) {
      setPrevExpandKey(expandAllKey);
      setIsExpanded(true);
    }

    const handleToggle = useCallback(() => {
      setIsExpanded((prev) => !prev);
    }, []);

    return (
      <div className="mb-1">
        {/* Section header */}
        <button
          onClick={handleToggle}
          className="flex w-full items-center gap-1.5 py-1.5 text-left"
        >
          {isExpanded ? (
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              data-icon="chevron-down"
              size={14}
              className="flex-shrink-0 text-text-3"
            />
          ) : (
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              data-icon="chevron-right"
              size={14}
              className="flex-shrink-0 text-text-3"
            />
          )}
          <span className="flex-1 text-[12px] font-medium uppercase text-text-2">
            {title}
          </span>
          <span className="text-[11px] text-text-3">{entries.length}</span>
        </button>

        {/* Properties */}
        {isExpanded && (
          <div className="pb-3 pt-1">
            {entries.map((entry) => (
              <EditableStyleRow
                key={entry.key}
                property={entry.property}
                propertyKey={entry.key}
                value={entry.value}
                onChange={onValueChange}
                disabled={disabled}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
);

StyleSection.displayName = "StyleSection";

export default StyleSection;
