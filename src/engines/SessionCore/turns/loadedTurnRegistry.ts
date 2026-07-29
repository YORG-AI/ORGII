import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { createLogger } from "@src/hooks/logger";
import {
  isCodexAppSession,
  isCursorIdeSession,
} from "@src/util/session/sessionDispatch";

import {
  MAX_LOADED_CODEX_HISTORICAL_TURN_BODIES,
  MAX_LOADED_HISTORICAL_TURN_BODIES,
} from "./turnWindowConfig";

const log = createLogger("LoadedTurnRegistry");

const loadedTurnsBySession = new Map<string, Map<string, number>>();
const pendingLoads = new Map<string, Promise<void>>();
const registryGenerationBySession = new Map<string, number>();
let nextRegistryGeneration = 1;

function loadKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

function getSessionLoadedTurns(sessionId: string): Map<string, number> {
  const existing = loadedTurnsBySession.get(sessionId);
  if (existing) return existing;
  const created = new Map<string, number>();
  loadedTurnsBySession.set(sessionId, created);
  return created;
}

export function captureLoadedTurnRegistryGeneration(sessionId: string): number {
  const existing = registryGenerationBySession.get(sessionId);
  if (existing !== undefined) return existing;
  const generation = nextRegistryGeneration++;
  registryGenerationBySession.set(sessionId, generation);
  return generation;
}

export function getPendingTurnLoad(
  sessionId: string,
  turnId: string
): Promise<void> | null {
  return pendingLoads.get(loadKey(sessionId, turnId)) ?? null;
}

export function trackPendingTurnLoad(
  sessionId: string,
  turnId: string,
  load: Promise<void>
): Promise<void> {
  const key = loadKey(sessionId, turnId);
  pendingLoads.set(key, load);
  // `load` itself is returned to the caller below, so its rejection is
  // theirs to handle. This `.finally` spins off a *separate* promise chain
  // purely for bookkeeping (evicting the pending-load entry); nothing else
  // observes it, so a rejection here becomes its own unhandled-rejection
  // event distinct from the caller's. Swallow it with `.catch` once the
  // bookkeeping has run — the caller's `load` promise still rejects normally.
  void load
    .finally(() => {
      if (pendingLoads.get(key) === load) {
        pendingLoads.delete(key);
      }
    })
    .catch((error: unknown) => {
      log.warn(
        `Pending turn load bookkeeping observed a rejection for ${key}:`,
        error
      );
    });
  return load;
}

export function markTurnBodyLoaded(
  sessionId: string,
  turnId: string,
  generation: number
): void {
  if (registryGenerationBySession.get(sessionId) !== generation) return;
  getSessionLoadedTurns(sessionId).set(turnId, Date.now());
}

/**
 * Whether `turnId`'s body is currently resident for `sessionId` per this
 * registry — i.e. it was loaded and hasn't since been evicted by
 * `pruneLoadedTurnBodies`. Lets callers (e.g. `UnloadedTurnBubble`) key a
 * retry decision on the actual eviction signal instead of inferring it from
 * "is the placeholder's own bubble still mounted", which also goes true
 * when a *different* bug (a stale placeholder entry surviving in the
 * consuming surface's own projection) keeps the bubble mounted even though
 * the body loaded fine.
 */
export function isTurnBodyLoaded(sessionId: string, turnId: string): boolean {
  return loadedTurnsBySession.get(sessionId)?.has(turnId) ?? false;
}

export async function pruneLoadedTurnBodies(
  sessionId: string,
  protectedTurnIds: Iterable<string>
): Promise<void> {
  if (isCursorIdeSession(sessionId)) return;

  const loadedTurns = loadedTurnsBySession.get(sessionId);
  const maxLoadedHistoricalTurns = isCodexAppSession(sessionId)
    ? MAX_LOADED_CODEX_HISTORICAL_TURN_BODIES
    : MAX_LOADED_HISTORICAL_TURN_BODIES;
  if (!loadedTurns || loadedTurns.size <= maxLoadedHistoricalTurns) {
    return;
  }

  const protectedSet = new Set(protectedTurnIds);
  const unloadCandidates = [...loadedTurns.entries()]
    .filter(([turnId]) => !protectedSet.has(turnId))
    .sort((left, right) => left[1] - right[1]);

  while (
    loadedTurns.size > maxLoadedHistoricalTurns &&
    unloadCandidates.length > 0
  ) {
    const candidate = unloadCandidates.shift();
    if (!candidate) break;
    const [turnId] = candidate;
    loadedTurns.delete(turnId);
    try {
      await eventStoreProxy.unloadTurnBody(sessionId, turnId);
    } catch (error) {
      // The registry can legitimately hold ids the backing store no longer
      // recognizes (windowed replace reloads swap the snapshot, imported
      // turn ids shift across reloads). The registry entry is already
      // deleted above regardless of outcome — that's the goal state this
      // function exists to converge on — so one failed unload must never
      // abort the loop or reject this caller.
      log.warn(`Failed to unload turn body ${turnId} for ${sessionId}:`, error);
    }
  }
}

export function clearLoadedTurnRegistry(sessionId: string): void {
  loadedTurnsBySession.delete(sessionId);
  registryGenerationBySession.delete(sessionId);
  for (const key of pendingLoads.keys()) {
    if (key.startsWith(`${sessionId}:`)) {
      pendingLoads.delete(key);
    }
  }
}

function estimateStringBytes(value: string): number {
  return value.length * 2;
}

export function getLoadedTurnRegistryStats(): {
  sessions: number;
  loadedTurns: number;
  pendingLoads: number;
  bytes: number;
} {
  let loadedTurns = 0;
  let bytes = 0;
  for (const [sessionId, turns] of loadedTurnsBySession.entries()) {
    bytes += estimateStringBytes(sessionId);
    loadedTurns += turns.size;
    for (const turnId of turns.keys()) {
      bytes += estimateStringBytes(turnId);
    }
  }
  return {
    sessions: loadedTurnsBySession.size,
    loadedTurns,
    pendingLoads: pendingLoads.size,
    bytes,
  };
}
