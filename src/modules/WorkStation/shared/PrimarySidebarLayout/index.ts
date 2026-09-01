/**
 * PrimarySidebarLayout - Shared primary sidebar layout components
 *
 * Provides consistent sidebar structure for Workstation apps:
 * - CodeEditor (EditorPrimarySidebar)
 * - DatabaseManager (DatabasePrimarySidebar)
 * - Browser (BrowserPrimarySidebar)
 */

export { CollapsibleSection } from "./CollapsibleSection";
export type { CollapsibleSectionProps } from "./CollapsibleSection";

export {
  PrimarySidebarLayoutWithSections,
  PrimarySidebarLayoutWithSections as PrimarySidebarLayout,
} from "./PrimarySidebarLayoutWithSections";
export type {
  PrimarySidebarLayoutWithSectionsProps,
  PrimarySidebarTab,
  PanelSection,
} from "./PrimarySidebarLayoutWithSections";

export { PanelSectionHeader } from "./PanelSectionHeader";
