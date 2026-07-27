import { atom } from "jotai";

import { isMacOS } from "@src/util/platform/tauri";

import { activeOverlayCountAtom } from "./overlayLayerAtom";
import { stationModeAtom } from "./simulatorAtom";
import { spotlightOpenAtom } from "./uiAtom";

// ============================================
// Modal & Overlay Visibility Tracking Atoms
// ============================================
// These atoms track when overlays (dropdowns, modals, spotlight) are open.
// Used primarily by useWebviewVisibility to hide native webviews behind overlays.

// Track when ellipsis menu dropdown is open (to hide native webviews)
export const ellipsisMenuOpenAtom = atom<boolean>(false);
ellipsisMenuOpenAtom.debugLabel = "ellipsisMenuOpenAtom";

// Track when there's a global error (to hide native webviews so error overlay is visible)
export const hasGlobalErrorAtom = atom<boolean>(false);
hasGlobalErrorAtom.debugLabel = "hasGlobalErrorAtom";

// Track when the app is quitting (to suppress error handlers during shutdown)
export const isAppQuittingAtom = atom<boolean>(false);
isAppQuittingAtom.debugLabel = "isAppQuittingAtom";

// Track when the app quit confirmation modal is open.
export const quitConfirmationModalOpenAtom = atom<boolean>(false);
quitConfirmationModalOpenAtom.debugLabel = "quitConfirmationModalOpenAtom";

// Track when Component Issue modal is open (Cmd+9) - to hide native webviews
export const componentIssueModalOpenAtom = atom<boolean>(false);
componentIssueModalOpenAtom.debugLabel = "componentIssueModalOpenAtom";

// Track when any toolbar dropdown is open (repo selector, branch selector, spotlight, etc.)
// This is a generic atom for all toolbar dropdowns to use
export const toolbarDropdownOpenAtom = atom<boolean>(false);
toolbarDropdownOpenAtom.debugLabel = "toolbarDropdownOpenAtom";

// Track initial add workspace mode - allows SelectRepoPage to open selector with a specific add form.
// Value: null (default), or one of the add workspace stages
export type AddWorkspaceInitialStage =
  | "add-workspace-new"
  | "add-workspace-clone-url"
  | "add-workspace-clone-github"
  | "add-workspace-existing"
  | null;
export const addWorkspaceInitialStageAtom =
  atom<AddWorkspaceInitialStage>(null);
addWorkspaceInitialStageAtom.debugLabel = "addWorkspaceInitialStageAtom";

// Track when the repo selector is open so modules like useRouteToolbarConfig can trigger it.
export const repoSelectorOpenAtom = atom<boolean>(false);
repoSelectorOpenAtom.debugLabel = "repoSelectorOpenAtom";

// Track when the branch selector is open. Lifted out of SessionInfoLine
// local state so the global ⌥⌘. shortcut can trigger it; SessionInfoLine
// is the sole consumer (no-op when it's not mounted, e.g. on routes
// without a session creator).
export const branchSelectorOpenAtom = atom<boolean>(false);
branchSelectorOpenAtom.debugLabel = "branchSelectorOpenAtom";

// Track when the running-location selector is open. Same shape as the
// branch atom: SessionInfoLine is the only consumer and bridges the
// global ⇧⌘. shortcut into its local dropdown state.
export const locationSelectorOpenAtom = atom<boolean>(false);
locationSelectorOpenAtom.debugLabel = "locationSelectorOpenAtom";

/**
 * Blocks shared native webviews for app-wide overlays.
 * Station-mode-specific blocking is layered by webviewBlockedAtom for legacy
 * My Station owners; the shared Browser singleton uses this atom directly so
 * Agent Station can host the same native browser without recreating it.
 */
export const webviewOverlayBlockedAtom = atom((get) => {
  // macOS can move native WKWebViews behind React overlays. Other platforms
  // need a visibility fallback because inline webviews may paint above modals.
  const hasNativeBlockingOverlay =
    !isMacOS() && get(activeOverlayCountAtom) > 0;
  const hasGlobalError = get(hasGlobalErrorAtom);
  const isComponentIssueModalOpen = get(componentIssueModalOpenAtom);
  const isQuitConfirmationModalOpen = get(quitConfirmationModalOpenAtom);
  const isToolbarDropdownOpen = get(toolbarDropdownOpenAtom);
  const isSpotlightOpen = get(spotlightOpenAtom);

  return (
    hasNativeBlockingOverlay ||
    hasGlobalError ||
    isComponentIssueModalOpen ||
    isQuitConfirmationModalOpen ||
    isToolbarDropdownOpen ||
    isSpotlightOpen
  );
});
webviewOverlayBlockedAtom.debugLabel = "webviewOverlayBlockedAtom";

export const webviewBlockedAtom = atom((get) => {
  const stationMode = get(stationModeAtom);
  const isAgentStation = stationMode === "agent-station";

  return get(webviewOverlayBlockedAtom) || isAgentStation;
});
webviewBlockedAtom.debugLabel = "webviewBlockedAtom";
