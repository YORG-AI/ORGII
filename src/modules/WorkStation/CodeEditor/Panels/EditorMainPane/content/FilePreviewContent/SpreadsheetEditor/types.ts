export type SpreadsheetData = string[][];

export type CellRange = {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
};

export interface SpreadsheetSheet {
  name: string;
  data: SpreadsheetData;
}

export interface SpreadsheetEditorProps {
  sheets: SpreadsheetSheet[];
  activeSheetIndex?: number;
  readOnly?: boolean;
  className?: string;
  hasUnsavedChanges?: boolean;
  saving?: boolean;
  onActiveSheetChange?: (sheetIndex: number) => void;
  onSheetsChange?: (sheets: SpreadsheetSheet[]) => void;
  hasMoreRows?: boolean;
  loadingMoreRows?: boolean;
  trimTrailingEmptyRowsOnChange?: boolean;
  onLoadMoreRows?: () => void | Promise<void>;
  onSave?: () => void | Promise<void>;
  onDiscard?: () => void;
}
