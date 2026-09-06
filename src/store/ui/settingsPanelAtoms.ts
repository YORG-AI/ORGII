/**
 * Settings panel atoms (side-channel state).
 *
 * Navigation state (active section, current subpage) lives in the URL via
 * `@src/config/mainAppPaths` — see `parseSettingsPath`. This file only
 * hosts orthogonal atoms used by individual settings sections to
 * coordinate refresh / scanning / active sub-tab state.
 */
import { atom } from "jotai";

/**
 * Optional status filter applied when opening the learnings browser via
 * the Status Card pill deep-link. `null` == "no filter" (show all).
 */
export type LearningsBrowserStatusFilter =
  | null
  | "pending"
  | "active"
  | "merged"
  | "deprecated";

/**
 * Initial status filter for the learnings browser when opened via deep
 * link. Consumed once on mount; the browser owns its own filter state
 * afterwards.
 */
export const learningsBrowserInitialFilterAtom =
  atom<LearningsBrowserStatusFilter>(null);
learningsBrowserInitialFilterAtom.debugLabel =
  "settings/learningsBrowserInitialFilter";

/**
 * Increment to trigger a monitor refresh from the panel header.
 * MonitorSection dispatches to resources/network/storage based on active tab.
 */
export const monitorRefreshTriggerAtom = atom<number>(0);
monitorRefreshTriggerAtom.debugLabel = "settings/monitorRefreshTrigger";

/**
 * True while monitor refresh is in progress (for header refresh button spin).
 */
export const monitorScanningAtom = atom<boolean>(false);
monitorScanningAtom.debugLabel = "settings/monitorScanning";

/**
 * Active tab in Monitor section (resources | network | storage).
 */
export const monitorActiveTabAtom = atom<string>("resources");
monitorActiveTabAtom.debugLabel = "settings/monitorActiveTab";

/**
 * Increment to trigger NetworkSection refresh (when Monitor tab is network).
 */
export const networkRefreshTriggerAtom = atom<number>(0);
networkRefreshTriggerAtom.debugLabel = "settings/networkRefreshTrigger";

/**
 * Increment to trigger StorageSection refresh (when Monitor tab is storage).
 */
export const storageRefreshTriggerAtom = atom<number>(0);
storageRefreshTriggerAtom.debugLabel = "settings/storageRefreshTrigger";
