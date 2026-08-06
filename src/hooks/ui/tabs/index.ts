// Tab Management Hooks
// Focused hooks (better performance - use these when you only need specific categories)
export {
  useGlobalBrowserTabs,
  useGlobalTerminalTabs,
  useGlobalEditorTabs,
  useGlobalDocumentTabs,
  useGlobalSessionTabs,
  useGlobalShortcutTabs,
  useGlobalTabCounts,
} from "./useGlobalTabs";
// Tab sync functions (for browser/editor/document contexts)
export {
  useSyncBrowserTabs,
  useSyncEditorRepos,
  useSyncDocumentFiles,
} from "./useSyncGlobalTabs";

// Session view
export { useSessionView } from "./useSessionView";
export type { UseSessionViewReturn } from "./useSessionView";

// Editor cache (per-repo tab caching)
export { useEditorCache } from "./useEditorCache";
export type { UseEditorCacheReturn } from "./useEditorCache";

// Editor repo cache sync (saves/restores file tabs when switching repos)
export { useEditorRepoCacheSync } from "./useEditorRepoCacheSync";
