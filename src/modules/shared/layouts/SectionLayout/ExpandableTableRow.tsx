/**
 * ExpandableTableRow
 *
 * Wraps the common "expand/collapse a sub-table" pattern used throughout Settings:
 * a SectionRow with a chevron toggle button, and an indented content block below
 * that is shown when expanded.
 *
 * Usage:
 *   <ExpandableTableRow
 *     label="Memory Breakdown"
 *     description="Allocation by subsystem"
 *     expanded={showBreakdown}
 *     onToggle={() => setShowBreakdown((v) => !v)}
 *     disabled={rows.length === 0}
 *   >
 *     <SettingsTable ... />
 *   </ExpandableTableRow>
 */
import React, { memo } from "react";

import Button from "@src/components/Button";
import { ChevronsDownUpIcon, HugeiconsIcon, UnfoldMoreIcon } from "@src/icons";

import SectionRow from "./Row";

export interface ExpandableTableRowProps {
  label: string;
  description?: string;
  expanded: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** Content rendered in the indented block when expanded */
  children?: React.ReactNode;
  /** Extra controls rendered alongside the chevron button */
  extraControls?: React.ReactNode;
}

const ExpandableTableRow: React.FC<ExpandableTableRowProps> = memo(
  ({
    label,
    description,
    expanded,
    onToggle,
    disabled,
    children,
    extraControls,
  }) => {
    return (
      <>
        <SectionRow label={label} description={description}>
          <div className="flex items-center gap-2">
            {extraControls}
            <Button
              onClick={onToggle}
              icon={
                expanded ? (
                  <HugeiconsIcon
                    icon={ChevronsDownUpIcon}
                    data-icon="chevrons-down-up"
                    size={14}
                  />
                ) : (
                  <HugeiconsIcon
                    icon={UnfoldMoreIcon}
                    data-icon="chevrons-up-down"
                    size={14}
                  />
                )
              }
              iconOnly
              disabled={disabled}
            />
          </div>
        </SectionRow>

        {expanded && (
          <SectionRow label="" indent showHeader={false}>
            {children}
          </SectionRow>
        )}
      </>
    );
  }
);

ExpandableTableRow.displayName = "ExpandableTableRow";

export default ExpandableTableRow;
