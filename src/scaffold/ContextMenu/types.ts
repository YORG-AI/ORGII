/**
 * ContextMenu Types
 *
 * TypeScript type definitions for the unified context menu.
 */
import type { KeyboardEvent, MutableRefObject } from "react";

import type { CliAgentType } from "@src/api/types/keys";
import type { ComposerModeEntry } from "@src/config/sessionCreatorConfig";

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
    /**
     * A TEAMMATE's cloud session. Deliberately distinct from "session":
     * that one's `path` is a bare local session id and is special-cased
     * downstream (pill icon lookup, pill serialization, agent context) as
     * such. A cloud row's path is a full `orgii://…` reference, which
     * those paths would mangle.
     */
    | "cloudSession"
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
  /** Optional upload action shown in the shared + / @ menu. */
  onImageUpload?: () => void;
  /** Current composer mode shown in the shared + / @ menu. */
  currentMode: ComposerModeEntry["id"];
  /** Apply a composer mode; the host also consumes any inline @ trigger. */
  onModeSelect: (mode: ComposerModeEntry["id"]) => void;
  /** Offer Project mode alongside Build, Plan, and Ask. */
  includeProjectMode?: boolean;
  /** Additional first-class @mention suggestions rendered alongside normal context options. */
  customMentionOptions?: ReadonlyArray<ContextMenuCustomMentionOption>;
  onCustomMentionSelect?: (option: ContextMenuCustomMentionOption) => void;
  /** Query owned by the composer input's active inline mention session. */
  searchQuery?: string;
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
  /** Read-only query owned by the composer input. */
  searchQuery?: string;
  /** Number of caller-owned rows in the shared main menu. */
  mainItemCount?: number;
  /** Select a caller-owned main-menu row by its flat index. */
  onMainItemIndexSelect?: (index: number) => void;
  /** Append matching files/folders to main-menu search results. */
  searchFilesFromMain?: boolean;
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
  /** Reset state */
  reset: () => void;
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
