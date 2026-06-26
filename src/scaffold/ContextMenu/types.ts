/**
 * ContextMenu Types
 *
 * TypeScript type definitions for the unified context menu.
 */
import type { KeyboardEvent, MutableRefObject } from "react";

import type { CliAgentType } from "@src/api/types/keys";

import type { MenuItemId, RecentFile, SecondLayerId } from "./config";

// ============================================
// Search Result Item (moved from SearchFile)
// ============================================

export interface SearchResultItem {
  type: "file" | "folder";
  path: string;
  /** Optional display name (if different from path) */
  name?: string;
  /** Root used to produce this result, needed for multi-root previews. */
  repoPath?: string;
  /** Human-readable root/source label for multi-root results. */
  repoName?: string;
  /** Optional icon type for special items (terminal, session, repo, project, work item) */
  iconType?:
    | "terminal"
    | "session"
    | "repo"
    | "project"
    | "workitem"
    | "browser";
  /** Explicit Rust/agent icon id for session rows. */
  agentIconId?: string;
  /** CLI agent type for session rows. */
  cliAgentType?: CliAgentType;
  /** Original session prompt, used by shared session icon resolution. */
  userInput?: string;
}

// ============================================
// Component Props
// ============================================

export interface ContextMenuCustomMentionOption {
  id: string;
  label: string;
  description?: string;
  groupLabel?: string;
  selectType?: MenuItemId;
  selectValue?: string;
  selectDisplayName?: string;
}

export interface ContextMenuProps {
  /** Whether the dropdown is visible */
  visible: boolean;
  /** Callback when dropdown should close */
  onClose: () => void;
  /** Callback when an item is selected (type, path/id, optional display name) */
  onSelect: (type: MenuItemId, value?: string, displayName?: string) => void;
  /** Additional first-class @mention suggestions rendered alongside normal context options. */
  customMentionOptions?: ReadonlyArray<ContextMenuCustomMentionOption>;
  onCustomMentionSelect?: (option: ContextMenuCustomMentionOption) => void;
  /** Current search query (for filtering) */
  searchQuery?: string;
  /** When true, an empty external search opens file results instead of the main menu. */
  inlineSearchOnEmpty?: boolean;
  /** Recent files to show at top */
  recentFiles?: RecentFile[];
  /** Workspace root path for native file search */
  repoPath?: string;
  /** Custom class name */
  className?: string;
  /** Ref to expose keyboard handler to parent */
  keyboardHandlerRef?: MutableRefObject<((e: KeyboardEvent) => boolean) | null>;
  /** Position of file tree preview panel: "left" or "right" (default: "right") */
  treePosition?: "left" | "right";
  /** Highlight the first selectable item immediately when opened from keyboard typing. */
  keyboardOpened?: boolean;
}

// ============================================
// Hook Types
// ============================================

export interface UseContextMenuOptions {
  /** Repo path for native file search */
  repoPath?: string;
  /** Callback when selection is made (type, path/id, optional display name) */
  onSelect?: (type: MenuItemId, value?: string, displayName?: string) => void;
  /** Callback when dropdown closes */
  onClose?: () => void;
  /**
   * External search query from the parent input (text typed after `@`).
   * When provided, the hook can derive secondLayer="files" and uses this as
   * the search query — avoiding two extra setState calls per keystroke.
   */
  externalSearchQuery?: string;
  /** Treat an empty external search query as inline file search. */
  inlineSearchOnEmpty?: boolean;
  /** Number of recent file rows rendered before custom mentions and built-in menu rows. */
  recentCount?: number;
  /** Number of custom mention rows rendered before the built-in menu rows. */
  customMentionCount?: number;
  /** Select a custom mention row by index. */
  onCustomMentionIndexSelect?: (index: number) => void;
  /** Whether the menu was opened from keyboard typing. */
  keyboardOpened?: boolean;
}

export interface UseContextMenuReturn {
  /** Current active menu item index */
  activeIndex: number;
  /** Set active menu item index */
  setActiveIndex: (index: number) => void;
  /** Whether the latest highlight change came from keyboard navigation */
  keyboardNavigated: boolean;
  /** Set keyboard navigation state */
  setKeyboardNavigated: (navigated: boolean) => void;
  /** Current second layer (null if not open) */
  secondLayer: SecondLayerId | null;
  /** Set second layer */
  setSecondLayer: (layer: SecondLayerId | null) => void;
  /** Search query for second layer */
  searchQuery: string;
  /** Set search query */
  setSearchQuery: (query: string) => void;
  /** Search results */
  searchResults: SearchResultItem[];
  /** Whether search is loading */
  searchLoading: boolean;
  /** Active index in second layer */
  secondLayerActiveIndex: number;
  /** Set active index in second layer */
  setSecondLayerActiveIndex: (index: number) => void;
  /** Handle keyboard navigation - returns true if event was handled */
  handleKeyDown: (e: KeyboardEvent) => boolean;
  /** Handle item selection (type, path/id, optional display name) */
  handleSelect: (
    type: MenuItemId,
    value?: string,
    displayName?: string
  ) => void;
  /** Go back to main menu (or from drilled project back to project list) */
  goBack: () => void;
  /** Reset state */
  reset: () => void;
  /** Name of the drilled-into project (null if at project list level) */
  drilledProjectName: string | null;
}

// ============================================
// Internal Types
// ============================================

export interface TerminalItem {
  id: string;
  name: string;
  cwd?: string;
  isActive?: boolean;
}
