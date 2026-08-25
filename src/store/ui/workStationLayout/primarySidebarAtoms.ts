import { atom } from "jotai";

import { WORK_STATION_PRIMARY_SIDEBAR } from "@src/config/workStationPrimarySidebar";

import { getStoredValue, setStoredValue } from "./storage";

// Source Control is not in this list anymore — it lives in `<DiffTabSidebar>`
// (a tab-specific sidebar resolved via TAB_SIDEBAR_REGISTRY) rather than as a
// regular sidebar tab.
export const PRIMARY_SIDEBAR_TABS = {
  FILES: "files",
  SEARCH: "search",
} as const;

export type PrimarySidebarTabKey =
  (typeof PRIMARY_SIDEBAR_TABS)[keyof typeof PRIMARY_SIDEBAR_TABS];

export const PRIMARY_SIDEBAR_TAB_ORDER = [
  PRIMARY_SIDEBAR_TABS.FILES,
  PRIMARY_SIDEBAR_TABS.SEARCH,
] as const;

export const PRIMARY_SIDEBAR_TAB_LABELS: Record<PrimarySidebarTabKey, string> =
  {
    [PRIMARY_SIDEBAR_TABS.FILES]: "Files",
    [PRIMARY_SIDEBAR_TABS.SEARCH]: "Search",
  };

/**
 * Primary sidebar selected tab. Session-only — not persisted across
 * restarts because the default Search tab is the active primary sidebar entry.
 */
export const workStationPrimarySidebarTabAtom = atom<PrimarySidebarTabKey>(
  PRIMARY_SIDEBAR_TABS.FILES
);
workStationPrimarySidebarTabAtom.debugLabel =
  "workStationPrimarySidebarTabAtom";

export const workStationSearchFocusSignalAtom = atom(0);
workStationSearchFocusSignalAtom.debugLabel =
  "workStationSearchFocusSignalAtom";

function getStoredPrimarySidebarCollapsed(): boolean {
  const stored = getStoredValue("primary_sidebar_collapsed");
  return stored === "true";
}

/**
 * Primary sidebar collapsed state.
 *
 * The primary sidebar is a WorkStation-local rail. It is independent from the
 * app-level Home/Agent sidebar so the header button only hides WorkStation
 * content chrome.
 */
export const workStationPrimarySidebarCollapsedAtom = atom<boolean>(
  getStoredPrimarySidebarCollapsed()
);
workStationPrimarySidebarCollapsedAtom.debugLabel =
  "workStationPrimarySidebarCollapsedAtom";

export const workStationPrimarySidebarCollapsedPersistAtom = atom(
  (get) => get(workStationPrimarySidebarCollapsedAtom),
  (get, set, value: boolean | "toggle") => {
    const next =
      value === "toggle" ? !get(workStationPrimarySidebarCollapsedAtom) : value;
    set(workStationPrimarySidebarCollapsedAtom, next);
    setStoredValue("primary_sidebar_collapsed", String(next));
  }
);

/**
 * Browser-specific primary sidebar collapsed state.
 *
 * Independent of the shared `workStationPrimarySidebarCollapsedAtom` so that
 * toggling the sidebar in the Browser tool does not affect Code Editor / Database
 * Manager, and vice versa. Defaults to `true` (hidden) because the browser
 * sidebar is an optional panel rather than a primary navigation surface.
 */
function getStoredBrowserSidebarCollapsed(): boolean {
  const stored = getStoredValue("browser_primary_sidebar_collapsed");
  // Explicit stored value takes precedence; default to true (hidden).
  if (stored !== null) return stored === "true";
  return true;
}

export const workStationBrowserSidebarCollapsedAtom = atom<boolean>(
  getStoredBrowserSidebarCollapsed()
);
workStationBrowserSidebarCollapsedAtom.debugLabel =
  "workStationBrowserSidebarCollapsedAtom";

export const workStationBrowserSidebarCollapsedPersistAtom = atom(
  (get) => get(workStationBrowserSidebarCollapsedAtom),
  (get, set, value: boolean | "toggle") => {
    const next =
      value === "toggle" ? !get(workStationBrowserSidebarCollapsedAtom) : value;
    set(workStationBrowserSidebarCollapsedAtom, next);
    setStoredValue("browser_primary_sidebar_collapsed", String(next));
  }
);

function getStoredPrimarySidebarWidth(): number {
  const { minWidth, maxWidth, defaultWidth } = WORK_STATION_PRIMARY_SIDEBAR;
  const stored = getStoredValue("primary_sidebar_width");
  if (stored) {
    const width = parseInt(stored, 10);
    if (!isNaN(width) && width >= minWidth && width <= maxWidth) {
      return width;
    }
  }
  return defaultWidth;
}

export const workStationPrimarySidebarWidthAtom = atom<number>(
  getStoredPrimarySidebarWidth()
);
workStationPrimarySidebarWidthAtom.debugLabel =
  "workStationPrimarySidebarWidthAtom";

export const workStationPrimarySidebarWidthPersistAtom = atom(
  (get) => get(workStationPrimarySidebarWidthAtom),
  (_get, set, value: number) => {
    const { minWidth, maxWidth } = WORK_STATION_PRIMARY_SIDEBAR;
    const clampedValue = Math.max(minWidth, Math.min(maxWidth, value));
    set(workStationPrimarySidebarWidthAtom, clampedValue);
    setStoredValue("primary_sidebar_width", String(clampedValue));
  }
);
