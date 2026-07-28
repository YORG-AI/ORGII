/**
 * CollapsibleTableSection
 *
 * Reusable collapsible section with standard table container styling.
 * Used for CollapsibleSection + table (SettingsTable) patterns across
 * Integrations, Dev Record, Token Market, etc.
 */
import React from "react";

import {
  SECTION_CONTAINER_CLASSES,
  SECTION_PADDING,
} from "../SectionLayout/tokens";
import CollapsibleSection from "./CollapsibleSection";

export interface CollapsibleTableSectionProps {
  title: string;
  defaultOpen?: boolean;
  /** Optional right-aligned content in the header row (e.g. TabPill, badge) */
  actions?: React.ReactNode;
  /** Table content (typically SettingsTable) */
  children: React.ReactNode;
  /** When true, render children directly without the rounded primary-container px-4 wrapper.
   *  Use when child (e.g. SettingsTable) has its own card styling. */
  noWrapper?: boolean;
  /** Add overflow-hidden to container for horizontal scroll. Ignored when noWrapper. */
  overflowHidden?: boolean;
  /** Optional additional class for the wrapper. Ignored when noWrapper. */
  className?: string;
}

const TABLE_CONTAINER = `${SECTION_CONTAINER_CLASSES} ${SECTION_PADDING.none}`;

const CollapsibleTableSection: React.FC<CollapsibleTableSectionProps> = ({
  title,
  defaultOpen = true,
  actions,
  children,
  noWrapper = false,
  overflowHidden = false,
  className = "",
}) => {
  const containerClass = `${TABLE_CONTAINER} ${
    overflowHidden ? "w-full overflow-hidden" : ""
  }`.trim();

  return (
    <CollapsibleSection
      title={title}
      defaultOpen={defaultOpen}
      actions={actions}
      className={className}
    >
      {noWrapper ? children : <div className={containerClass}>{children}</div>}
    </CollapsibleSection>
  );
};

export default CollapsibleTableSection;
