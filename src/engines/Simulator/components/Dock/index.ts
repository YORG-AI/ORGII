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
export type { DockAppItem } from "./Dock";

export { DockContextMenu } from "./DockContextMenu";
export type { DockContextMenuProps } from "./DockContextMenu";

export { DockReplayControl } from "./DockReplayControl";

export { StationDockChrome } from "./StationDockChrome";
export type { StationDockChromeProps } from "./StationDockChrome";

export {
  DOCK_COLUMN_HEIGHT_SPACER_PX,
  DOCK_ICON_PROPS,
  DockIconColumn,
  DockSegmentDivider,
  StationDockGlassPill,
  StationDockRow,
  dockIconHitAreaClassName,
} from "./dockLayout";
export type {
  DockIconColumnProps,
  DockIconTrailerMode,
  StationDockGlassPillProps,
  StationDockRowProps,
} from "./dockLayout";

export {
  getWorkStationStationTitleCenter,
  getSimulatorDockTitleCenter,
} from "./dockTitleCenter";
