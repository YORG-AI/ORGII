/**
 * ViewMode and AppMode type definitions.
 *
 * Zero-dependency module — no imports from store, config, or routes.
 * Imported by: store/ui/workspace/viewModeAtom, config/routes,
 *              config/routeTabMapping, config/routeViewModeConfig.
 */

/** View mode type: which top-level panel is active. */
export type ViewModeType = "mainApp" | "workStation";

/** App mode type for Workstation sub-navigation. */
export type AppModeType = "code" | "browser" | "chat" | "project";
