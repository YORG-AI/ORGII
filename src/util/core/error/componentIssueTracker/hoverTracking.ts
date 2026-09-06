/**
 * Hover event tracking for element inspection.
 */
import { updateHighlight } from "./overlay";
import {
  getLastHoveredElement,
  hasUserNavigatedLevel,
  isHighlightLocked,
  isHoverTrackingInitialized,
  isInspectModeEnabled,
  setCurrentLevel,
  setHoverTrackingInitialized,
  setLastHoveredElement as setLastHoveredElementState,
} from "./state";

const HOVER_EVENTS: Array<keyof DocumentEventMap> = [
  "mousemove",
  "mouseover",
  "mouseenter",
];

// Elements to ignore when tracking hover (inspector UI and modals)
export const shouldIgnoreElement = (
  element: Element | EventTarget | null
): boolean => {
  // Check if element is actually an Element with the necessary methods
  if (!element || !(element instanceof Element)) {
    return true;
  }

  // Skip our own overlay elements
  if (
    element.id === "orgii-inspect-highlight" ||
    element.id === "orgii-inspect-label" ||
    element.id === "orgii-inspect-parent-highlight" ||
    element.id === "orgii-inspect-parent-label"
  ) {
    return true;
  }

  // Skip ComponentIssueModal elements
  if (
    element.closest(".component-issue-modal-overlay") ||
    element.closest(".component-issue-modal-container")
  ) {
    return true;
  }

  return false;
};

const handleHoverEvent = (event: Event) => {
  // Don't update highlight if locked
  if (isHighlightLocked()) return;

  // Don't update if user has manually navigated using Tab
  if (hasUserNavigatedLevel()) return;

  const target = event.target;

  // Ensure target is an Element before proceeding
  if (target && target instanceof Element && !shouldIgnoreElement(target)) {
    const lastHoveredElement = getLastHoveredElement();
    // Reset level when hovering a different element
    if (lastHoveredElement !== target) {
      setCurrentLevel(0);
    }
    setLastHoveredElementState(target);

    if (isInspectModeEnabled()) {
      updateHighlight(target);
    }
  }
};

export const ensureHoverTracking = () => {
  if (isHoverTrackingInitialized() || typeof window === "undefined") return;

  HOVER_EVENTS.forEach((eventName) => {
    document.addEventListener(eventName, handleHoverEvent, true);
  });

  setHoverTrackingInitialized(true);
};
