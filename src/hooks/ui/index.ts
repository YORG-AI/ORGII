// UI Hooks - Main Export
export * from "./tabs";
export * from "./sidebar";
export * from "./layout";
export * from "./effects";

// Copy check (icon swap Copy → Check on successful copy)
export { useCopyCheck } from "./useCopyCheck";

// Refresh spin (one-shot spin animation for refresh icons)
export { useRefreshSpin } from "./useRefreshSpin";

// Resize handle for panel resizing (pixel-based)
export { useResizeHandle } from "./useResizeHandle";

// Ratio-based resize for split panes
export { useRatioResize } from "./useRatioResize";

// Context menu for resize handles (default width / minimize)
export { useResizeContextMenu } from "./useResizeContextMenu";

// Draft-mode number input (free typing, validate on blur)
export { useDraftNumber } from "./useDraftNumber";

// Undoable state (Ctrl+Z / Ctrl+Shift+Z)
export { useUndoableState, useUndoStackWithRestore } from "./useUndoableState";

// Safe hover (unmount-safe, no stuck hover states)
export { useSafeHover } from "./useSafeHover";

// Collapsible toggle state (open/closed sections)
export { useCollapsible } from "./useCollapsible";
