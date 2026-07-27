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
interface ExternalReplayWindowBoundary {
  generation: string;
  earliestSequence: number | null;
  hasOlder: boolean;
}
const replayWindowBoundaries = new Map<string, ExternalReplayWindowBoundary>();
interface ExternalReplayTurnSliceBoundaries {
  generation: string;
  earliestSequenceByTurn: Map<number, number>;
}
const replayTurnSliceBoundaries = new Map<
  string,
  ExternalReplayTurnSliceBoundaries
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

/** Current provider generation for one already-open replay session. */
export function getExternalReplayTurnGeneration(
  sessionId: string
): string | null {
  return replayEpisodes.get(sessionId)?.generation ?? null;
}

export function isCurrentExternalReplayTurnEpisode(
  sessionId: string,
  episode: ExternalReplayTurnEpisode
): boolean {
  return replayEpisodes.get(sessionId)?.id === episode.id;
}

export function deactivateExternalReplayTurnState(sessionId: string): void {
  replayEpisodes.delete(sessionId);
  replayWindowBoundaries.delete(sessionId);
  replayTurnSliceBoundaries.delete(sessionId);
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

function eventTimestamp(event: SessionEvent): number | null {
  const timestamp = Date.parse(event.createdAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Correlate source-neutral replay turn headers with the normalized user rows
 * that own rendered chat groups. The replay protocol deliberately keeps the
 * provider turn locator independent from SessionEvent ids.
 */
function renderedUserEventsByTurnIndex(
  window: ExternalReplayWindow
): ReadonlyMap<number, SessionEvent> {
  const userEvents = window.events.filter((event) => event.source === "user");
  const claimedUserEventIds = new Set<string>();
  const result = new Map<number, SessionEvent>();
  const headers = [...window.turnHeaders].sort(
    (left, right) => left.turnIndex - right.turnIndex
  );

  for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
    const header = headers[headerIndex];
    const exact = userEvents.find(
      (event) =>
        event.id === header.turnId && !claimedUserEventIds.has(event.id)
    );
    if (exact) {
      result.set(header.turnIndex, exact);
      claimedUserEventIds.add(exact.id);
      continue;
    }

    const startedAt = Date.parse(header.startedAt);
    const nextStartedAt = headers[headerIndex + 1]
      ? Date.parse(headers[headerIndex + 1].startedAt)
      : Number.NaN;
    const endedAt = header.endedAt ? Date.parse(header.endedAt) : Number.NaN;
    const upperBound = Number.isFinite(nextStartedAt) ? nextStartedAt : endedAt;
    const timestampMatch = userEvents.find((event) => {
      if (claimedUserEventIds.has(event.id)) return false;
      const timestamp = eventTimestamp(event);
      if (timestamp === null || !Number.isFinite(startedAt)) return false;
      return (
        timestamp >= startedAt &&
        (!Number.isFinite(upperBound) || timestamp <= upperBound)
      );
    });
    const orderedFallback =
      headers.length === userEvents.length
        ? userEvents[headerIndex]
        : headers.length === 1
          ? userEvents[0]
          : undefined;
    const userEvent =
      timestampMatch ??
      (orderedFallback && !claimedUserEventIds.has(orderedFallback.id)
        ? orderedFallback
        : undefined);
    if (!userEvent) continue;
    result.set(header.turnIndex, userEvent);
    claimedUserEventIds.add(userEvent.id);
  }

  return result;
}

function summaryFromHeader(
  header: ExternalReplayWindow["turnHeaders"][number],
  renderedUserEvent: SessionEvent | undefined,
  nextTurnId: string | null
): ExternalReplayTurnSummary {
  const startedMs = Date.parse(header.startedAt);
  const endedMs = header.endedAt ? Date.parse(header.endedAt) : Number.NaN;
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(endedMs)
      ? Math.max(0, endedMs - startedMs)
      : null;
  return {
    turnId: header.turnId,
    renderedUserEventId: renderedUserEvent?.id ?? null,
    nextTurnId,
    turnIndex: header.turnIndex,
    startedAt: header.startedAt,
    endedAt: header.endedAt,
    durationMs,
    userPreview: eventPreview(renderedUserEvent),
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
    renderedUserEventId: null,
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
  const renderedUserEvents = renderedUserEventsByTurnIndex(window);
  for (const header of window.turnHeaders) {
    touchLoadedSummary(
      loaded,
      header.turnIndex,
      summaryFromHeader(header, renderedUserEvents.get(header.turnIndex), null)
    );
  }
  trimLoadedSummaries(loaded, new Set(loaded.keys()));
  const summaries = createVirtualSummaryArray(window.totalTurnCount, loaded);
  summaryGenerationsByArray.set(summaries, window.cursor.generation);
  return summaries;
}

/**
 * Recover the provider turn owning each resident replay event without adding
 * renderer-only fields to the public SessionEvent wire shape.
 *
 * Bounded replay intentionally keeps sparse windows in EventStore. A window
 * can therefore begin in the middle of a turn, without that turn's user row.
 * The compact headers are the authoritative boundaries: match exact rendered
 * user ids first, then assign the remaining chronologically ordered events to
 * the latest header whose start time has been reached.
 */
export function buildExternalReplayTurnIndexByEventId(
  events: readonly SessionEvent[],
  summaries: ExternalReplayTurnSummary[]
): ReadonlyMap<string, number> {
  const loaded = new Map<number, ExternalReplayTurnSummary>();
  summaries.forEach((summary, turnIndex) => {
    if (!summary?.startedAt) return;
    loaded.set(turnIndex, summary);
  });
  if (loaded.size === 0 || events.length === 0) return new Map();

  const ranges = [...loaded.values()]
    .map((summary) => ({
      renderedUserEventId: summary.renderedUserEventId,
      startedAtMs: Date.parse(summary.startedAt),
      turnIndex: summary.turnIndex,
    }))
    .filter((range) => Number.isFinite(range.startedAtMs))
    .sort(
      (left, right) =>
        left.startedAtMs - right.startedAtMs || left.turnIndex - right.turnIndex
    );
  if (ranges.length === 0) return new Map();

  const rangeIndexByUserEventId = new Map<string, number>();
  ranges.forEach((range, rangeIndex) => {
    if (range.renderedUserEventId) {
      rangeIndexByUserEventId.set(range.renderedUserEventId, rangeIndex);
    }
  });

  const result = new Map<string, number>();
  let currentRangeIndex = -1;
  for (const event of events) {
    const exactRangeIndex = rangeIndexByUserEventId.get(event.id);
    if (exactRangeIndex !== undefined) {
      currentRangeIndex = exactRangeIndex;
    } else {
      const eventTimeMs = Date.parse(event.createdAt);
      if (Number.isFinite(eventTimeMs)) {
        while (
          currentRangeIndex + 1 < ranges.length &&
          ranges[currentRangeIndex + 1].startedAtMs <= eventTimeMs
        ) {
          currentRangeIndex += 1;
        }
      }
    }
    const owner = ranges[currentRangeIndex];
    if (owner) result.set(event.id, owner.turnIndex);
  }
  return result;
}

/**
 * Return the immediately older catalog locator without walking the virtual
 * array. Used by non-paginated history to backfill one bounded turn whenever
 * the user reaches the top of the currently resident window.
 */
export function previousExternalReplayWindowStart(
  sessionId: string
): number | null {
  const boundary = replayWindowBoundaries.get(sessionId);
  return boundary?.hasOlder ? boundary.earliestSequence : null;
}

export function previousExternalReplayTurnSliceStart(
  sessionId: string,
  turnIndex: number
): number | null {
  return (
    replayTurnSliceBoundaries
      .get(sessionId)
      ?.earliestSequenceByTurn.get(turnIndex) ?? null
  );
}

function mergeReplayTurnSliceBoundary(
  sessionId: string,
  window: ExternalReplayWindow
): void {
  let state = replayTurnSliceBoundaries.get(sessionId);
  if (!state || state.generation !== window.cursor.generation) {
    state = {
      generation: window.cursor.generation,
      earliestSequenceByTurn: new Map(),
    };
    replayTurnSliceBoundaries.set(sessionId, state);
  }
  const windowStart = window.windowStartSequence;
  if (windowStart === null) return;
  const owningHeader = window.turnHeaders.find(
    (header) =>
      windowStart >= header.startSequence &&
      (header.endSequence === null || windowStart <= header.endSequence)
  );
  if (!owningHeader) return;

  if (windowStart <= owningHeader.startSequence) {
    state.earliestSequenceByTurn.delete(owningHeader.turnIndex);
    return;
  }
  state.earliestSequenceByTurn.delete(owningHeader.turnIndex);
  state.earliestSequenceByTurn.set(owningHeader.turnIndex, windowStart);
  while (
    state.earliestSequenceByTurn.size >
    MAX_LOADED_EXTERNAL_REPLAY_TURN_SUMMARIES
  ) {
    const oldestTurnIndex = state.earliestSequenceByTurn.keys().next().value;
    if (oldestTurnIndex === undefined) break;
    state.earliestSequenceByTurn.delete(oldestTurnIndex);
  }
}

function mergeReplayWindowBoundary(
  sessionId: string,
  window: ExternalReplayWindow
): void {
  const nextSequence = window.windowStartSequence;
  const current = replayWindowBoundaries.get(sessionId);
  if (!current || current.generation !== window.cursor.generation) {
    replayWindowBoundaries.set(sessionId, {
      generation: window.cursor.generation,
      earliestSequence: nextSequence,
      hasOlder: window.hasOlder,
    });
    return;
  }
  if (nextSequence === null) return;
  if (
    current.earliestSequence === null ||
    nextSequence < current.earliestSequence
  ) {
    current.earliestSequence = nextSequence;
    current.hasOlder = window.hasOlder;
  } else if (nextSequence === current.earliestSequence) {
    current.hasOlder = current.hasOlder && window.hasOlder;
  }
}

export function mergeExternalReplayTurnWindow(
  sessionId: string,
  window: ExternalReplayWindow
): void {
  mergeReplayWindowBoundary(sessionId, window);
  mergeReplayTurnSliceBoundary(sessionId, window);
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
    const renderedUserEvents = renderedUserEventsByTurnIndex(window);
    for (const header of window.turnHeaders) {
      touchLoadedSummary(
        loaded,
        header.turnIndex,
        summaryFromHeader(
          header,
          renderedUserEvents.get(header.turnIndex),
          null
        )
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
