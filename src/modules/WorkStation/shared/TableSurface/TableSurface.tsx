import { memo, useCallback, useState } from "react";

import { Placeholder } from "@src/components/Placeholder";

import { TableSurfaceToolbar } from "./TableSurfaceToolbar";
import { VirtualTableGrid } from "./VirtualTableGrid";
import "./index.scss";
import type { TableSurfaceProps } from "./types";

export const TableSurface = memo(function TableSurface({
  columns,
  rows,
  mode = "readonly",
  className = "",
  toolbarLeading,
  toolbarTrailing,
  showFormulaBar = mode === "editable",
  activeCellLabelFallback = "—",
  hasMoreRows = false,
  loadingMoreRows = false,
  pagination,
  sortState,
  onSortColumn,
  emptyTitle,
  emptySubtitle,
  getCellClassName,
  formatCellValue,
  onCellChange,
  onPasteCells,
  onClearRange,
  onLoadMoreRows,
}: TableSurfaceProps) {
  const [activeCellLabel, setActiveCellLabel] = useState("");
  const [formulaValue, setFormulaValue] = useState("");
  const [formulaUpdater, setFormulaUpdater] = useState<
    ((value: string) => void) | null
  >(null);
  const editable = mode === "editable";

  const handleActiveCellChange = useCallback(
    (label: string, value: string, updateValue: (value: string) => void) => {
      setActiveCellLabel(label);
      setFormulaValue(value);
      setFormulaUpdater(() => updateValue);
    },
    []
  );

  const handleFormulaValueChange = useCallback(
    (value: string) => {
      setFormulaValue(value);
      formulaUpdater?.(value);
    },
    [formulaUpdater]
  );

  return (
    <div className={`table-surface flex h-full min-h-0 flex-col ${className}`}>
      <TableSurfaceToolbar
        leading={toolbarLeading}
        trailing={toolbarTrailing}
        showFormulaBar={showFormulaBar}
        activeCellLabel={activeCellLabel || activeCellLabelFallback}
        value={formulaValue}
        editable={editable}
        disabled={!activeCellLabel}
        onValueChange={handleFormulaValueChange}
        onFocusFormula={() => undefined}
        onReturnFocus={() => undefined}
      />
      {columns.length === 0 || rows.length === 0 ? (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={emptyTitle}
          subtitle={emptySubtitle}
          className="flex-1"
        />
      ) : (
        <VirtualTableGrid
          columns={columns}
          rows={rows}
          editable={editable}
          hasMoreRows={hasMoreRows}
          loadingMoreRows={loadingMoreRows}
          pagination={pagination}
          sortState={sortState}
          onSortColumn={onSortColumn}
          formatCellValue={formatCellValue}
          getCellClassName={getCellClassName}
          onCellChange={onCellChange}
          onPasteCells={onPasteCells}
          onClearRange={onClearRange}
          onLoadMoreRows={onLoadMoreRows}
          onActiveCellChange={handleActiveCellChange}
        />
      )}
    </div>
  );
});

export default TableSurface;
