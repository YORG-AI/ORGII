/**
 * Module-level state for component issue tracker.
 * All state is managed here with getter/setter functions to avoid circular imports.
 */

// Hover tracking state
let hoverTrackingInitialized = false;
let lastHoveredElement: Element | null = null;

// Inspect mode state
let inspectModeEnabled = false;
let highlightLocked = false;
let currentLevel = 0; // 0 = hovered element, 1 = parent, 2 = grandparent, etc.
let labelsHidden = false;
let userNavigatedLevel = false;

// Overlay elements
let highlightOverlay: HTMLDivElement | null = null;
let labelOverlay: HTMLDivElement | null = null;
let parentHighlightOverlay: HTMLDivElement | null = null;
let parentLabelOverlay: HTMLDivElement | null = null;

// --- Hover Tracking State ---
export const isHoverTrackingInitialized = () => hoverTrackingInitialized;
export const setHoverTrackingInitialized = (value: boolean) => {
  hoverTrackingInitialized = value;
};

export const getLastHoveredElement = () => lastHoveredElement;
export const setLastHoveredElement = (element: Element | null) => {
  lastHoveredElement = element;
};

// --- Inspect Mode State ---
export const isInspectModeEnabled = () => inspectModeEnabled;
export const setInspectModeEnabled = (value: boolean) => {
  inspectModeEnabled = value;
};

export const isHighlightLocked = () => highlightLocked;
export const setHighlightLocked = (value: boolean) => {
  highlightLocked = value;
};

export const getCurrentLevel = () => currentLevel;
export const setCurrentLevel = (value: number) => {
  currentLevel = value;
};
export const incrementCurrentLevel = () => {
  currentLevel++;
};
export const decrementCurrentLevel = () => {
  currentLevel--;
};

export const areLabelsHidden = () => labelsHidden;
export const setLabelsHidden = (value: boolean) => {
  labelsHidden = value;
};

export const hasUserNavigatedLevel = () => userNavigatedLevel;
export const setUserNavigatedLevel = (value: boolean) => {
  userNavigatedLevel = value;
};

// --- Overlay Elements ---
export const getHighlightOverlay = () => highlightOverlay;
export const setHighlightOverlay = (element: HTMLDivElement | null) => {
  highlightOverlay = element;
};

export const getLabelOverlay = () => labelOverlay;
export const setLabelOverlay = (element: HTMLDivElement | null) => {
  labelOverlay = element;
};

export const getParentHighlightOverlay = () => parentHighlightOverlay;
export const setParentHighlightOverlay = (element: HTMLDivElement | null) => {
  parentHighlightOverlay = element;
};

export const getParentLabelOverlay = () => parentLabelOverlay;
export const setParentLabelOverlay = (element: HTMLDivElement | null) => {
  parentLabelOverlay = element;
};

// --- Reset Functions ---
export const resetInspectState = () => {
  highlightLocked = false;
  currentLevel = 0;
  labelsHidden = false;
  userNavigatedLevel = false;
};
