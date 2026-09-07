import {
  MIN_COLUMNS,
  MIN_ROWS,
  TRAILING_BLANK_COLUMNS,
  TRAILING_BLANK_ROWS,
} from "./constants";
import type { CellRange, SpreadsheetData, SpreadsheetSheet } from "./types";

export function getSourceRowCount(data: SpreadsheetData): number {
  return data.length;
}

export function getSourceColumnCount(data: SpreadsheetData): number {
  return Math.max(0, ...data.map((row) => row.length));
}

export function getRenderedColumnCount(data: SpreadsheetData): number {
  return Math.max(
    MIN_COLUMNS,
    getSourceColumnCount(data) + TRAILING_BLANK_COLUMNS
  );
}

export function normalizeData(
  data: SpreadsheetData,
  visibleSourceRowLimit: number = data.length,
  hasExternalHiddenRows = false
): SpreadsheetData {
  const visibleData = data.slice(0, visibleSourceRowLimit);
  const hasHiddenSourceRows = visibleSourceRowLimit < data.length;
  const shouldAppendTrailingRows =
    !hasHiddenSourceRows && !hasExternalHiddenRows;
  const rowCount = Math.max(
    MIN_ROWS,
    visibleData.length + (shouldAppendTrailingRows ? TRAILING_BLANK_ROWS : 0)
  );
  const columnCount = getRenderedColumnCount(data);

  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const sourceRow = visibleData[rowIndex] ?? [];
    return Array.from({ length: columnCount }, (_, columnIndex) => {
      return sourceRow[columnIndex] ?? "";
    });
  });
}

export function trimData(data: SpreadsheetData): SpreadsheetData {
  const rows = data.map((row) => [...row]);

  while (
    rows.length > 0 &&
    rows[rows.length - 1].every((cell) => cell === "")
  ) {
    rows.pop();
  }

  let maxColumnIndex = -1;
  rows.forEach((row) => {
    row.forEach((cell, columnIndex) => {
      if (cell !== "") {
        maxColumnIndex = Math.max(maxColumnIndex, columnIndex);
      }
    });
  });

  if (maxColumnIndex < 0) {
    return [];
  }

  return rows.map((row) => row.slice(0, maxColumnIndex + 1));
}

export function cloneSheetsWithData(
  sheets: SpreadsheetSheet[],
  sheetIndex: number,
  data: SpreadsheetData,
  trimTrailingEmptyRows = true
): SpreadsheetSheet[] {
  return sheets.map((sheet, index) =>
    index === sheetIndex
      ? { ...sheet, data: trimTrailingEmptyRows ? trimData(data) : data }
      : sheet
  );
}

export function isSingleCellRange(range: CellRange): boolean {
  return (
    range.startRow === range.endRow && range.startColumn === range.endColumn
  );
}

export function ensureDataSize(
  data: SpreadsheetData,
  rowCount: number,
  columnCount: number
): SpreadsheetData {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const sourceRow = data[rowIndex] ?? [];
    return Array.from(
      { length: columnCount },
      (_, columnIndex) => sourceRow[columnIndex] ?? ""
    );
  });
}
