/**
 * Simulator dock — macOS-style app strip (My Station + Agent Station).
 *
 * Layout primitives live in dockLayout.tsx (not inlined here): Dock and DockReplayControl
 * must import from that file directly to avoid a circular dependency with this barrel.
 */
export type { DockApp } from "./config";
export {
  BACKGROUND_TASKS_DOCK_APP,
  DOCK_APP_SEGMENTS,
  DOCK_APPS,
  getAppById,
} from "./config";

export { Dock } from "./Dock";

export { DockContextMenu } from "./DockContextMenu";

export { DockReplayControl } from "./DockReplayControl";

export { StationDockChrome } from "./StationDockChrome";

export {
  DOCK_ICON_PROPS,
  DockIconColumn,
  DockSegmentDivider,
  StationDockGlassPill,
  StationDockRow,
  dockIconHitAreaClassName,
} from "./dockLayout";

export {
  getWorkStationStationTitleCenter,
  getSimulatorDockTitleCenter,
} from "./dockTitleCenter";
