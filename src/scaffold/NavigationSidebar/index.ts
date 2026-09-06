/**
 * Sidebar
 *
 * Unified sidebar system with composable building blocks.
 *
 * @example
 * ```tsx
 * import { SidebarBase, SidebarHeader, SidebarSearch, SidebarList, SidebarGroup } from "@src/scaffold/NavigationSidebar";
 *
 * <SidebarBase sidebarId="terminal">
 *   <SidebarHeader title="Terminal" tabs={tabs} />
 *   <SidebarSearch value={search} onChange={setSearch} />
 *   <SidebarList>
 *     <SidebarGroup group={sessionsGroup} onItemClick={handleClick} />
 *   </SidebarList>
 * </SidebarBase>
 * ```
 */

// ============================================
// Base component
// ============================================
export { default as SidebarBase } from "./SidebarBase";

// ============================================
// Hover Sidebar (floating sidebar on hover)
// ============================================
export { default as HoverSidebar } from "./HoverSidebar";

// ============================================
// Building blocks
// ============================================
export { SidebarHeader, SidebarList } from "./blocks";

// ============================================
// Components
// ============================================
export { default as NavigationMenu } from "./components/NavigationMenu";
export type { NavigationMenuItem } from "./components/NavigationMenu/config";

// ============================================
// Contexts
// ============================================
export {
  useForceVisibleSidebar,
  ForceVisibleSidebarProvider,
} from "./contexts";

// ============================================
// Configuration
// ============================================
export { SIDEBAR_STYLE, SIDEBAR_PADDING } from "./config";

// ============================================
// Variants (composed sidebars)
// ============================================
export {
  // Base composed sidebars
  NavigationSidebar,
} from "./variants";

// Variant types

// ============================================
// Connectors (sidebar data providers)
// ============================================
export { WorkstationSidebarConnector } from "./connectors";
