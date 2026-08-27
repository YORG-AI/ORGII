import { Loader2 } from "lucide-react";
import Papa from "papaparse";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type SpreadsheetCsvCellPatch,
  readSpreadsheetCsvPage,
  saveSpreadsheetCsvPatches,
} from "@src/api/tauri/spreadsheetCsv";
import { Message } from "@src/components/Message";
import { Placeholder } from "@src/components/Placeholder";
import { invalidateFileCache } from "@src/modules/WorkStation/CodeEditor/hooks/fileContent/useFileContent";
import { UnsavedChangesBar } from "@src/modules/WorkStation/shared";

import { SpreadsheetEditor, type SpreadsheetSheet } from "../SpreadsheetEditor";
import { ROW_LOAD_INCREMENT } from "../SpreadsheetEditor/constants";
import { clearCsvDraft, getCsvDraft, setCsvDraft } from "./csvDraftCache";

const INITIAL_CSV_ROWS = 50;

type PatchMap = Map<string, SpreadsheetCsvCellPatch>;

function cloneRows(rows: string[][]): string[][] {
  return rows.map((row) => [...row]);
}

function patchesToMap(patches: SpreadsheetCsvCellPatch[]): PatchMap {
  return new Map(
    patches.map((patch) => [patchKey(patch.rowIndex, patch.columnIndex), patch])
  );
}

export interface CsvTableViewProps {
  content: string;
  filePath?: string;
  className?: string;
  readOnly?: boolean;
  hasUnsavedChanges?: boolean;
  saving?: boolean;
  onContentChange?: (content: string) => void;
  onSave?: () => Promise<void>;
  onDiscard?: () => void;
  onSaveSuccess?: () => void;
  onUnsavedChange?: (hasUnsavedChanges: boolean) => void;
}

function getDelimiter(filePath: string): string | undefined {
  const extension = filePath.split(".").pop()?.toLowerCase();
  if (extension === "tsv") return "\t";
  return undefined;
}

function trimTrailingEmptyRows(data: string[][]): string[][] {
  const rows = data.map((row) => row.map((cell) => cell ?? ""));
  while (
    rows.length > 0 &&
    rows[rows.length - 1].every((cell) => cell === "")
  ) {
    rows.pop();
  }
  return rows;
}

function patchKey(rowIndex: number, columnIndex: number): string {
  return `${rowIndex}:${columnIndex}`;
}

function applyPatchMap(rows: string[][], patches: PatchMap): string[][] {
  const nextRows = rows.map((row) => [...row]);
  for (const patch of patches.values()) {
    if (patch.rowIndex >= nextRows.length) continue;
    const row = nextRows[patch.rowIndex];
    while (row.length <= patch.columnIndex) {
      row.push("");
    }
    row[patch.columnIndex] = patch.value;
  }
  return nextRows;
}

function buildPatchMap(
  nextRows: string[][],
  originalRows: string[][]
): PatchMap {
  const patches: PatchMap = new Map();
  const rowCount = Math.max(nextRows.length, originalRows.length);
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const nextRow = nextRows[rowIndex] ?? [];
    const originalRow = originalRows[rowIndex] ?? [];
    const columnCount = Math.max(nextRow.length, originalRow.length);
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const value = nextRow[columnIndex] ?? "";
      if (value === (originalRow[columnIndex] ?? "")) continue;
      patches.set(patchKey(rowIndex, columnIndex), {
        rowIndex,
        columnIndex,
        value,
      });
    }
  }
  return patches;
}

