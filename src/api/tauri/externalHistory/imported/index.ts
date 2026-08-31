import type { ActivityChunk } from "@src/types/session/session";

import type { DispatchCategory } from "../../session";
import { cursorIdeChunks, cursorIdeInitialWindow } from "../cursorIde";
import type { ExternalCliSourceProbe } from "../detection";
import {
  type ImportedTranscriptStat,
  claudeCodeHistoryChunks,
  claudeCodeHistoryStat,
} from "../sources/claudeCode";
import { clineHistoryChunks } from "../sources/cline";
import { codexAppChunks, codexAppInitialWindow } from "../sources/codexApp";
import { copilotHistoryChunks } from "../sources/copilot";
import { cursorCliHistoryChunks } from "../sources/cursorCli";
import { kimiHistoryChunks } from "../sources/kimi";
import { mimoCodeHistoryChunks } from "../sources/mimoCode";
import { ompHistoryChunks } from "../sources/omp";
import { opencodeHistoryChunks } from "../sources/opencode";
import { piHistoryChunks } from "../sources/pi";
import { qoderHistoryChunks } from "../sources/qoder";
import { qoderCliHistoryChunks } from "../sources/qoderCli";
import { qwenCodeHistoryChunks } from "../sources/qwenCode";
import { traeHistoryChunks } from "../sources/trae";
import { warpHistoryChunks } from "../sources/warp";
import { windsurfHistoryChunks } from "../sources/windsurf";
import { workBuddyHistoryChunks } from "../sources/workbuddy";
import { zcodeHistoryChunks } from "../sources/zcode";
import {
  type ImportedHistoryCloudTurnWindow,
  importedHistoryCloudTurnIds,
  importedHistoryCloudTurnWindows,
} from "./cloudReplay";
import {
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS,
  type ImportedHistoryListCategory,
  type ImportedHistorySourceDescriptor,
  type ImportedHistorySourceId,
} from "./descriptors";
import { importedHistoryStat } from "./stat";
import { importedHistoryInitialWindow } from "./window";

export type {
  ImportedHistoryListCategory,
  ImportedHistorySourceDescriptor,
  ImportedHistorySourceId,
};
export { IMPORTED_HISTORY_SOURCE_DESCRIPTORS };
export type { ImportedHistoryCloudTurnWindow };
export {
  importedHistoryInitialWindow,
  importedHistoryTurnWindows,
  type ImportedHistoryInitialWindow,
  type ImportedHistoryTurnWindow,
} from "./window";

export type { ImportedTranscriptStat };

export interface ImportedHistorySource extends ImportedHistorySourceDescriptor {
  dispatchCategory: Extract<DispatchCategory, "external_history">;
  /** Fast/windowed transcript used when the user opens the local history. */
  loadPreviewChunks(sessionId: string): Promise<ActivityChunk[]>;
  /** Complete source transcript used for cloud replay/fork publication. */
  loadFullTranscriptChunks(sessionId: string): Promise<ActivityChunk[]>;
  /**
   * Bounded turn-addressable read used by Cloud after an authoritative full
   * anchor exists. Unsupported providers omit both methods and retain the
   * complete-transcript fallback.
   */
  loadCloudTurnIds?(sessionId: string): Promise<string[]>;
  loadCloudTurnWindows?(
    sessionId: string,
    turnIds: string[],
    startSequence: number
  ): Promise<ImportedHistoryCloudTurnWindow[]>;
  /**
   * Optional freshness probe (one backend `stat`). When present, the replay
   * auto-refresh compares it against the previous tick and skips the full
   * read/parse/merge pipeline while the transcript is unchanged. Sources
   * without it simply refresh unconditionally.
   */
  statTranscript?(sessionId: string): Promise<ImportedTranscriptStat | null>;
}

const CURSOR_IDE_INITIAL_RECENT_BUBBLE_LIMIT = 100;
const IMPORTED_HISTORY_INITIAL_RECENT_TURN_COUNT = 1;

