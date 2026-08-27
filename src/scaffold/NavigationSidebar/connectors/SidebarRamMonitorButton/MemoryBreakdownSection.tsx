import { ChevronDown, ChevronUp } from "lucide-react";
import React from "react";

import Button from "@src/components/Button";

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
            <div className="my-2 border-t border-border-2" />
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
          <ChevronUp size={13} strokeWidth={2} />
        ) : (
          <ChevronDown size={13} strokeWidth={2} />
        )
      }
      onClick={onToggleAttributionHints}
    />
  </>
);
