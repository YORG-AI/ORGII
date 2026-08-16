/**
 * Sidebar Modules
 *
 * Reusable, self-contained sidebar tabs that can be mounted in any
 * `PrimarySidebarLayoutWithSections` host. Each module owns its own state,
 * actions, refs and dropdowns; callers pass only domain inputs (e.g.
 * `repoPath`).
 *
 * This is the substrate for the "tab-specific sidebar" pattern: each tab
 * declares (via `TAB_SIDEBAR_REGISTRY`) which sidebar component to render
 * when active, and the host calls `useTabSidebar()` to resolve it. Tabs
 * without a registered sidebar fall through to the host's default sidebar.
 */
export {
  SourceControlFilterHeader,
  SourceControlTabSidebar,
  type SourceControlFilterCounts,
  type SourceControlFilterMode,
} from "./SourceControl";

export { TerminalTabSidebar } from "./Terminal";

export {
  registerTabSidebar,
  getTabSidebarDescriptor,
  hasTabSidebar,
  type TabSidebarComponent,
  type TabSidebarDescriptor,
  type TabSidebarProps,
  type TabSidebarRuntimeContext,
} from "./registry";

export { SidebarSlot, useTabSidebar } from "./useTabSidebar";
