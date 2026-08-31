import React from "react";

import Button from "@src/components/Button";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import { ArrowDown01Icon, ArrowUp01Icon, HugeiconsIcon } from "@src/icons";

import { MemoryStatRow } from "./MemoryStatRow";
import type { MemoryBreakdownRow } from "./types";

interface MemoryBreakdownSectionProps {
  rows: MemoryBreakdownRow[];
  showAttributionHints: boolean;
  toggleAriaLabel: string;
  onToggleAttributionHints: () => void;
}

export const MemoryBreakdownSection: React.FC<MemoryBreakdownSectionProps> = ({
  rows,
  showAttributionHints,
  toggleAriaLabel,
  onToggleAttributionHints,
}) => (
  <>
    {rows.map((row) => {
      const isAttributionHeader = row.key === "attributionHintsGroup";
      const isAttributionDetail = !isAttributionHeader && !row.alwaysVisible;

      if (isAttributionHeader) return null;
      if (isAttributionDetail && !showAttributionHints) return null;

      return (
        <React.Fragment key={row.key}>
          {row.key === "webViewEstimatesGroup" && (
            <div className={`${DROPDOWN_CLASSES.menuGroupSeparator} !my-0.5`} />
          )}
          <MemoryStatRow
            label={
              row.detail &&
              ["chatRenderedTree", "sessionStore"].includes(row.key)
                ? `${row.label} · ${row.detail}`
                : row.label
            }
            value={row.value}
            emphasized={row.emphasized}
            indentLevel={row.indentLevel}
          />
        </React.Fragment>
      );
    })}
    <Button
      variant="tertiary"
      appearance="ghost"
      size="mini"
      iconOnly
      long
      className="justify-center"
      aria-label={toggleAriaLabel}
      icon={
        showAttributionHints ? (
          <HugeiconsIcon
            icon={ArrowUp01Icon}
            data-icon="chevron-up"
            size={13}
            strokeWidth={2}
          />
        ) : (
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            data-icon="chevron-down"
            size={13}
            strokeWidth={2}
          />
        )
      }
      onClick={onToggleAttributionHints}
    />
  </>
);
