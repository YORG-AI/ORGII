/**
 * ContextMenu Configuration
 *
 * Centralized configuration for the unified context menu.
 * Includes icon definitions, menu items, and keyboard shortcuts.
 */
import {
  ArrowRight02Icon,
  Clock01Icon,
  File01Icon,
  FolderClosedIcon,
  type IconSvgElement,
  ListChecksIcon,
  Loading03Icon,
  Search01Icon,
  WorkHistoryIcon,
} from "@src/icons";

// ============================================
// Types
// ============================================

export type MenuItemId =
  | "recent"
  | "files"
  | "folder"
  | "repo"
  | "terminal"
  | "sessions"
  | "session"
  /** A teammate's cloud session; its value is a full `orgii://…` reference. */
  | "cloudSession"
  | "projects"
  | "project"
  | "workitem"
  | "browser";

export type SecondLayerId = "files" | "sessions";

export interface MenuItem {
  id: MenuItemId;
  label: string;
  translationKey: string;
  icon: IconSvgElement;
  hasSecondLayer: boolean;
  shortcut?: string;
}

export interface RecentFile {
  path: string;
  name: string;
  type: "file" | "folder";
}

// ============================================
// Icon Configuration
// ============================================

export const ICON_CONFIG = {
  recent: Clock01Icon,
  files: File01Icon,
  folders: FolderClosedIcon,
  sessions: WorkHistoryIcon,
  projects: ListChecksIcon,
  arrow: ArrowRight02Icon,
  search: Search01Icon,
  loading: Loading03Icon,
  empty: File01Icon,
} as const;

// ============================================
// Second Layer Configuration
// ============================================

export interface SecondLayerConfig {
  title: string;
  translationKey: string;
  icon: IconSvgElement;
}

export const SECOND_LAYER_CONFIG: Record<SecondLayerId, SecondLayerConfig> = {
  files: {
    title: "Files & Folders",
    translationKey: "creator.contextMenu.filesAndFolders",
    icon: ICON_CONFIG.files,
  },
  sessions: {
    title: "Session",
    translationKey: "creator.contextMenu.session",
    icon: ICON_CONFIG.sessions,
  },
};

// ============================================
// Menu Configuration
// ============================================

export const MENU_ITEMS: MenuItem[] = [
  {
    id: "files",
    label: "Files & Folders",
    translationKey: "creator.contextMenu.filesAndFolders",
    icon: ICON_CONFIG.files,
    hasSecondLayer: true,
  },
  {
    id: "sessions",
    label: "Session",
    translationKey: "creator.contextMenu.session",
    icon: ICON_CONFIG.sessions,
    hasSecondLayer: true,
  },
  {
    id: "projects",
    label: "Work Items",
    translationKey: "creator.contextMenu.workItems",
    icon: ICON_CONFIG.projects,
    hasSecondLayer: false,
  },
];

// ============================================
// Keyboard Shortcuts
// ============================================

export const KEYBOARD_CONFIG = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
} as const;

// ============================================
// Style Configuration
// ============================================

export const STYLE_CONFIG = {
  dropdownWidth: "280px",
  secondLayerWidth: "280px",
  /** Scrollable list cap — keep menus from dominating the viewport */
  maxHeight: "260px",
  itemHeight: "32px",
  recentSectionMaxItems: 3,
  searchResultsMaxItems: 20,
} as const;
// ============================================
// Utility Functions
// ============================================

export { getFileName } from "@src/util/file/pathUtils";

/**
 * Truncate path for display
 */
export const truncatePath = (path: string, maxLength: number = 40): string => {
  if (path.length <= maxLength) return path;
  return "..." + path.slice(-maxLength + 3);
};
