import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Select, { type SelectOption } from "@src/components/Select";
import { TableSurface } from "@src/modules/WorkStation/shared/TableSurface";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import "./index.scss";
import type {
  SpreadsheetData,
  SpreadsheetEditorProps,
  SpreadsheetSheet,
} from "./types";
import { useSpreadsheetTableAdapter } from "./useSpreadsheetTableAdapter";

export const SpreadsheetEditor: React.FC<SpreadsheetEditorProps> = memo(
  ({
    sheets,
    activeSheetIndex = 0,
    readOnly = false,
    className = "",
    onActiveSheetChange,
    onSheetsChange,
    hasMoreRows: hasExternalMoreRows = false,
    loadingMoreRows = false,
    trimTrailingEmptyRowsOnChange = true,
    onLoadMoreRows,
  }) => {
    const { t } = useTranslation();
    const {
      activeSheet,
      columns,
      rows,
      hasMoreRows,
      handleLoadMoreRows,
      handleCellChange,
      handlePasteCells,
      handleClearRange,
    } = useSpreadsheetTableAdapter({
      sheets,
      activeSheetIndex,
      readOnly,
      onSheetsChange,
      hasExternalMoreRows,
      trimTrailingEmptyRowsOnChange,
      onLoadMoreRows,
    });

    const sheetOptions = useMemo<SelectOption[]>(
      () =>
        sheets.map((sheet, index) => ({
          value: index,
          label: sheet.name,
          triggerLabel: sheet.name,
        })),
      [sheets]
    );

    const handleSheetSelect = useCallback(
      (value: string | number | (string | number)[]) => {
        if (Array.isArray(value)) return;
        onActiveSheetChange?.(Number(value));
      },
      [onActiveSheetChange]
    );

    const toolbarLeading =
      sheets.length > 1 ? (
        <Select
          value={activeSheetIndex}
          onChange={handleSheetSelect}
          options={sheetOptions}
          size="small"
          appearance="ghost"
          radius="lg"
          showSearch
          dropdownMinWidth={180}
          dropdownWidthMode="match"
          className="spreadsheet-editor__sheet-selector"
        />
      ) : null;

    if (!activeSheet) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("placeholders.emptyFile")}
          fillParentHeight
          className={className}
        />
      );
    }

    return (
      <TableSurface
        className={`spreadsheet-editor ${className}`}
        columns={columns}
        rows={rows}
        mode={readOnly ? "readonly" : "editable"}
        toolbarLeading={toolbarLeading}
        showFormulaBar
        hasMoreRows={hasMoreRows}
        loadingMoreRows={loadingMoreRows}
        onCellChange={handleCellChange}
        onPasteCells={handlePasteCells}
        onClearRange={handleClearRange}
        onLoadMoreRows={handleLoadMoreRows}
      />
    );
  }
);

SpreadsheetEditor.displayName = "SpreadsheetEditor";

export type { SpreadsheetData, SpreadsheetEditorProps, SpreadsheetSheet };
export default SpreadsheetEditor;
