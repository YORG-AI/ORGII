import type { ExternalReplayTurnSummary } from "@src/api/tauri/externalHistory";
import type { ExternalReplayWindow } from "@src/api/tauri/externalHistory/replay";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { externalReplayTurnSummariesAtomFamily } from "@src/store/session/externalReplayTurnSummariesAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

export const EXTERNAL_REPLAY_TURN_PLACEHOLDER_PREFIX =
  "__external_replay_turn_index__:";

// One server window is capped at 10 turns. Two extra slots retain an already
// visited neighbour on either edge while the LRU is trimmed, so browsing a
// very large transcript never leaves one header object per historical turn.
export const MAX_LOADED_EXTERNAL_REPLAY_TURN_SUMMARIES = 12;

export interface ExternalReplayTurnEpisode {
  id: number;
  generation: string | null;
}

let nextExternalReplayTurnEpisode = 0;
const replayEpisodes = new Map<string, ExternalReplayTurnEpisode>();
const loadedSummariesByArray = new WeakMap<
  ExternalReplayTurnSummary[],
  ReadonlyMap<number, ExternalReplayTurnSummary>
>();
const summaryGenerationsByArray = new WeakMap<
  ExternalReplayTurnSummary[],
  string
>();

export function externalReplayPlaceholderId(turnIndex: number): string {
  return `${EXTERNAL_REPLAY_TURN_PLACEHOLDER_PREFIX}${turnIndex}`;
}

