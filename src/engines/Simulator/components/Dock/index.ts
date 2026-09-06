/**
 * Simulator dock — macOS-style app strip (My Station + Agent Station).
 *
 * Internal layout primitives stay in dockLayout.tsx; this barrel exposes only
 * the dock surfaces and data consumed outside this directory.
 */
export type { DockApp } from "./config";
export { DOCK_APPS, getAppById } from "./config";

export { DockContextMenu } from "./DockContextMenu";

export { DockReplayControl } from "./DockReplayControl";

export { StationDockChrome } from "./StationDockChrome";
export { getSimulatorDockTitleCenter } from "./dockTitleCenter";
