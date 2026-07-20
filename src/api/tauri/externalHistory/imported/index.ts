import type { ActivityChunk } from "@src/types/session/session";

import type { DispatchCategory } from "../../session";
import { cursorIdeInitialWindow } from "../cursorIde";
import type { ExternalCliSourceProbe } from "../detection";
import { claudeCodeHistoryChunks } from "../sources/claudeCode";
import { clineHistoryChunks } from "../sources/cline";
import { codexAppChunks } from "../sources/codexApp";
import { opencodeHistoryChunks } from "../sources/opencode";
import { qoderHistoryChunks } from "../sources/qoder";
import { traeHistoryChunks } from "../sources/trae";
import { warpHistoryChunks } from "../sources/warp";
import { windsurfHistoryChunks } from "../sources/windsurf";
import { workBuddyHistoryChunks } from "../sources/workbuddy";
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
  loadChunks(sessionId: string): Promise<ActivityChunk[]>;
}

const CURSOR_IDE_INITIAL_RECENT_BUBBLE_LIMIT = 100;

function descriptorFor(
  sourceId: ImportedHistorySourceId
): ImportedHistorySourceDescriptor {
  const descriptor = IMPORTED_HISTORY_SOURCE_DESCRIPTORS.find(
    (entry) => entry.sourceId === sourceId
  );
  if (!descriptor) {
    throw new Error(`Missing imported history source descriptor: ${sourceId}`);
  }
  return descriptor;
}

export const IMPORTED_HISTORY_SOURCES: readonly ImportedHistorySource[] = [
  {
    ...descriptorFor("cursor_ide"),
    dispatchCategory: "external_history",
    async loadChunks(sessionId) {
      return (
        await cursorIdeInitialWindow({
          sessionId,
          recentLimit: CURSOR_IDE_INITIAL_RECENT_BUBBLE_LIMIT,
        })
      ).chunks;
    },
  },
  {
    ...descriptorFor("codex_app"),
    dispatchCategory: "external_history",
    loadChunks: codexAppChunks,
  },
  {
    ...descriptorFor("claude_code"),
    dispatchCategory: "external_history",
    loadChunks: claudeCodeHistoryChunks,
  },
  {
    ...descriptorFor("opencode"),
    dispatchCategory: "external_history",
    loadChunks: opencodeHistoryChunks,
  },
  {
    ...descriptorFor("windsurf"),
    dispatchCategory: "external_history",
    loadChunks: windsurfHistoryChunks,
  },
  {
    ...descriptorFor("workbuddy"),
    dispatchCategory: "external_history",
    loadChunks: workBuddyHistoryChunks,
  },
  {
    ...descriptorFor("trae"),
    dispatchCategory: "external_history",
    loadChunks: traeHistoryChunks,
  },
  {
    ...descriptorFor("cline"),
    dispatchCategory: "external_history",
    loadChunks: clineHistoryChunks,
  },
  {
    ...descriptorFor("warp"),
    dispatchCategory: "external_history",
    loadChunks: warpHistoryChunks,
  },
  {
    ...descriptorFor("qoder"),
    dispatchCategory: "external_history",
    loadChunks: qoderHistoryChunks,
  },
];

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