export function externalReplayTurnIndexFromId(turnId: string): number | null {
  if (!turnId.startsWith(EXTERNAL_REPLAY_TURN_PLACEHOLDER_PREFIX)) return null;
  const value = Number(
    turnId.slice(EXTERNAL_REPLAY_TURN_PLACEHOLDER_PREFIX.length)
  );
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function startExternalReplayTurnEpisode(
  sessionId: string,
  generation: string | null = null
): ExternalReplayTurnEpisode {
  const episode = {
    id: ++nextExternalReplayTurnEpisode,
    generation,
  };
  replayEpisodes.set(sessionId, episode);
  return episode;
}

export function captureExternalReplayTurnEpisode(
  sessionId: string
): ExternalReplayTurnEpisode {
  return (
    replayEpisodes.get(sessionId) ?? startExternalReplayTurnEpisode(sessionId)
  );
}

export function isCurrentExternalReplayTurnEpisode(
  sessionId: string,
  episode: ExternalReplayTurnEpisode
): boolean {
  return replayEpisodes.get(sessionId)?.id === episode.id;
}

export function deactivateExternalReplayTurnState(sessionId: string): void {
  replayEpisodes.delete(sessionId);
  getInstrumentedStore().set(
    externalReplayTurnSummariesAtomFamily(sessionId),
    []
  );
}

function eventPreview(event: SessionEvent | undefined): string {
  if (!event) return "";
  if (event.displayText.trim()) return event.displayText.trim();
  const result = event.result as Record<string, unknown>;
  const direct = result.content ?? result.message ?? result.text;
  if (typeof direct === "string") return direct.trim();
  if (direct && typeof direct === "object") {
    const content = (direct as Record<string, unknown>).content;
    if (typeof content === "string") return content.trim();
  }
  return "";
}

function summaryFromHeader(
  window: ExternalReplayWindow,
  header: ExternalReplayWindow["turnHeaders"][number],
  nextTurnId: string | null
): ExternalReplayTurnSummary {
  const userEvent =
    window.events.find((event) => event.id === header.turnId) ??
    window.events.find((event) => event.source === "user");
  const startedMs = Date.parse(header.startedAt);
  const endedMs = header.endedAt ? Date.parse(header.endedAt) : Number.NaN;
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(endedMs)
      ? Math.max(0, endedMs - startedMs)
      : null;
  return {
    turnId: header.turnId,
    nextTurnId,
    turnIndex: header.turnIndex,
    startedAt: header.startedAt,
    endedAt: header.endedAt,
    durationMs,
    userPreview: eventPreview(userEvent),
    eventCount: header.eventCount,
    bodyEventCount: Math.max(0, header.eventCount - 1),
  };
}

function placeholderSummary(
  turnIndex: number,
  totalTurnCount: number
): ExternalReplayTurnSummary {
  return {
    turnId: externalReplayPlaceholderId(turnIndex),
    nextTurnId:
      turnIndex + 1 < totalTurnCount
        ? externalReplayPlaceholderId(turnIndex + 1)
        : null,
    turnIndex,
    startedAt: "",
    endedAt: null,
    durationMs: null,
    userPreview: "",
    // The exact size is unknown until Rust reads this turn. Keeping this
    // non-zero makes selecting the virtual page trigger the bounded loader.
    eventCount: 1,
    bodyEventCount: 1,
  };
}

function parseArrayIndex(
  property: string | symbol,
  length: number
): number | null {
  if (typeof property !== "string" || !/^(0|[1-9]\d*)$/.test(property)) {
    return null;
  }
  const index = Number(property);
  return Number.isSafeInteger(index) && index >= 0 && index < length
    ? index
    : null;
}

/**
 * A logical array with `totalTurnCount` entries that allocates objects only
 * for headers already returned by Rust. Direct indexed reads synthesize a
 * placeholder; array iteration still visits only the loaded sparse entries.
 */
function createVirtualSummaryArray(
  totalTurnCount: number,
  loadedInput: ReadonlyMap<number, ExternalReplayTurnSummary>
): ExternalReplayTurnSummary[] {
  const loaded = new Map<number, ExternalReplayTurnSummary>();
  for (const [turnIndex, summary] of loadedInput) {
    if (turnIndex < 0 || turnIndex >= totalTurnCount) continue;
    loaded.set(turnIndex, summary);
  }
  for (const [turnIndex, summary] of loaded) {
    loaded.set(turnIndex, {
      ...summary,
      nextTurnId:
        loaded.get(turnIndex + 1)?.turnId ??
        (turnIndex + 1 < totalTurnCount
          ? externalReplayPlaceholderId(turnIndex + 1)
          : null),
    });
  }

  const target: ExternalReplayTurnSummary[] = [];
  target.length = totalTurnCount;
  for (const [turnIndex, summary] of loaded) target[turnIndex] = summary;

  const virtual = new Proxy(target, {
    get(array, property, receiver) {
      const index = parseArrayIndex(property, totalTurnCount);
      if (index !== null && array[index] === undefined) {
        return placeholderSummary(index, totalTurnCount);
      }
      return Reflect.get(array, property, receiver);
    },
  });
  loadedSummariesByArray.set(virtual, loaded);
  return virtual;
}

function touchLoadedSummary(
  loaded: Map<number, ExternalReplayTurnSummary>,
  turnIndex: number,
  summary: ExternalReplayTurnSummary
): void {
  // Map iteration order is our tiny LRU. Updating an existing entry does not
  // move it, so delete before set.
  loaded.delete(turnIndex);
  loaded.set(turnIndex, summary);
}

function trimLoadedSummaries(
  loaded: Map<number, ExternalReplayTurnSummary>,
  pinned: ReadonlySet<number>
): void {
  if (loaded.size <= MAX_LOADED_EXTERNAL_REPLAY_TURN_SUMMARIES) return;
  for (const turnIndex of loaded.keys()) {
    if (loaded.size <= MAX_LOADED_EXTERNAL_REPLAY_TURN_SUMMARIES) break;
    if (!pinned.has(turnIndex)) loaded.delete(turnIndex);
  }
  // The protocol currently caps one page at 10 headers, below this limit.
  // Keep the memory invariant fail-closed if a future backend violates that
  // contract: the newest map entries win.
  for (const turnIndex of loaded.keys()) {
    if (loaded.size <= MAX_LOADED_EXTERNAL_REPLAY_TURN_SUMMARIES) break;
    loaded.delete(turnIndex);
  }
}

export function buildExternalReplayTurnSummaries(
  window: ExternalReplayWindow
): ExternalReplayTurnSummary[] {
  const loaded = new Map<number, ExternalReplayTurnSummary>();
  for (const header of window.turnHeaders) {
    touchLoadedSummary(
      loaded,
      header.turnIndex,
      summaryFromHeader(window, header, null)
    );
  }
  trimLoadedSummaries(loaded, new Set(loaded.keys()));
  const summaries = createVirtualSummaryArray(window.totalTurnCount, loaded);
  summaryGenerationsByArray.set(summaries, window.cursor.generation);
  return summaries;
}

export function mergeExternalReplayTurnWindow(
  sessionId: string,
  window: ExternalReplayWindow
): void {
  const episode = replayEpisodes.get(sessionId);
  if (episode) episode.generation = window.cursor.generation;
  else startExternalReplayTurnEpisode(sessionId, window.cursor.generation);
  const store = getInstrumentedStore();
  const atom = externalReplayTurnSummariesAtomFamily(sessionId);
  store.set(atom, (current) => {
    const currentGeneration = summaryGenerationsByArray.get(current);
    const generationChanged =
      currentGeneration !== undefined &&
      currentGeneration !== window.cursor.generation;
    if (generationChanged || current.length === 0) {
      return buildExternalReplayTurnSummaries(window);
    }
    const loaded = new Map<number, ExternalReplayTurnSummary>(
      loadedSummariesByArray.get(current) ?? []
    );
    // Accept a dense array left in memory by an older renderer build. forEach
    // skips virtual holes, so this stays proportional to loaded headers.
    current.forEach((summary, turnIndex) => {
      if (!summary.turnId.startsWith(EXTERNAL_REPLAY_TURN_PLACEHOLDER_PREFIX)) {
        if (!loaded.has(turnIndex)) loaded.set(turnIndex, summary);
      }
    });
    const pinned = new Set<number>();
    for (const header of window.turnHeaders) {
      touchLoadedSummary(
        loaded,
        header.turnIndex,
        summaryFromHeader(window, header, null)
      );
      for (const nearby of [header.turnIndex - 1, header.turnIndex + 1]) {
        if (loaded.has(nearby)) pinned.add(nearby);
      }
      pinned.add(header.turnIndex);
    }
    trimLoadedSummaries(loaded, pinned);
    const summaries = createVirtualSummaryArray(window.totalTurnCount, loaded);
    summaryGenerationsByArray.set(summaries, window.cursor.generation);
    return summaries;
  });
}
