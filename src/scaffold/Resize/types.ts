import type { MouseEvent, ReactNode } from "react";

/**
 * Resize Feature - Type Definitions
 *
 * Core types for the unified resize system.
 * Following IDE-level architecture for 0 React render during resize.
 */

// ============================================
// Resize Axis & Direction
// ============================================

/** Resize axis: x for horizontal, y for vertical */
export type ResizeAxis = "x" | "y";

/** Handle position relative to the resizable element */
type HandlePosition = "start" | "end";

// ============================================
// Resize Session
// ============================================

/** Active resize session data */
export interface ResizeSession {
  /** Unique session ID */
  id: string;
  /** Starting mouse position */
  startPos: number;
  /** Starting size value */
  startSize: number;
  /** Resize axis */
  axis: ResizeAxis;
  /** Timestamp when resize started */
  startTime: number;
}

// ============================================
// Resize Controller Options
// ============================================

export interface ResizeControllerOptions {
  /** Resize axis */
  axis: ResizeAxis;
  /** Minimum size in pixels */
  min: number;
  /** Maximum size in pixels */
  max: number;
  /** Callback when resize completes (only called on end) */
  onCommit: (newSize: number) => void;
  /** Optional callback during resize (for visual feedback only, no state updates) */
  onPreview?: (newSize: number) => void;
  /** Handle position relative to element */
  handlePosition?: HandlePosition;
  /** Whether to invert the delta calculation */
  inverted?: boolean;
}

// ============================================
// Resizable Shell Props
// ============================================

export interface ResizableShellProps {
  /** Content to render inside the shell */
  children: ReactNode;
  /** Current size (controlled) */
  size: number;
  /** Resize axis */
  axis: ResizeAxis;
  /** Minimum size */
  min?: number;
  /** Maximum size */
  max?: number;
  /** Handle position relative to element (affects delta direction) */
  handlePosition?: HandlePosition;
  /** Whether delta is inverted (e.g., right-side panel) */
  inverted?: boolean;
  /** Callback when resize ends */
  onResizeEnd: (newSize: number) => void;
  /** Additional class name */
  className?: string;
  /** Whether to show ghost layer during resize */
  showGhost?: boolean;
}

// ============================================
// Resize Handle Props
// ============================================

/** Visual variant for resize handle default (resting) state */
type ResizeHandleVariant = "transparent" | "border";
type ResizeHandleIndicatorPlacement = "start" | "center" | "end";

export interface ResizeHandleProps {
  /** Resize axis */
  axis: ResizeAxis;
  /** Mouse down handler */
  onMouseDown: (event: MouseEvent) => void;
  /** Whether currently resizing */
  isResizing?: boolean;
  /** Resting-state appearance: "border" (visible 1px line, default) or "transparent" (invisible until hover) */
  variant?: ResizeHandleVariant;
  /** Disable hover/active color feedback (cursor still changes) */
  noHover?: boolean;
  /** Use neutral border color instead of primary-6 for hover/active states */
  noAccent?: boolean;
  /** Right-click context menu handler */
  onContextMenu?: (event: MouseEvent) => void;
  /** Contextual action shown after hovering the handle for one second */
  tooltipLabel?: ReactNode;
  /** Keyboard shortcut displayed beside the contextual tooltip label */
  tooltipShortcut?: string;
  /** Side of the divider into which the thicker center indicator extends */
  indicatorPlacement?: ResizeHandleIndicatorPlacement;
  /** Optional unclipped layout-boundary host for the visual indicator */
  indicatorHost?: HTMLElement | null;
  /** Additional class name */
  className?: string;
}

// ============================================
// Ghost Layer Props
// ============================================

export interface GhostLayerProps {
  /** Resize axis */
  axis: ResizeAxis;
  /** Additional class name */
  className?: string;
}

// ============================================
// Split Group Types
// ============================================

interface SplitPaneConfig {
  /** Unique pane ID */
  id: string;
  /** Minimum size (pixels or percentage based on sizeUnit) */
  min?: number;
  /** Maximum size */
  max?: number;
  /** Initial size */
  initialSize?: number;
  /** Whether this pane can be collapsed */
  collapsible?: boolean;
}

export interface SplitGroupProps {
  /** Resize axis for all splits */
  axis: ResizeAxis;
  /** Child panes */
  children: ReactNode;
  /** Size array (corresponds to children) */
  sizes: number[];
  /** Size unit: pixels or flex ratio */
  sizeUnit?: "pixels" | "flex";
  /** Callback when sizes change */
  onSizesChange: (sizes: number[]) => void;
  /** Pane configurations */
  panes?: SplitPaneConfig[];
  /** Additional class name */
  className?: string;
}

// ============================================
// Layout State (for Jotai store)
// ============================================

export interface PanelSizes {
  leftPanel: number;
  rightPanel: number;
  bottomPanel: number;
}

export interface SplitSizes {
  [key: string]: number;
}

export interface LayoutState {
  /** Panel sizes in pixels */
  panels: PanelSizes;
  /** Split positions (percentage or flex) */
  splits: SplitSizes;
}

// ============================================
// Resize Manager Context
// ============================================

export interface ResizeManagerContextType {
  /** Whether any resize is currently active */
  isResizing: boolean;
  /** Current active session */
  activeSession: ResizeSession | null;
  /** Lock resize (prevent other resizes) */
  lock: (session: ResizeSession) => void;
  /** Unlock resize */
  unlock: () => void;
  /** Register a resizable element */
  register: (id: string) => void;
  /** Unregister a resizable element */
  unregister: (id: string) => void;
}
