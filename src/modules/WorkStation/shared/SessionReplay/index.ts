export { gateByActiveKind, type ActiveSelectionKind } from "./activeSelection";

export {
  ReplayTabBar,
  type ReplayTab,
  type KnownReplayTabKind,
} from "./ReplayTabBar";

export { SimulatorReplayChrome } from "./SimulatorReplayChrome";
export { SimulatorWorkstationTabHeader } from "./SimulatorWorkstationTabHeader";

export {
  capNewestWithActive,
  mergeNewestFirstByTimestamp,
  type TimestampedReplayTab,
} from "./replayTabHelpers";

export {
  buildSimulatorReplayPrimarySidebarConfig,
  resolveReplayShellLayoutMode,
  type ReplayShellLayoutMode,
} from "./replayShellHelpers";

export { useReplayShell, type UseReplayShellResult } from "./useReplayShell";

export { ReplayShellLayout, ReplayShellPlaceholder } from "./ReplayShellLayout";
