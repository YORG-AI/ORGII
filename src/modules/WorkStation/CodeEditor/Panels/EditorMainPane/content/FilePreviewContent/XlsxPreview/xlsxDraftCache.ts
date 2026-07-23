import type {
  SpreadsheetXlsxCellPatch,
  SpreadsheetXlsxSheetInfo,
} from "@src/api/tauri/spreadsheetXlsx";

const MAX_XLSX_DRAFT_CACHE_SIZE = 50;
const MAX_XLSX_DRAFT_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_XLSX_DRAFT_ENTRY_BYTES = 4 * 1024 * 1024;
const CONTAINER_OVERHEAD_BYTES = 24;

export interface XlsxDraftSheetState {
  rows: string[][];
  originalRows: string[][];
  patches: SpreadsheetXlsxCellPatch[];
  nextRow: number;
  hasMoreRows: boolean;
}

export interface XlsxDraftEntry {
  sheetInfos: SpreadsheetXlsxSheetInfo[];
  sheetStates: Record<string, XlsxDraftSheetState>;
  activeSheet: number;
}

interface RetainedXlsxDraft {
  entry: XlsxDraftEntry;
  bytes: number;
}

const draftCache = new Map<string, RetainedXlsxDraft>();
let retainedBytes = 0;

if (typeof window !== "undefined") {
  window.addEventListener("filesync:file-discarded", (event) => {
    const path = (event as CustomEvent<{ path?: unknown }>).detail?.path;
    if (typeof path === "string") {
      clearXlsxDraft(path);
    }
  });
}

function cloneRows(rows: string[][]): string[][] {
  return rows.map((row) => [...row]);
}

function cloneSheetStates(
  sheetStates: Record<string, XlsxDraftSheetState>
): Record<string, XlsxDraftSheetState> {
  return Object.fromEntries(
    Object.entries(sheetStates).map(([sheetName, state]) => [
      sheetName,
      {
        rows: cloneRows(state.rows),
        originalRows: cloneRows(state.originalRows),
        patches: state.patches.map((patch) => ({ ...patch })),
        nextRow: state.nextRow,
        hasMoreRows: state.hasMoreRows,
      },
    ])
  );
}

function estimateStringBytes(value: string): number {
  return CONTAINER_OVERHEAD_BYTES + value.length * 2;
}

function estimateRowsBytes(rows: string[][]): number {
  let bytes = CONTAINER_OVERHEAD_BYTES + rows.length * 8;
  for (const row of rows) {
    bytes += CONTAINER_OVERHEAD_BYTES + row.length * 8;
    for (const cell of row) bytes += estimateStringBytes(cell);
  }
  return bytes;
}

function estimateDraftBytes(entry: XlsxDraftEntry): number {
  let bytes =
    CONTAINER_OVERHEAD_BYTES +
    entry.sheetInfos.length * 64 +
    Object.keys(entry.sheetStates).length * CONTAINER_OVERHEAD_BYTES;
  for (const info of entry.sheetInfos) bytes += estimateStringBytes(info.name);
  for (const [sheetName, state] of Object.entries(entry.sheetStates)) {
    bytes +=
      estimateStringBytes(sheetName) +
      estimateRowsBytes(state.rows) +
      estimateRowsBytes(state.originalRows) +
      CONTAINER_OVERHEAD_BYTES +
      state.patches.length * 64;
    for (const patch of state.patches) {
      bytes +=
        estimateStringBytes(patch.sheetName) + estimateStringBytes(patch.value);
    }
  }
  return bytes;
}

function cloneEntry(entry: XlsxDraftEntry): XlsxDraftEntry {
  return {
    sheetInfos: entry.sheetInfos.map((sheetInfo) => ({ ...sheetInfo })),
    sheetStates: cloneSheetStates(entry.sheetStates),
    activeSheet: entry.activeSheet,
  };
}

function deleteRetainedDraft(filePath: string): void {
  const retained = draftCache.get(filePath);
  if (!retained) return;
  retainedBytes = Math.max(0, retainedBytes - retained.bytes);
  draftCache.delete(filePath);
}

function evictOldestDraft(): boolean {
  const firstKey = draftCache.keys().next().value;
  if (typeof firstKey !== "string") return false;
  deleteRetainedDraft(firstKey);
  return true;
}

export function getXlsxDraft(filePath: string): XlsxDraftEntry | null {
  const retained = draftCache.get(filePath);
  if (!retained) return null;
  draftCache.delete(filePath);
  draftCache.set(filePath, retained);
  return cloneEntry(retained.entry);
}

export function setXlsxDraft(filePath: string, entry: XlsxDraftEntry): boolean {
  const bytes = estimateDraftBytes(entry);
  deleteRetainedDraft(filePath);
  if (bytes > MAX_XLSX_DRAFT_ENTRY_BYTES) return false;

  while (
    draftCache.size >= MAX_XLSX_DRAFT_CACHE_SIZE ||
    retainedBytes + bytes > MAX_XLSX_DRAFT_CACHE_BYTES
  ) {
    if (!evictOldestDraft()) return false;
  }

  draftCache.set(filePath, { entry: cloneEntry(entry), bytes });
  retainedBytes += bytes;
  return true;
}

export function clearXlsxDraft(filePath: string): void {
  deleteRetainedDraft(filePath);
}

export const xlsxDraftCacheTestApi = {
  clear(): void {
    draftCache.clear();
    retainedBytes = 0;
  },
  stats(): { entries: number; bytes: number } {
    return { entries: draftCache.size, bytes: retainedBytes };
  },
  limits: {
    entries: MAX_XLSX_DRAFT_CACHE_SIZE,
    bytes: MAX_XLSX_DRAFT_CACHE_BYTES,
    entryBytes: MAX_XLSX_DRAFT_ENTRY_BYTES,
  },
};
