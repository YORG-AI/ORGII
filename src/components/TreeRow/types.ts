import type {
  DragEvent,
  MouseEvent,
  PointerEventHandler,
  ReactNode,
} from "react";

/**
 * Shared types for tree row components
 *
 * Used by source control, search results, and design tree lists.
 */

export interface TreeRowNode {
  /** Unique identifier - typically the file/folder path */
  id: string;
  /** Display name */
  name: string;
  /** Full path */
  path: string;
  /** Node type */
  type: "file" | "directory";
  /** Whether directory is expanded */
  expanded?: boolean;
  /**
   * Custom icon element (optional).
   *
   * - `undefined` (key absent) → use default (chevron for directories,
   *   FileTypeIcon for files).
   * - A ReactNode → render that node in the icon slot.
   * - `null` → render nothing in the icon slot (use this when a file row
   *   should have no leading icon at all, matching the no-icon rows in the
   *   code editor's tree).
   */
  icon?: ReactNode;
  /** Whether this is a symbolic link */
  isSymlink?: boolean;
  /** Whether this file is ignored by .gitignore */
  isIgnored?: boolean;
}

export interface GitStatusInfo {
  /** Git status: modified, added, deleted, renamed, untracked, conflict */
  status: string;
  /** Whether the change is staged */
  staged: boolean;
}

export interface TreeRowBaseProps {
  /** The tree node data */
  node: TreeRowNode;
  /** Depth level for indentation (0 = root) */
  depth: number;
  /** Whether this row is selected */
  isSelected?: boolean;
  /** Whether this row is part of a multi-selection */
  isMultiSelected?: boolean;
  /** Git status info for coloring (optional) */
  gitStatus?: GitStatusInfo | null;
  /** Click handler */
  onClick?: (event: MouseEvent) => void;
  /** Context menu handler */
  onContextMenu?: (event: MouseEvent) => void;
  /** Custom class name */
  className?: string;
  /** Whether to show rounded corners (default: true) */
  rounded?: boolean;
  /** Icon rendered between the main icon (chevron) and the name text */
  prefixIcon?: ReactNode;
  /** Children to render after the name (e.g., action buttons) */
  children?: ReactNode;
  /** Data attribute for path (for DOM queries) */
  dataPath?: string;
  /** Whether draggable */
  draggable?: boolean;
  /** Drag start handler */
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  /** Drag end handler */
  onDragEnd?: (event: DragEvent<HTMLDivElement>) => void;
  /** Mouse down handler (used for native OS drag-out) */
  onMouseDown?: (event: MouseEvent<HTMLDivElement>) => void;
  /** Mouse enter handler */
  onMouseEnter?: (event: MouseEvent<HTMLDivElement>) => void;
  /** Mouse leave handler */
  onMouseLeave?: (event: MouseEvent<HTMLDivElement>) => void;
  /** Pointer down handler (used for custom pointer-based drags) */
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  // NOTE: isDragging removed - now uses .is-dragging CSS class for performance
  /** Show VS Code-style vertical indent guide lines (default: true) */
  showIndentGuides?: boolean;
  /** Show parent directory path after filename (for flat list views) */
  showPathHint?: boolean;
  /**
   * Render the native `title` tooltip (full path) on the name.
   * Set to false when the row is wrapped in its own hover card, so the two
   * tooltips don't stack. (default: true)
   */
  showNativeTitle?: boolean;
}

export interface GitStatusBadgeProps {
  /** Git status info */
  status: GitStatusInfo | null;
  /** Whether this is for a directory (shows dot) or file (shows letter) */
  isDirectory: boolean;
  /** Optional title override */
  title?: string;
}
