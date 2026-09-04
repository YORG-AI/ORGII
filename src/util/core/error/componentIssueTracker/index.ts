/**
 * Component Issue Tracker - Modular entry point
 *
 * This module provides tools for inspecting and reporting issues with UI components.
 * It includes hover tracking, highlight overlays, and payload generation for bug reports.
 */

// Types
export type { ComponentIssuePayload } from "./types";

// State accessors (for external use)
export {
  isInspectModeEnabled,
  isHighlightLocked,
  getCurrentLevel,
  areLabelsHidden,
  getLastHoveredElement,
} from "./state";

// Hover tracking
export { ensureHoverTracking } from "./hoverTracking";

// Inspect mode controls
export {
  toggleInspectMode,
  enableInspectMode,
  disableInspectMode,
  moveUpLevel,
  moveDownLevel,
  toggleLabelsHidden,
  hideLabels,
} from "./inspectMode";

// Element navigation
export {
  getEffectiveElement,
  setLastHoveredElement,
  getPreviousElement,
  getNextElement,
} from "./elementNavigation";

// Payload building
export { buildIssuePayload } from "./payloadBuilder";

// Preview generation
export { generatePreviewHtml } from "./previewGenerator";