async function loadGenericPreviewChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return (
    await importedHistoryInitialWindow({
      sessionId,
      recentTurnCount: IMPORTED_HISTORY_INITIAL_RECENT_TURN_COUNT,
    })
  ).chunks;
}

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
    statTranscript: (sessionId) => importedHistoryStat("cursor_ide", sessionId),
    async loadPreviewChunks(sessionId) {
      return (
        await cursorIdeInitialWindow({
          sessionId,
          recentLimit: CURSOR_IDE_INITIAL_RECENT_BUBBLE_LIMIT,
        })
      ).chunks;
    },
    loadFullTranscriptChunks: cursorIdeChunks,
    loadCloudTurnIds: importedHistoryCloudTurnIds,
    loadCloudTurnWindows: (sessionId, turnIds, startSequence) =>
      importedHistoryCloudTurnWindows({ sessionId, turnIds, startSequence }),
  },
  {
    ...descriptorFor("cursor_cli"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("cursor_cli", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: cursorCliHistoryChunks,
  },
  {
    ...descriptorFor("codex_app"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("codex_app", sessionId),
    async loadPreviewChunks(sessionId) {
      return (await codexAppInitialWindow(sessionId)).chunks;
    },
    loadFullTranscriptChunks: codexAppChunks,
    loadCloudTurnIds: importedHistoryCloudTurnIds,
    loadCloudTurnWindows: (sessionId, turnIds, startSequence) =>
      importedHistoryCloudTurnWindows({ sessionId, turnIds, startSequence }),
  },
  {
    ...descriptorFor("claude_code"),
    dispatchCategory: "external_history",
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: claudeCodeHistoryChunks,
    statTranscript: claudeCodeHistoryStat,
    loadCloudTurnIds: importedHistoryCloudTurnIds,
    loadCloudTurnWindows: (sessionId, turnIds, startSequence) =>
      importedHistoryCloudTurnWindows({ sessionId, turnIds, startSequence }),
  },
  {
    ...descriptorFor("opencode"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("opencode", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: opencodeHistoryChunks,
  },
  {
    ...descriptorFor("windsurf"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("windsurf", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: windsurfHistoryChunks,
  },
  {
    ...descriptorFor("workbuddy"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("workbuddy", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: workBuddyHistoryChunks,
  },
  {
    ...descriptorFor("trae"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("trae", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: traeHistoryChunks,
  },
  {
    ...descriptorFor("cline"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("cline", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: clineHistoryChunks,
  },
  {
    ...descriptorFor("warp"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("warp", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: warpHistoryChunks,
  },
  {
    ...descriptorFor("zcode"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("zcode", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: zcodeHistoryChunks,
  },
  {
    ...descriptorFor("qoder"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("qoder", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: qoderHistoryChunks,
  },
  {
    ...descriptorFor("mimo_code"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("mimo_code", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: mimoCodeHistoryChunks,
  },
  {
    ...descriptorFor("omp"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("omp", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: ompHistoryChunks,
  },
  {
    ...descriptorFor("pi"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("pi", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: piHistoryChunks,
  },
  {
    ...descriptorFor("qoder_cli"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("qoder_cli", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: qoderCliHistoryChunks,
  },
  {
    ...descriptorFor("qwen_code"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("qwen_code", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: qwenCodeHistoryChunks,
  },
  {
    ...descriptorFor("copilot"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("copilot", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: copilotHistoryChunks,
  },
  {
    ...descriptorFor("kimi"),
    dispatchCategory: "external_history",
    statTranscript: (sessionId) => importedHistoryStat("kimi", sessionId),
    loadPreviewChunks: loadGenericPreviewChunks,
    loadFullTranscriptChunks: kimiHistoryChunks,
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

/**
 * The native-CLI continuation capability of the source owning `sessionId`,
 * or `undefined` when the source is a pure read-only replay (no CLI can
 * reopen its sessions). Sync and prefix-driven so render gates (composer,
 * continue button) don't need the backend plan call; the backend stays
 * authoritative per session.
 */
export function getImportedHistoryCliResume(
  sessionId: string | null | undefined
) {
  return getImportedHistorySourceBySessionId(sessionId)?.cliResume;
}

/**
 * The native-app deep-link capability of the source owning `sessionId`, or
 * `undefined` when no verified per-session app link exists for it. Sync and
 * prefix-driven for the same reason as {@link getImportedHistoryCliResume}:
 * render gates must not pay a backend round-trip per session.
 */
export function getImportedHistoryAppOpen(
  sessionId: string | null | undefined
) {
  return getImportedHistorySourceBySessionId(sessionId)?.appOpen;
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
