import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type SpreadsheetXlsxCellPatch,
  type SpreadsheetXlsxSheetInfo,
  readSpreadsheetXlsxPage,
  readSpreadsheetXlsxWorkbookInfo,
  saveSpreadsheetXlsxPatches,
} from "@src/api/tauri/spreadsheetXlsx";
import Message from "@src/components/Message";
import { Placeholder } from "@src/components/Placeholder";
import { HugeiconsIcon, Loading03Icon } from "@src/icons";
import { invalidateFileCache } from "@src/modules/WorkStation/CodeEditor/hooks/fileContent/useFileContent";
import { UnsavedChangesBar } from "@src/modules/WorkStation/shared";
import { getFileName } from "@src/util/file/pathUtils";

import { SpreadsheetEditor, type SpreadsheetSheet } from "../SpreadsheetEditor";
import { ROW_LOAD_INCREMENT } from "../SpreadsheetEditor/constants";
import {
  type XlsxDraftSheetState,
  clearXlsxDraft,
  getXlsxDraft,
  setXlsxDraft,
} from "./xlsxDraftCache";

const INITIAL_XLSX_ROWS = 50;

type PatchMap = Map<string, SpreadsheetXlsxCellPatch>;
type SheetStateMap = Record<string, XlsxDraftSheetState>;

interface XlsxPreviewProps {
  filePath: string;
  className?: string;
  readOnly?: boolean;
  onSaveSuccess?: () => void;
  onUnsavedChange?: (hasUnsavedChanges: boolean) => void;
}

function cloneRows(rows: string[][]): string[][] {
  return rows.map((row) => [...row]);
}

function patchKey(rowIndex: number, columnIndex: number): string {
  return `${rowIndex}:${columnIndex}`;
}

function patchesToMap(patches: SpreadsheetXlsxCellPatch[]): PatchMap {
  return new Map(
    patches.map((patch) => [patchKey(patch.rowIndex, patch.columnIndex), patch])
  );
}

function applyPatchMap(
  rows: string[][],
  patches: SpreadsheetXlsxCellPatch[]
): string[][] {
  const patchMap = patchesToMap(patches);
  const nextRows = cloneRows(rows);
  for (const patch of patchMap.values()) {
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
  sheetName: string,
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
        sheetName,
        rowIndex,
        columnIndex,
        value,
      });
    }
  }
  return patches;
}

function hasSheetPatches(sheetStates: SheetStateMap): boolean {
  return Object.values(sheetStates).some((state) => state.patches.length > 0);
}

function allPatches(sheetStates: SheetStateMap): SpreadsheetXlsxCellPatch[] {
  return Object.values(sheetStates).flatMap((state) => state.patches);
}

function sheetUsedSize(rows: string[][]): {
  rowCount: number;
  columnCount: number;
} {
  let rowCount = rows.length;
  while (rowCount > 0 && rows[rowCount - 1].every((cell) => cell === "")) {
    rowCount -= 1;
  }
  const columnCount = rows.slice(0, rowCount).reduce((maxColumns, row) => {
    let count = row.length;
    while (count > 0 && row[count - 1] === "") {
      count -= 1;
    }
    return Math.max(maxColumns, count);
  }, 0);
  return { rowCount, columnCount };
}

