/**
 * StatusBar Components
 *
 * Unified status bar components for Workstation apps.
 *
 * Structure:
 * - base.tsx: BaseStatusBar and primitive components (Button, Segment, Text, Divider)
 * - EditorStatusBar.tsx: For CodeEditor
 * - DatabaseStatusBar.tsx: For Database Manager
 * - BrowserStatusBar.tsx: For Browser
 * - ProjectStatusBar.tsx: For Project Manager
 */

// Layout tokens (Tailwind class strings for bar height, clusters, segments)
export { STATUS_BAR_TOKENS } from "./statusBarTokens";

// Base components
export {
  BaseStatusBar,
  StatusBarButton,
  StatusBarDivider,
  StatusBarSegment,
  StatusBarText,
} from "./StatusBarBase";
export type {
  BaseStatusBarProps,
  StatusBarButtonProps,
  StatusBarDividerProps,
  StatusBarSegmentProps,
  StatusBarTextProps,
} from "./StatusBarBase";

// Editor status bar (CodeEditor)
export { EditorStatusBar } from "./EditorStatusBar";
export type {
  CommitInfo,
  CursorPosition,
  EditorStatusBarProps,
  LspStatus,
} from "./EditorStatusBar";

export { PortsStatusMenu } from "./PortsStatusMenu";
export { WorkspacePortScanner } from "./WorkspacePortScanner";

// Database status bar (Database Manager)

// Browser status bar (Browser)
export { default as BrowserStatusBar } from "./BrowserStatusBar";
export type { BrowserStatusBarProps } from "./BrowserStatusBar";

// Project status bar (Project Manager)
export { default as ProjectStatusBar } from "./ProjectStatusBar";
export type { ProjectStatusBarProps } from "./ProjectStatusBar";

// Unified renderer (reads global atom, renders appropriate variant)
export { StatusBarRenderer } from "./StatusBarRenderer";

// Default export
export { EditorStatusBar as default } from "./EditorStatusBar";
