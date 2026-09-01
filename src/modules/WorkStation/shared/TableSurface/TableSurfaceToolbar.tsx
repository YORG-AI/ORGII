import type { ReactNode } from "react";
import type React from "react";

import Input from "@src/components/Input";

interface TableSurfaceToolbarProps {
  leading?: ReactNode;
  trailing?: ReactNode;
  showFormulaBar: boolean;
  activeCellLabel: string;
  value: string;
  editable: boolean;
  disabled: boolean;
  onValueChange: (value: string) => void;
  onFocusFormula: () => void;
  onReturnFocus: () => void;
}

export function TableSurfaceToolbar({
  leading,
  trailing,
  showFormulaBar,
  activeCellLabel,
  value,
  editable,
  disabled,
  onValueChange,
  onFocusFormula,
  onReturnFocus,
}: TableSurfaceToolbarProps) {
  if (!leading && !trailing && !showFormulaBar) return null;

  return (
    <div className="table-surface__control-bar flex h-[40px] shrink-0 items-center gap-2 border-b border-border-2 pr-1 pl-3">
      {leading}
      {leading && showFormulaBar && (
        <span className="table-surface__control-separator" />
      )}
      {showFormulaBar && (
        <>
          <span className="table-surface__formula-cell-label">
            {activeCellLabel || "—"}
          </span>
          <Input
            className="table-surface__formula-cell-input"
            size="small"
            value={value}
            readOnly={!editable || disabled}
            disabled={disabled}
            onChange={onValueChange}
            onFocus={onFocusFormula}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter" || event.key === "Escape") {
                event.currentTarget.blur();
                onReturnFocus();
              }
            }}
          />
        </>
      )}
      {trailing}
    </div>
  );
}
