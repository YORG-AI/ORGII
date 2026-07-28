/**
 * Persist journey narrative state (pins / prunes) in localStorage.
 */

import {
  JOURNEY_STATE_KEY_PREFIX,
  JOURNEY_STATE_VERSION,
  type ProjectJourneyState,
} from "./types";

export function journeyStateKey(projectId: string): string {
  return `${JOURNEY_STATE_KEY_PREFIX}${projectId}`;
}

export function emptyJourneyState(projectId: string): ProjectJourneyState {
  return {
    version: JOURNEY_STATE_VERSION,
    projectId,
    pinnedMainlineNodeIds: [],
    prunedNodeIds: [],
    prunedEdgeIds: [],
    updatedAt: new Date().toISOString(),
  };
}

export function loadJourneyState(
  projectId: string,
  storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null
): ProjectJourneyState {
  if (!storage) return emptyJourneyState(projectId);
  try {
    const raw = storage.getItem(journeyStateKey(projectId));
    if (!raw) return emptyJourneyState(projectId);
    const parsed = JSON.parse(raw) as ProjectJourneyState;
    if (parsed?.version !== JOURNEY_STATE_VERSION || !parsed.projectId) {
      return emptyJourneyState(projectId);
    }
    return {
      version: JOURNEY_STATE_VERSION,
      projectId,
      pinnedMainlineNodeIds: parsed.pinnedMainlineNodeIds ?? [],
      prunedNodeIds: parsed.prunedNodeIds ?? [],
      prunedEdgeIds: parsed.prunedEdgeIds ?? [],
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return emptyJourneyState(projectId);
  }
}

export function saveJourneyState(
  state: ProjectJourneyState,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null
): ProjectJourneyState {
  const next: ProjectJourneyState = {
    ...state,
    version: JOURNEY_STATE_VERSION,
    updatedAt: new Date().toISOString(),
  };
  if (storage) {
    storage.setItem(journeyStateKey(state.projectId), JSON.stringify(next));
  }
  return next;
}

export function togglePinNode(
  state: ProjectJourneyState,
  nodeId: string
): ProjectJourneyState {
  const set = new Set(state.pinnedMainlineNodeIds);
  if (set.has(nodeId)) set.delete(nodeId);
  else set.add(nodeId);
  return saveJourneyState({
    ...state,
    pinnedMainlineNodeIds: [...set],
  });
}

export function togglePruneNode(
  state: ProjectJourneyState,
  nodeId: string
): ProjectJourneyState {
  const set = new Set(state.prunedNodeIds);
  if (set.has(nodeId)) set.delete(nodeId);
  else set.add(nodeId);
  return saveJourneyState({
    ...state,
    prunedNodeIds: [...set],
  });
}
