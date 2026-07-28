/**
 * RuntimeScanningPanelHelpers
 *
 * Pure helpers for RuntimeScanningPanel: which detected sources are
 * "importable" (have a cache and support Rescan), and the status tag
 * (color + i18n label key) shown for a row given its load/error/enabled
 * state.
 */
import {
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS,
  type ImportedHistorySourceId,
} from "@src/api/tauri/externalHistory";
import type { TagProps } from "@src/components/Tag";

import type { SourceRow } from "./RuntimeScanningPanelTypes";

// The sources ORGII imports history from (have a cache + support Rescan).
export const IMPORTABLE_SOURCE_IDS = new Set<ImportedHistorySourceId>(
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map((d) => d.sourceId)
);

export function isImportableId(id: string): id is ImportedHistorySourceId {
  return IMPORTABLE_SOURCE_IDS.has(id as ImportedHistorySourceId);
}

export const importableStatusTag = (
  row: SourceRow
): { color: TagProps["color"]; labelKey: string } => {
  if (row.statsLoading) return { color: "processing", labelKey: "loading" };
  if (row.error) return { color: "danger", labelKey: "error" };
  if (row.stats && row.stats.sessionCount > 0) {
    return { color: "success", labelKey: "ready" };
  }
  return { color: "default", labelKey: "empty" };
};

export const statusTagFor = (
  row: SourceRow,
  disabled: boolean
): { color: TagProps["color"]; labelKey: string } => {
  if (disabled) return { color: "default", labelKey: "disabled" };
  if (row.importable) return importableStatusTag(row);
  return row.probe.installed
    ? { color: "success", labelKey: "installed" }
    : { color: "default", labelKey: "notInstalled" };
};
