import type { SpreadsheetCsvCellPatch } from "@src/api/tauri/spreadsheetCsv";

const MAX_CSV_DRAFT_ENTRIES = 20;
const MAX_CSV_DRAFT_BYTES = 16 * 1024 * 1024;
const MAX_CSV_DRAFT_ENTRY_BYTES = 4 * 1024 * 1024;
const CONTAINER_OVERHEAD_BYTES = 24;

export interface CsvDraftState {
  rows: string[][];
  originalRows: string[][];
  patches: SpreadsheetCsvCellPatch[];
  nextRow: number;
  hasMoreRows: boolean;
}

interface RetainedCsvDraft {
  draft: CsvDraftState;
  bytes: number;
}

const csvDraftCache = new Map<string, RetainedCsvDraft>();
let retainedBytes = 0;

if (typeof window !== "undefined") {
  window.addEventListener("filesync:file-discarded", (event) => {
    const path = (event as CustomEvent<{ path?: unknown }>).detail?.path;
    if (typeof path === "string") clearCsvDraft(path);
  });
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

function estimateDraftBytes(draft: CsvDraftState): number {
  let bytes =
    CONTAINER_OVERHEAD_BYTES +
    estimateRowsBytes(draft.rows) +
    estimateRowsBytes(draft.originalRows) +
    CONTAINER_OVERHEAD_BYTES +
    draft.patches.length * 48;
  for (const patch of draft.patches) bytes += estimateStringBytes(patch.value);
  return bytes;
}

function cloneRows(rows: string[][]): string[][] {
  return rows.map((row) => [...row]);
}

function cloneDraft(draft: CsvDraftState): CsvDraftState {
  return {
    rows: cloneRows(draft.rows),
    originalRows: cloneRows(draft.originalRows),
    patches: draft.patches.map((patch) => ({ ...patch })),
    nextRow: draft.nextRow,
    hasMoreRows: draft.hasMoreRows,
  };
}

function deleteRetainedDraft(filePath: string): void {
  const retained = csvDraftCache.get(filePath);
  if (!retained) return;
  retainedBytes = Math.max(0, retainedBytes - retained.bytes);
  csvDraftCache.delete(filePath);
}

function evictOldestDraft(): boolean {
  const oldestPath = csvDraftCache.keys().next().value;
  if (typeof oldestPath !== "string") return false;
  deleteRetainedDraft(oldestPath);
  return true;
}

export function getCsvDraft(filePath: string): CsvDraftState | null {
  const retained = csvDraftCache.get(filePath);
  if (!retained) return null;
  csvDraftCache.delete(filePath);
  csvDraftCache.set(filePath, retained);
  return cloneDraft(retained.draft);
}

/**
 * Retains a draft only when it fits the hard per-file and global byte budgets.
 * Oversized drafts remain in the mounted editor state but are not duplicated
 * into the app-lifetime cache.
 */
export function setCsvDraft(filePath: string, draft: CsvDraftState): boolean {
  const bytes = estimateDraftBytes(draft);
  deleteRetainedDraft(filePath);
  if (bytes > MAX_CSV_DRAFT_ENTRY_BYTES) return false;

  while (
    csvDraftCache.size >= MAX_CSV_DRAFT_ENTRIES ||
    retainedBytes + bytes > MAX_CSV_DRAFT_BYTES
  ) {
    if (!evictOldestDraft()) return false;
  }

  csvDraftCache.set(filePath, { draft: cloneDraft(draft), bytes });
  retainedBytes += bytes;
  return true;
}

export function clearCsvDraft(filePath: string): void {
  deleteRetainedDraft(filePath);
}

export const csvDraftCacheTestApi = {
  clear(): void {
    csvDraftCache.clear();
    retainedBytes = 0;
  },
  stats(): { entries: number; bytes: number } {
    return { entries: csvDraftCache.size, bytes: retainedBytes };
  },
  limits: {
    entries: MAX_CSV_DRAFT_ENTRIES,
    bytes: MAX_CSV_DRAFT_BYTES,
    entryBytes: MAX_CSV_DRAFT_ENTRY_BYTES,
  },
};
