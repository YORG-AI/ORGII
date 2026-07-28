export type ExploreSelectionChoice = "file" | "search";

export interface EventScopedExploreSelection {
  eventId: string;
  choice: ExploreSelectionChoice;
}

/**
 * Keep an explicit sidebar choice authoritative for the current replay event.
 * Once the replay cursor moves, fall back to the new event's natural panel.
 */
export function resolveExploreSelection(
  selection: EventScopedExploreSelection | null,
  currentEventId: string,
  currentEventIsExplore: boolean
): ExploreSelectionChoice {
  if (selection?.eventId === currentEventId) return selection.choice;
  return currentEventIsExplore ? "search" : "file";
}
