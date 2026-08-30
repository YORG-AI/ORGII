/**
 * Unified Tab Content — barrel export
 *
 * Single dispatcher (`UnifiedTabContent`) that renders the correct
 * content for any `WorkStationTab` based on `tab.type`, plus a
 * compile-time-exhaustive `REGISTRY` indexed by every
 * `WorkStationTabType` literal.
 *
 * ⚠️ STAGED — NOT YET MOUNTED. The dispatcher has no live caller
 * inside the application today. The host-coupled context required by
 * the majority of renderers (file/git/terminal/browser/db/project) has
 * not been hoisted above the AppShell yet, so mounting this dispatcher
 * on real tabs would degrade Code Editor / Browser / Database /
 * Project surfaces into `HostCoupledPlaceholder` stubs.
 *
 * The next phase ("host context hoist") is expected to:
 *   1. Promote the per-host hook contexts above this dispatcher.
 *   2. Replace each `HostCoupledPlaceholder` in `renderers/*` with
 *      the real component now that the context is reachable.
 *   3. Mount `UnifiedTabContent` from the AppShell so the unified
 *      "All Tabs" surface can render content directly without
 *      navigating to a sub-route.
 *
 * Do NOT import from this module outside the module itself until
 * that hoist lands; doing so produces a visibly degraded UI.
 */
export { UnifiedTabContent } from "./UnifiedTabContent";
export type { UnifiedTabContentDispatcherProps } from "./UnifiedTabContent";
export { REGISTRY } from "./registry";
export type {
  RendererEntry,
  TabContentRegistry,
  UnifiedTabContentProps,
} from "./types";
export { UnknownTabPlaceholder } from "./UnknownTabPlaceholder";
export { TabLoadingPlaceholder } from "./TabLoadingPlaceholder";