export const CsvTableView: React.FC<CsvTableViewProps> = ({
  content,
  filePath = "",
  className = "",
  readOnly = false,
  onContentChange,
  onSaveSuccess,
  onUnsavedChange,
}) => {
  const { t } = useTranslation();
  const delimiter = useMemo(() => getDelimiter(filePath), [filePath]);
  const [rows, setRows] = useState<string[][]>([]);
  const [originalRows, setOriginalRows] = useState<string[][]>([]);
  const [patches, setPatches] = useState<PatchMap>(() => new Map());
  const [nextRow, setNextRow] = useState(0);
  const [hasMoreRows, setHasMoreRows] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMoreRows, setLoadingMoreRows] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onUnsavedChangeRef = useRef(onUnsavedChange);
  const onSaveSuccessRef = useRef(onSaveSuccess);

  useEffect(() => {
    onUnsavedChangeRef.current = onUnsavedChange;
  }, [onUnsavedChange]);

  useEffect(() => {
    onSaveSuccessRef.current = onSaveSuccess;
  }, [onSaveSuccess]);

  const fallbackParseResult = useMemo(() => {
    if (filePath) return null;
    const result = Papa.parse<string[]>(content, {
      delimiter,
      skipEmptyLines: false,
    });

    if (result.errors.length > 0) {
      return {
        sheet: null,
        error: result.errors[0]?.message ?? t("placeholders.failedToParseCsv"),
      };
    }

    return {
      sheet: {
        name: "CSV",
        data: trimTrailingEmptyRows(result.data),
      },
      error: null,
    };
  }, [content, delimiter, filePath, t]);

  const hasLocalUnsavedChanges = patches.size > 0;

  useEffect(() => {
    onUnsavedChangeRef.current?.(hasLocalUnsavedChanges);
  }, [hasLocalUnsavedChanges]);

  useEffect(() => {
    if (!filePath) return;
    if (!hasLocalUnsavedChanges) {
      clearCsvDraft(filePath);
      return;
    }
    setCsvDraft(filePath, {
      rows,
      originalRows,
      patches: Array.from(patches.values()),
      nextRow,
      hasMoreRows,
    });
  }, [
    filePath,
    hasLocalUnsavedChanges,
    hasMoreRows,
    nextRow,
    originalRows,
    patches,
    rows,
  ]);

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    const cachedDraft = getCsvDraft(filePath);
    if (cachedDraft) {
      setRows(cachedDraft.rows);
      setOriginalRows(cachedDraft.originalRows);
      setPatches(patchesToMap(cachedDraft.patches));
      setNextRow(cachedDraft.nextRow);
      setHasMoreRows(cachedDraft.hasMoreRows);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setRows([]);
    setOriginalRows([]);
    setPatches(new Map());
    setNextRow(0);
    setHasMoreRows(false);

    readSpreadsheetCsvPage({
      path: filePath,
      startRow: 0,
      pageSize: INITIAL_CSV_ROWS,
    })
      .then((page) => {
        if (cancelled) return;
        const pageRows = page.rows;
        setRows(pageRows);
        setOriginalRows(pageRows.map((row) => [...row]));
        setNextRow(page.nextRow);
        setHasMoreRows(page.hasMore);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const handleSheetsChange = useCallback(
    (nextSheets: SpreadsheetSheet[]) => {
      const nextData = nextSheets[0]?.data ?? [];
      if (!filePath) {
        const nextContent = Papa.unparse(nextData, {
          delimiter: delimiter ?? ",",
        });
        onContentChange?.(nextContent);
        return;
      }

      const nextPatches = buildPatchMap(nextData, originalRows);
      setRows(nextData);
      setPatches(nextPatches);
    },
    [delimiter, filePath, onContentChange, originalRows]
  );

  const handleLoadMoreRows = useCallback(async () => {
    if (!filePath || loadingMoreRows || !hasMoreRows) return;
    setLoadingMoreRows(true);
    try {
      const page = await readSpreadsheetCsvPage({
        path: filePath,
        startRow: nextRow,
        pageSize: ROW_LOAD_INCREMENT,
      });
      setRows((currentRows) =>
        applyPatchMap([...currentRows, ...page.rows], patches)
      );
      setOriginalRows((currentRows) => [
        ...currentRows,
        ...page.rows.map((row) => [...row]),
      ]);
      setNextRow(page.nextRow);
      setHasMoreRows(page.hasMore);
    } catch (err) {
      Message.error(
        err instanceof Error ? err.message : t("placeholders.failedToParseCsv")
      );
    } finally {
      setLoadingMoreRows(false);
    }
  }, [filePath, hasMoreRows, loadingMoreRows, nextRow, patches, t]);

  const handleSave = useCallback(async () => {
    if (!filePath || patches.size === 0 || saving) return;
    setSaving(true);
    try {
      await saveSpreadsheetCsvPatches({
        path: filePath,
        patches: Array.from(patches.values()),
      });
      const savedRows = cloneRows(rows);
      setOriginalRows(savedRows);
      setPatches(new Map());
      clearCsvDraft(filePath);
      invalidateFileCache(filePath);
      window.dispatchEvent(
        new CustomEvent("filesync:file-saved", {
          detail: { path: filePath },
        })
      );
      onSaveSuccessRef.current?.();
      Message.success(t("common:status.saved"));
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [filePath, patches, rows, saving, t]);

  const handleDiscard = useCallback(() => {
    const restoredRows = cloneRows(originalRows);
    setRows(restoredRows);
    setPatches(new Map());
    if (filePath) {
      clearCsvDraft(filePath);
      window.dispatchEvent(
        new CustomEvent("filesync:file-discarded", {
          detail: { path: filePath },
        })
      );
    }
  }, [filePath, originalRows]);

  if (fallbackParseResult?.error) {
    return (
      <Placeholder
        variant="error"
        placement="detail-panel"
        title={t("placeholders.failedToParseCsv")}
        subtitle={fallbackParseResult.error}
        fillParentHeight
        className={className}
      />
    );
  }

  if (loading) {
    return (
      <Placeholder
        variant="loading"
        placement="detail-panel"
        fillParentHeight
        className={className}
      />
    );
  }

  if (error) {
    return (
      <Placeholder
        variant="error"
        placement="detail-panel"
        title={t("placeholders.failedToParseCsv")}
        subtitle={error}
        fillParentHeight
        className={className}
      />
    );
  }

  const sheet = filePath
    ? {
        name: filePath.split("/").pop() || "CSV",
        data: rows,
      }
    : fallbackParseResult?.sheet;

  return (
    <div className="relative h-full min-h-0">
      <SpreadsheetEditor
        sheets={sheet ? [sheet] : []}
        readOnly={readOnly || (!filePath && !onContentChange)}
        className={className}
        onSheetsChange={handleSheetsChange}
        hasMoreRows={filePath ? hasMoreRows : undefined}
        loadingMoreRows={loadingMoreRows}
        trimTrailingEmptyRowsOnChange={!filePath}
        onLoadMoreRows={filePath ? handleLoadMoreRows : undefined}
      />
      {hasLocalUnsavedChanges && !readOnly && filePath && (
        <UnsavedChangesBar
          saving={saving}
          onSave={handleSave}
          onDiscard={handleDiscard}
        />
      )}
      {loadingMoreRows && (
        <div className="pointer-events-none absolute bottom-12 right-4 text-text-3">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      )}
    </div>
  );
};

export default CsvTableView;
