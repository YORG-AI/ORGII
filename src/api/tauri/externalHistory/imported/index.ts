import { invoke } from "@tauri-apps/api/core";

import type { DispatchCategory } from "../../session";
import type { ExternalCliSourceProbe } from "../detection";
import {
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS,
  type ImportedHistoryListCategory,
  type ImportedHistorySourceDescriptor,
  type ImportedHistorySourceId,
} from "./descriptors";

export type {
  ImportedHistoryListCategory,
  ImportedHistorySourceDescriptor,
  ImportedHistorySourceId,
};
export { IMPORTED_HISTORY_SOURCE_DESCRIPTORS };

export interface ImportedHistorySource extends ImportedHistorySourceDescriptor {
  dispatchCategory: Extract<DispatchCategory, "external_history">;
}

export interface ImportedHistoryRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

/** Read grouped paths from the source's compact catalog, never its transcript. */
export async function importedHistoryRecentPaths(
  source: ImportedHistorySourceId,
  options?: { limit?: number }
): Promise<ImportedHistoryRecentPath[]> {
  return invoke<ImportedHistoryRecentPath[]>("external_history_recent_paths", {
    source,
    limit: options?.limit,
  });
}

/**
 * Metadata-only source registry. Transcript access is deliberately absent:
 * every renderer consumer must use the source-neutral bounded replay API.
 * This makes an accidental JS full-history fallback a type error.
 */
export const IMPORTED_HISTORY_SOURCES: readonly ImportedHistorySource[] =
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map((descriptor) => ({
    ...descriptor,
    dispatchCategory: "external_history" as const,
  }));

export function getImportedHistorySourceBySessionId(
  sessionId: string | null | undefined
): ImportedHistorySource | undefined {
  if (!sessionId) return undefined;
  return IMPORTED_HISTORY_SOURCES.find((source) =>
    sessionId.startsWith(source.prefix)
  );
}

export function getImportedHistorySourceByListCategory(
  category: ImportedHistoryListCategory
): ImportedHistorySource | undefined {
  return IMPORTED_HISTORY_SOURCES.find(
    (source) => source.listCategory === category
  );
}

export function isImportedHistoryListCategory(
  category: string
): category is ImportedHistoryListCategory {
  return IMPORTED_HISTORY_SOURCES.some(
    (source) => source.listCategory === category
  );
}

export function isImportedHistorySourceSession(
  sessionId: string,
  source: ImportedHistorySource
): boolean {
  return sessionId.startsWith(source.prefix);
}

export function isImportedHistoryReplayableSourceId(
  sourceId: string | null | undefined
): sourceId is ImportedHistorySourceId {
  if (!sourceId) return false;
  return IMPORTED_HISTORY_SOURCES.some(
    (source) => source.sourceId === sourceId
  );
}

export function getDetectedExternalCliSourcesWithoutReplay(
  probes: readonly ExternalCliSourceProbe[]
): ExternalCliSourceProbe[] {
  return probes.filter(
    (probe) => !isImportedHistoryReplayableSourceId(probe.sourceId)
  );
}
