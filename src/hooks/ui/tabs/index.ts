// Tab Management Hooks
// Focused hooks (better performance - use these when you only need specific categories)
export { useGlobalBrowserTabs, useGlobalTerminalTabs } from "./useGlobalTabs";
// Tab sync functions (for browser/terminal contexts)
export {
  useSyncBrowserTabs,
  useSyncTerminalSessions,
} from "./useSyncGlobalTabs";

// Session view
export { useSessionView } from "./useSessionView";

// Editor cache (per-repo tab caching)
export { useEditorCache } from "./useEditorCache";

// Editor repo cache sync (saves/restores file tabs when switching repos)
export { useEditorRepoCacheSync } from "./useEditorRepoCacheSync";
