/**
 * Resize Feature - Main Export
 *
 * Unified resize system for IDE-level panel management.
 *
 * Core principles:
 * 1. Resize process = DOM only (no React render during mousemove)
 * 2. Ghost layer shows preview, content stays static
 * 3. State commits only on mouseup
 * 4. All resize operations use this unified system
 *
 * Quick Start:
 * ```tsx
 * // 1. Wrap app with provider
 * import { ResizeProvider } from "@src/scaffold/Resize";
 *
 * <ResizeProvider>
 *   <App />
 * </ResizeProvider>
 *
 * // 2. Import styles (once, in App.tsx or global styles)
 * import "@src/scaffold/Resize/index.scss";
 *
 * // 3. Use ResizableShell for panels
 * import { LeftPanelShell } from "@src/scaffold/Resize";
 *
 * <LeftPanelShell
 *   size={leftWidth}
 *   min={200}
 *   max={500}
 *   onResizeEnd={setLeftWidth}
 * >
 *   <LeftPanelContent />
 * </LeftPanelShell>
 *
 * // 4. Use SplitGroup for multiple panes
 * import { SplitGroup, Pane } from "@src/scaffold/Resize";
 *
 * <SplitGroup axis="x" sizes={sizes} onSizesChange={setSizes}>
 *   <Pane id="left"><Left /></Pane>
 *   <Pane id="right"><Right /></Pane>
 * </SplitGroup>
 *
 * // 5. Use layout atoms for state
 * import { leftPanelWidthAtom } from "@src/scaffold/Resize";
 * const [width, setWidth] = useAtom(leftPanelWidthAtom);
 * ```
 */

// ============================================
// Context & Provider
// ============================================

export {
  ResizeManagerContext,
  ResizeProvider,
  useResizeManager,
} from "./ResizeManager";
export type { ResizeProviderProps } from "./ResizeManager";

// ============================================
// Hooks
// ============================================

export { useResizeController, useColumnResize } from "./hooks";
export type { UseResizeControllerReturn } from "./hooks";

// ============================================
// Components
// ============================================

export {
  // Ghost Layer
  GhostLayer,
  // Resize Handle
  HorizontalResizeHandle,
  ResizeHandle,
  VerticalResizeHandle,
  // Resizable Shell
  BottomPanelShell,
  LeftPanelShell,
  ResizableShell,
  RightPanelShell,
  TopPanelShell,
  // Split Group
  Pane,
  SplitGroup,
} from "./components";
export type { PaneProps } from "./components";
export { default as ResizableSplitPanel } from "./components/ResizableSplitPanel";

// ============================================
// Store (Jotai Atoms)
// ============================================

export {
  // Main layout atom
  layoutAtom,
  // Panel size atoms
  bottomPanelHeightAtom,
  leftPanelWidthAtom,
  rightPanelWidthAtom,
  // Split atoms
  createSplitAtom,
  editorSplitAtom,
  simulatorSplitAtom,
  // Defaults
  DEFAULT_LAYOUT_STATE,
  DEFAULT_PANEL_SIZES,
  DEFAULT_PANEL_VISIBILITY,
  DEFAULT_SPLIT_SIZES,
  // Reset
  resetLayoutAtom,
  // Visibility
  panelVisibilityAtom,
  toggleBottomPanelAtom,
  toggleLeftPanelAtom,
  toggleRightPanelAtom,
  // Constraints
  getPanelConstraints,
  PANEL_CONSTRAINTS,
} from "./store/layoutAtom";
export type { PanelId } from "./store/layoutAtom";

// ============================================
// Types
// ============================================

export type {
  GhostLayerProps,
  LayoutState,
  PanelSizes,
  ResizableShellProps,
  ResizeAxis,
  ResizeControllerOptions,
  ResizeDirection,
  ResizeHandleIndicatorPlacement,
  ResizeHandleProps,
  ResizeHandleVariant,
  ResizeManagerContextType,
  ResizeSession,
  SplitGroupProps,
  SplitPaneConfig,
  SplitSizes,
} from "./types";