export const XlsxPreview: React.FC<XlsxPreviewProps> = ({
  filePath,
  className = "",
  readOnly = false,
  onSaveSuccess,
  onUnsavedChange,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [loadingMoreRows, setLoadingMoreRows] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetInfos, setSheetInfos] = useState<SpreadsheetXlsxSheetInfo[]>([]);
  const [sheetStates, setSheetStates] = useState<SheetStateMap>({});
  const [activeSheet, setActiveSheet] = useState(0);
  const onSaveSuccessRef = useRef(onSaveSuccess);
  const onUnsavedChangeRef = useRef(onUnsavedChange);

  useEffect(() => {
    onSaveSuccessRef.current = onSaveSuccess;
  }, [onSaveSuccess]);

  useEffect(() => {
    onUnsavedChangeRef.current = onUnsavedChange;
  }, [onUnsavedChange]);

  const fileName = useMemo(() => getFileName(filePath), [filePath]);
  const activeSheetName = sheetInfos[activeSheet]?.name ?? null;
  const activeSheetState = activeSheetName
    ? sheetStates[activeSheetName]
    : undefined;
  const hasUnsavedChanges = useMemo(
    () => hasSheetPatches(sheetStates),
    [sheetStates]
  );

  useEffect(() => {
    onUnsavedChangeRef.current?.(hasUnsavedChanges);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (loading) return;
    if (hasUnsavedChanges) {
      setXlsxDraft(filePath, { sheetInfos, sheetStates, activeSheet });
    } else {
      clearXlsxDraft(filePath);
    }
  }, [
    activeSheet,
    filePath,
    hasUnsavedChanges,
    loading,
    sheetInfos,
    sheetStates,
  ]);

  const loadSheetPage = useCallback(
    async (sheetName: string, startRow: number, pageSize: number) => {
      const page = await readSpreadsheetXlsxPage({
        path: filePath,
        sheetName,
        startRow,
        pageSize,
      });
      return {
        rows: page.rows,
        nextRow: page.nextRow,
        hasMoreRows: page.hasMore,
        rowCount: page.rowCount,
        columnCount: page.columnCount,
      };
    },
    [filePath]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const draft = getXlsxDraft(filePath);
    if (draft) {
      setSheetInfos(draft.sheetInfos);
      setSheetStates(draft.sheetStates);
      setActiveSheet(draft.activeSheet);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    readSpreadsheetXlsxWorkbookInfo({ path: filePath })
      .then(async (info) => {
        if (cancelled) return;
        setSheetInfos(info.sheets);
        setActiveSheet(0);
        const firstSheet = info.sheets[0]?.name;
        if (!firstSheet) {
          setSheetStates({});
          return;
        }
        const page = await loadSheetPage(firstSheet, 0, INITIAL_XLSX_ROWS);
        if (cancelled) return;
        setSheetStates({
          [firstSheet]: {
            rows: page.rows,
            originalRows: cloneRows(page.rows),
            patches: [],
            nextRow: page.nextRow,
            hasMoreRows: page.hasMoreRows,
          },
        });
        setSheetInfos((currentInfos) =>
          currentInfos.map((sheetInfo) =>
            sheetInfo.name === firstSheet
              ? {
                  ...sheetInfo,
                  rowCount: page.rowCount,
                  columnCount: page.columnCount,
                }
              : sheetInfo
          )
        );
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
  }, [filePath, loadSheetPage]);

  const ensureSheetLoaded = useCallback(
    async (sheetIndex: number) => {
      const sheetName = sheetInfos[sheetIndex]?.name;
      if (!sheetName || sheetStates[sheetName]) return;
      setLoading(true);
      try {
        const page = await loadSheetPage(sheetName, 0, INITIAL_XLSX_ROWS);
        setSheetStates((currentStates) => ({
          ...currentStates,
          [sheetName]: {
            rows: page.rows,
            originalRows: cloneRows(page.rows),
            patches: [],
            nextRow: page.nextRow,
            hasMoreRows: page.hasMoreRows,
          },
        }));
        setSheetInfos((currentInfos) =>
          currentInfos.map((sheetInfo) =>
            sheetInfo.name === sheetName
              ? {
                  ...sheetInfo,
                  rowCount: page.rowCount,
                  columnCount: page.columnCount,
                }
              : sheetInfo
          )
        );
      } catch (err) {
        Message.error(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [loadSheetPage, sheetInfos, sheetStates]
  );

  const handleActiveSheetChange = useCallback(
    (sheetIndex: number) => {
      setActiveSheet(sheetIndex);
      void ensureSheetLoaded(sheetIndex);
    },
    [ensureSheetLoaded]
  );

  const handleSheetsChange = useCallback(
    (nextSheets: SpreadsheetSheet[]) => {
      const sheetName = sheetInfos[activeSheet]?.name;
      if (!sheetName) return;
      const nextData = nextSheets[activeSheet]?.data ?? [];
      setSheetStates((currentStates) => {
        const currentState = currentStates[sheetName];
        if (!currentState) return currentStates;
        const nextPatches = Array.from(
          buildPatchMap(sheetName, nextData, currentState.originalRows).values()
        );
        return {
          ...currentStates,
          [sheetName]: {
            ...currentState,
            rows: nextData,
            patches: nextPatches,
          },
        };
      });
    },
    [activeSheet, sheetInfos]
  );

  const handleLoadMoreRows = useCallback(async () => {
    if (!activeSheetName || !activeSheetState?.hasMoreRows || loadingMoreRows)
      return;
    setLoadingMoreRows(true);
    try {
      const page = await loadSheetPage(
        activeSheetName,
        activeSheetState.nextRow,
        ROW_LOAD_INCREMENT
      );
      setSheetStates((currentStates) => {
        const currentState = currentStates[activeSheetName];
        if (!currentState) return currentStates;
        const appendedOriginalRows = [
          ...currentState.originalRows,
          ...cloneRows(page.rows),
        ];
        const appendedRows = applyPatchMap(
          [...currentState.rows, ...page.rows],
          currentState.patches
        );
        return {
          ...currentStates,
          [activeSheetName]: {
            rows: appendedRows,
            originalRows: appendedOriginalRows,
            patches: currentState.patches,
            nextRow: page.nextRow,
            hasMoreRows: page.hasMoreRows,
          },
        };
      });
      setSheetInfos((currentInfos) =>
        currentInfos.map((sheetInfo) =>
          sheetInfo.name === activeSheetName
            ? {
                ...sheetInfo,
                rowCount: page.rowCount,
                columnCount: page.columnCount,
              }
            : sheetInfo
        )
      );
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMoreRows(false);
    }
  }, [activeSheetName, activeSheetState, loadSheetPage, loadingMoreRows]);

  const handleSave = useCallback(async () => {
    if (!hasUnsavedChanges || saving) return;
    setSaving(true);
    try {
      await saveSpreadsheetXlsxPatches({
        path: filePath,
        patches: allPatches(sheetStates),
      });
      setSheetStates((currentStates) =>
        Object.fromEntries(
          Object.entries(currentStates).map(([sheetName, state]) => [
            sheetName,
            {
              ...state,
              originalRows: cloneRows(state.rows),
              patches: [],
            },
          ])
        )
      );
      setSheetInfos((currentInfos) =>
        currentInfos.map((sheetInfo) => {
          const state = sheetStates[sheetInfo.name];
          if (!state) return sheetInfo;
          return { ...sheetInfo, ...sheetUsedSize(state.rows) };
        })
      );
      clearXlsxDraft(filePath);
      invalidateFileCache(filePath);
      window.dispatchEvent(
        new CustomEvent("filesync:file-saved", {
          detail: { path: filePath },
        })
      );
      onSaveSuccessRef.current?.();
      Message.success(t("common:status.saved"));
    } catch (err) {
      Message.error(
        err instanceof Error ? err.message : t("common:status.saveFailed")
      );
    } finally {
      setSaving(false);
    }
  }, [filePath, hasUnsavedChanges, saving, sheetStates, t]);

  const handleDiscard = useCallback(() => {
    setSheetStates((currentStates) =>
      Object.fromEntries(
        Object.entries(currentStates).map(([sheetName, state]) => [
          sheetName,
          {
            ...state,
            rows: cloneRows(state.originalRows),
            patches: [],
          },
        ])
      )
    );
    clearXlsxDraft(filePath);
    window.dispatchEvent(
      new CustomEvent("filesync:file-discarded", {
        detail: { path: filePath },
      })
    );
  }, [filePath]);

  const sheets = useMemo<SpreadsheetSheet[]>(
    () =>
      sheetInfos.map((sheetInfo) => ({
        name: sheetInfo.name,
        data: sheetStates[sheetInfo.name]?.rows ?? [],
      })),
    [sheetInfos, sheetStates]
  );

  if (error) {
    return (
      <Placeholder
        variant="error"
        placement="detail-panel"
        title={error}
        subtitle={fileName}
        fillParentHeight
        className={className}
      />
    );
  }

  return (
    <div className={`relative h-full min-h-0 ${className}`}>
      {loading && (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          fillParentHeight
          className="absolute inset-0 z-10 bg-bg-1/60"
        />
      )}

      {!loading && (
        <SpreadsheetEditor
          sheets={sheets}
          activeSheetIndex={activeSheet}
          readOnly={readOnly}
          hasUnsavedChanges={hasUnsavedChanges}
          saving={saving}
          hasMoreRows={activeSheetState?.hasMoreRows}
          loadingMoreRows={loadingMoreRows}
          trimTrailingEmptyRowsOnChange={!activeSheetState?.hasMoreRows}
          onActiveSheetChange={handleActiveSheetChange}
          onSheetsChange={handleSheetsChange}
          onLoadMoreRows={
            activeSheetState?.hasMoreRows ? handleLoadMoreRows : undefined
          }
          onSave={handleSave}
          onDiscard={handleDiscard}
        />
      )}

      {hasUnsavedChanges && !readOnly && (
        <UnsavedChangesBar
          saving={saving}
          onSave={() => {
            void handleSave();
          }}
          onDiscard={handleDiscard}
        />
      )}

      {loadingMoreRows && (
        <div className="pointer-events-none absolute right-4 bottom-12 text-text-3">
          <HugeiconsIcon
            icon={Loading03Icon}
            data-icon="loader-2"
            className="h-4 w-4 animate-spin"
          />
        </div>
      )}
    </div>
  );
};

export default XlsxPreview;
