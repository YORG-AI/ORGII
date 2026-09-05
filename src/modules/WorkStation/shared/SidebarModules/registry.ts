/**
 * Tab Sidebar Registry
 *
 * Maps a `WorkStationTab.type` to a self-contained sidebar component. When a
 * registered tab is active in the host, the host should render the registered
 * sidebar in place of its default sidebar. This is the substrate for the
 * "tab-specific sidebar" pattern (e.g. Diff tab brings the Source Control
 * sidebar; Search tab will bring search filters; etc.).
 *
 * Tabs that do NOT have an entry here render the host's default sidebar
 * (e.g. file/code-editor explorer with Files / Search / Testing / Extensions).
 *
 * Conventions:
 *   - Each component must own its internal state (selection, filter, refs).
 *   - The component is mounted lazily once the tab becomes active. Whether
 *     it stays mounted-but-hidden after the tab is left is decided by the
 *     shared tab retention policy (`@src/store/workstation/tabs/tabRetention`),
 *     read by `SidebarSlot` — not declared per sidebar.
 *   - Components receive only domain inputs — never tab data dictionaries.
 */
import type { ComponentType } from "react";

import type {
  WorkStationTab,
  WorkStationTabType,
} from "@src/store/workstation/tabs";
import type { SourceControlHistorySelection } from "@src/store/workstation/tabs";
import type { GitFile } from "@src/types/git/types";

export interface TabSidebarRuntimeContext {
  /** Whether the host workspace has multiple root folders. */
  isMultiRoot?: boolean;
  /** Repository path the host is currently bound to. */
  repoPath: string;
  /** Repository id. Falls back to `repoPath` when the host doesn't track ids. */
  repoId: string;
  git?: {
    /** Opens a git file diff in the host's main pane. */
    onFileSelect?: (file: GitFile) => void;
    /** Syncs sidebar git file lists back to the host's main pane. */
    onFilesChange?: (files: GitFile[], scopeRepoRoot?: string) => void;
    /** Renders a selected history node in the host Source Control pane. */
    onHistorySelectionChange?: (
      selection: SourceControlHistorySelection
    ) => void;
  };
  surface?: Record<string, unknown>;
}

export interface TabSidebarProps {
  /** The active tab the sidebar is bound to. */
  tab: WorkStationTab;
  /** Host runtime services and tab-specific context. */
  context: TabSidebarRuntimeContext;
}

export type TabSidebarComponent = ComponentType<TabSidebarProps>;

export interface TabSidebarDescriptor {
  component: TabSidebarComponent;
}

const REGISTRY = new Map<WorkStationTabType, TabSidebarDescriptor>();

/**
 * Register a sidebar component for a given tab type. Idempotent — last
 * registration wins. Call this at module-init time from the file that owns
 * the sidebar component (so the registry is populated by the time the tab
 * becomes active).
 */
export function registerTabSidebar(
  tabType: WorkStationTabType,
  descriptor: TabSidebarComponent | TabSidebarDescriptor
): void {
  REGISTRY.set(
    tabType,
    typeof descriptor === "function" ? { component: descriptor } : descriptor
  );
}

/**
 * Look up the sidebar descriptor for a given tab type, or `undefined` when no
 * override has been registered (host should render its default sidebar).
 */
export function getTabSidebarDescriptor(
  tabType: WorkStationTabType
): TabSidebarDescriptor | undefined {
  return REGISTRY.get(tabType);
}

/**
 * Returns true when ANY sidebar override has been registered for this tab
 * type. Useful when the host wants to swap entire layout structures (not
 * just inner content) — e.g. drop tab strip when in tab-specific sidebar
 * mode.
 */
export function hasTabSidebar(tabType: WorkStationTabType): boolean {
  return REGISTRY.has(tabType);
}
