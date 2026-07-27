import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";

import { MAX_LOADED_HISTORICAL_TURN_BODIES } from "./turnWindowConfig";

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
  void load.finally(() => {
    if (pendingLoads.get(key) === load) {
      pendingLoads.delete(key);
    }
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

export async function pruneLoadedTurnBodies(
  sessionId: string,
  protectedTurnIds: Iterable<string>
): Promise<void> {
  if (isCursorIdeSession(sessionId)) return;

  const loadedTurns = loadedTurnsBySession.get(sessionId);
  if (!loadedTurns || loadedTurns.size <= MAX_LOADED_HISTORICAL_TURN_BODIES) {
    return;
  }

  const protectedSet = new Set(protectedTurnIds);
  const unloadCandidates = [...loadedTurns.entries()]
    .filter(([turnId]) => !protectedSet.has(turnId))
    .sort((left, right) => left[1] - right[1]);

  while (
    loadedTurns.size > MAX_LOADED_HISTORICAL_TURN_BODIES &&
    unloadCandidates.length > 0
  ) {
    const candidate = unloadCandidates.shift();
    if (!candidate) break;
    const [turnId] = candidate;
    loadedTurns.delete(turnId);
    await eventStoreProxy.unloadTurnBody(sessionId, turnId);
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
