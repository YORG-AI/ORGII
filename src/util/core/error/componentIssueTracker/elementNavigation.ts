/**
 * Element navigation utilities for DOM traversal.
 */
import { shouldIgnoreElement } from "./hoverTracking";
import { getElementAtLevel, updateHighlight } from "./overlay";
import {
  getCurrentLevel,
  getLastHoveredElement as getLastHoveredElementState,
  isInspectModeEnabled,
  setCurrentLevel,
  setLastHoveredElement as setLastHoveredElementState,
} from "./state";

// Get the currently selected element (accounting for level)

/**
 * Get the currently effective element (accounting for level navigation).
 * Use this when you need to get the element that the user has "selected" via Tab navigation.
 */
export const getEffectiveElement = () =>
  getElementAtLevel(getLastHoveredElementState(), getCurrentLevel());

export const setLastHoveredElement = (element: Element | null) => {
  setLastHoveredElementState(element);
  setCurrentLevel(0); // Reset level when manually setting element
  if (isInspectModeEnabled() && element) {
    updateHighlight(element);
  }
};

// Navigate to previous sibling (or parent's previous sibling if no previous sibling)
export const getPreviousElement = (element: Element | null): Element | null => {
  if (!element) return null;

  // Try previous sibling
  const prevSibling = element.previousElementSibling;
  if (prevSibling && !shouldIgnoreElement(prevSibling)) {
    // Get the deepest last child of the previous sibling
    let deepest: Element = prevSibling;
    while (
      deepest.lastElementChild &&
      !shouldIgnoreElement(deepest.lastElementChild)
    ) {
      deepest = deepest.lastElementChild;
    }
    return deepest;
  }

  // No previous sibling, go to parent
  const parent = element.parentElement;
  if (
    parent &&
    parent !== document.body &&
    parent !== document.documentElement
  ) {
    return parent;
  }

  return null;
};

// Navigate to next sibling (or parent's next sibling if no next sibling)
export const getNextElement = (element: Element | null): Element | null => {
  if (!element) return null;

  // Try first child
  const firstChild = element.firstElementChild;
  if (firstChild && !shouldIgnoreElement(firstChild)) {
    return firstChild;
  }

  // Try next sibling
  let current: Element | null = element;
  while (current && current !== document.body) {
    const nextSibling = current.nextElementSibling;
    if (nextSibling && !shouldIgnoreElement(nextSibling)) {
      return nextSibling;
    }
    current = current.parentElement;
  }

  return null;
};
