import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import type { ViewModeType } from "@src/config/viewModeTypes";

export type { ViewModeType };

// ============================================
// View Mode Atoms - App/Session/Workstation view toggle state.
// ============================================
// These use regular atoms (not persisted) because view mode should reset on page refresh
// But they're global to survive component remounts during navigation

/**
 * @internal
 * Internal atom for view mode state. Used ONLY by ViewModeSync for bidirectional sync.
 *
 * **DO NOT USE THIS DIRECTLY IN COMPONENTS.**
 *
 * For reading viewMode in React components, use the canonical hook:
 * ```tsx
 * import { useRouteViewMode } from "@src/config/routeViewModeConfig";
 * const viewMode = useRouteViewMode();
 * ```
 *
 * Why: The atom updates asynchronously via useEffect, causing a 1-frame delay
 * after route changes. This causes layout flash during view mode transitions.
 * useRouteViewMode() derives viewMode synchronously from the route.
 */
export const viewModeAtom = atom<ViewModeType>("mainApp");
viewModeAtom.debugLabel = "viewModeAtom";

/** Previous route to navigate back to when switching from Code Editor to App view.
 * Persisted to sessionStorage to survive HMR. */
export const viewModePreviousRouteAtom = atomWithStorage<string>(
  "viewModePreviousRoute",
  "",
  {
    getItem: (key) => {
      const storedValue = sessionStorage.getItem(key);
      return storedValue ? JSON.parse(storedValue) : "";
    },
    setItem: (key, value) => {
      sessionStorage.setItem(key, JSON.stringify(value));
    },
    removeItem: (key) => {
      sessionStorage.removeItem(key);
    },
  }
);
viewModePreviousRouteAtom.debugLabel = "viewModePreviousRouteAtom";

/** Route to return to when leaving the Settings second-level sidebar. */
export const settingsReturnRouteAtom = atomWithStorage<string>(
  "settingsReturnRoute",
  "",
  {
    getItem: (key) => {
      const storedValue = sessionStorage.getItem(key);
      return storedValue ? JSON.parse(storedValue) : "";
    },
    setItem: (key, value) => {
      sessionStorage.setItem(key, JSON.stringify(value));
    },
    removeItem: (key) => {
      sessionStorage.removeItem(key);
    },
  }
);
settingsReturnRouteAtom.debugLabel = "settingsReturnRouteAtom";

/** Flag to prevent race conditions during view mode switching */
export const viewModeSwitchingAtom = atom<boolean>(false);
viewModeSwitchingAtom.debugLabel = "viewModeSwitchingAtom";
