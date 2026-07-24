// Editor & Code Hooks
export { useDiff } from "./git/useDiff";
export { useContextMenu } from "./panels/useContextMenu";
export { useCodeSearch } from "./search/useCodeSearch";
export type { CodeSearchMode, CodeSearchResult } from "./search/useCodeSearch";

// Incremental Indexing
export { useIncrementalIndexing } from "./indexing/useIncrementalIndexing";
export type {
  UseIncrementalIndexingOptions,
  UseIncrementalIndexingReturn,
} from "./indexing/useIncrementalIndexing";
export { useFileWatchIndexing } from "./indexing/useFileWatchIndexing";
export type {
  UseFileWatchIndexingOptions,
  UseFileWatchIndexingReturn,
} from "./indexing/useFileWatchIndexing";

export { useCursorSessionCapture } from "./sessionCapture/useCursorSessionCapture";
export {
  useWorkStationPanels,
  usePrimarySidebarState,
  useBottomPanelState,
} from "./panels/useWorkStationPanels";
export { usePanelResize } from "./panels/usePanelResize";
export { useTabSwitchVerification } from "./tabs/useTabSwitchVerification";
export { useSelectedFile } from "./tabs/useSelectedFile";

// Unified tab management
export {
  useWorkStationTabs,
  useCloseTabWithGuard,
  useFocusTab,
  usePinnedTabs,
} from "./tabs";
export type { UseWorkStationTabsReturn } from "./tabs";

// Browser-specific hooks - import directly from files to avoid circular dependencies
// DO NOT re-export from ./browser index due to circular dependency issues
// Import directly: import { useBrowserPaneState } from "@src/hooks/workStation/browser/useBrowserPaneState"
// Import directly: import { useBrowserSessions } from "@src/hooks/workStation/browser/useBrowserSessions"

// Editor-specific hooks
export { useCodeEditorEvents } from "./editor/useCodeEditorEvents";
export type { CodeEditorEventsOptions } from "./editor/useCodeEditorEvents";

export { useWorkStationTabShortcutBridge } from "./useWorkStationTabShortcutBridge";
export type { WorkStationTabShortcutBridgeOptions } from "./useWorkStationTabShortcutBridge";

export { usePublishWorkstationTabHeader } from "./useWorkstationTabHeader";
export type { WorkstationTabHeaderHost } from "./useWorkstationTabHeader";
