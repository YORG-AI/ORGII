/**
 * Workstation Store
 *
 * State management for all Workstation apps:
 * - Code Editor: terminal, file explorer, search, test runner, extensions
 * - Database: connections, tabs
 * - Browser: sessions, design tokens
 *
 * Also includes the shared tab system.
 *
 * Note: Some submodules have name conflicts with the shared tab system.
 * Import directly from subpaths when needed:
 * - "@src/store/workstation/tabs" - shared tab types & mutations
 * - "@src/store/workstation/database" - database connections & tabs
 * - "@src/store/workstation/browser/tabs" - browser-specific tabs
 */

// Shared tab system (types, mutations, factories)
export * from "./tabs";

// Cross-host tab index (derived) + routed writers
export * from "./tabRegistry";

// Visible content host — derived from the active tab (unified surface).
export { activeHostAtom } from "./tabHost";

// Workstation TabBar (AppShell) coordination atoms
export {
  workstationNewBrowserSessionRequestAtom,
  requestNewBrowserSessionAtom,
  type WorkstationNewBrowserSessionRequest,
  workstationProjectTabBarAtom,
  WORK_MANAGEMENT_SECTION,
  WORK_MANAGEMENT_PROJECTS_VIEW,
  workManagementProjectsViewAtom,
  type WorkManagementSection,
  type WorkManagementProjectsView,
  workstationTabHeaderAtomByHost,
  activeWorkstationTabHeaderAtom,
  normalizeWorkstationTabHeaderContribution,
  type WorkstationTabHeaderContribution,
  type WorkstationTabHeaderSlots,
} from "./workstationTabBarAtoms";

// Code Editor app (terminal, file, search, testRunner, extensions)
export * from "./codeEditor";

// Browser app - tokens only
// Note: Import browser tabs from "@src/store/workstation/browser/tabs" directly
export * from "./browser/tokens";

// Note: Database has name conflicts with shared tabs - import directly:
// import { ... } from "@src/store/workstation/database";
