/**
 * Hooks — Public API
 *
 * Only exports symbols consumed by components outside the hooks/ directory.
 * Internal hooks (data, features, reducer) are imported directly by useSpotlight.
 */

// Context provider (used by GlobalSpotlight root)
export { SpotlightProvider } from "./core/SpotlightContext";

// Main composition hook (used by GlobalSpotlight root)
export { useSpotlight } from "./useSpotlight";

// Feature hooks (used by GlobalSpotlight root)
export { useSpotlightEffects } from "./features/useSpotlightEffects";

// Form hooks (used by palettes)
export { useAddWorkspaceFlow } from "./forms/useAddWorkspaceFlow";
export type { AddWorkspaceModalStage } from "./forms/useAddWorkspaceFlow";

// Shared data hooks (used by palettes and main Spotlight)
export {
  EXTERNAL_RECENT_PATH_WORKSPACE_THRESHOLD,
  useExternalRecentPaths,
} from "./data/useExternalRecentPaths";
export { useSharedRepoList } from "./data/useSharedRepoList";
export { useWorkspaceSwitch } from "./data/useWorkspaceSwitch";
export type { WorkspaceSwitchEntry } from "./data/useWorkspaceSwitch";

// Account-footer helper (used by palettes with per-hovered-item footers)
export { useAccountFooterForHovered } from "./useAccountFooterForHovered";

// Path segment hook (used by palettes to resolve i18n path labels/templates)
export { usePathSegment } from "./usePathSegment";
