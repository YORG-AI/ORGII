export type CanvasViewTab = "canvas" | "source" | "compare";

export interface CanvasInteractionState {
  selectedEventId: string | null;
  compareEventIds: string[];
  activeTab: CanvasViewTab;
  reloadKey: number;
  observedEventCount: number;
  observedEventIdsKey: string;
  observedPreviewEventId: string | null;
}

function eventIdsKey(eventIds: readonly string[]): string {
  return JSON.stringify(eventIds);
}

function preferredEventId(
  eventIds: readonly string[],
  previewEventId: string | null
): string | null {
  if (previewEventId && eventIds.includes(previewEventId)) {
    return previewEventId;
  }
  return eventIds.at(-1) ?? null;
}

export function createCanvasInteractionState(
  eventIds: readonly string[],
  previewEventId: string | null
): CanvasInteractionState {
  const selectedEventId = preferredEventId(eventIds, previewEventId);
  return {
    selectedEventId,
    compareEventIds: [],
    activeTab: "canvas",
    reloadKey: selectedEventId === null ? 0 : 1,
    observedEventCount: eventIds.length,
    observedEventIdsKey: eventIdsKey(eventIds),
    observedPreviewEventId: previewEventId,
  };
}

/**
 * Reconcile external event/preview facts before children commit.
 *
 * Selection priority intentionally matches the previous Effect ordering:
 * a growing event list follows the newest event, then a valid chat preview
 * overrides it. A non-empty shrinking list retains the user's selection until
 * the list is fully cleared.
 *
 * `designEventId`: while design mode is active for the current selection, the
 * preview override is suppressed so an unrelated agent canvas cannot yank the
 * user out of an in-progress design selection.
 */
export function reconcileCanvasInteractionState(
  state: CanvasInteractionState,
  eventIds: readonly string[],
  previewEventId: string | null,
  designEventId: string | null = null
): CanvasInteractionState {
  const nextEventIdsKey = eventIdsKey(eventIds);
  if (
    state.observedEventIdsKey === nextEventIdsKey &&
    state.observedPreviewEventId === previewEventId
  ) {
    return state;
  }

  let selectedEventId = state.selectedEventId;
  let observedEventCount = state.observedEventCount;
  const validEventIds = new Set(eventIds);
  const compareEventIds = state.compareEventIds.filter((eventId) =>
    validEventIds.has(eventId)
  );
  const designLocksSelection =
    designEventId !== null &&
    designEventId === state.selectedEventId &&
    validEventIds.has(designEventId);

  if (eventIds.length === 0) {
    selectedEventId = null;
    observedEventCount = 0;
  } else if (eventIds.length > observedEventCount) {
    selectedEventId = eventIds[eventIds.length - 1];
    observedEventCount = eventIds.length;
  } else if (selectedEventId && !validEventIds.has(selectedEventId)) {
    selectedEventId = preferredEventId(eventIds, previewEventId);
  }

  if (
    previewEventId &&
    eventIds.includes(previewEventId) &&
    !designLocksSelection
  ) {
    selectedEventId = previewEventId;
  }

  const selectionChanged = selectedEventId !== state.selectedEventId;
  const comparisonChanged =
    compareEventIds.length !== state.compareEventIds.length;
  return {
    ...state,
    selectedEventId,
    compareEventIds,
    activeTab:
      selectionChanged || (comparisonChanged && compareEventIds.length !== 2)
        ? "canvas"
        : state.activeTab,
    reloadKey: selectionChanged ? state.reloadKey + 1 : state.reloadKey,
    observedEventCount,
    observedEventIdsKey: nextEventIdsKey,
    observedPreviewEventId: previewEventId,
  };
}

export function selectCanvasEvent(
  state: CanvasInteractionState,
  eventId: string
): CanvasInteractionState {
  if (eventId === state.selectedEventId) return state;
  return {
    ...state,
    selectedEventId: eventId,
    activeTab: "canvas",
    reloadKey: state.reloadKey + 1,
  };
}

export function toggleCanvasComparison(
  state: CanvasInteractionState,
  eventId: string
): CanvasInteractionState {
  const compareEventIds = state.compareEventIds.includes(eventId)
    ? state.compareEventIds.filter((id) => id !== eventId)
    : state.compareEventIds.length >= 2
      ? [state.compareEventIds[1], eventId]
      : [...state.compareEventIds, eventId];

  const activeTab =
    compareEventIds.length === 2
      ? "compare"
      : state.activeTab === "compare"
        ? "canvas"
        : state.activeTab;

  return { ...state, compareEventIds, activeTab };
}

export function setCanvasViewTab(
  state: CanvasInteractionState,
  activeTab: CanvasViewTab
): CanvasInteractionState {
  return activeTab === state.activeTab ? state : { ...state, activeTab };
}

export function reloadCanvas(
  state: CanvasInteractionState
): CanvasInteractionState {
  return { ...state, reloadKey: state.reloadKey + 1 };
}
