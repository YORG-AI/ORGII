/**
 * Source Control sidebar module entry.
 *
 * Re-exports the headless hook (consumers compose their own shell), the
 * pre-built Source Control tab sidebar (registers itself in
 * `TAB_SIDEBAR_REGISTRY` at module-init), and the hook's option / result
 * types.
 */
export { SourceControlTabSidebar } from "./SourceControlTabSidebar";
export { default as SourceControlFilterHeader } from "./SourceControlFilterHeader";
export type {
  SourceControlFilterCounts,
  SourceControlFilterMode,
} from "./SourceControlFilterHeader";
