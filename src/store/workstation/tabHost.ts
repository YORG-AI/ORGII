/**
 * Maps a `WorkStationTabType` (or `WorkStationTabCategory`) onto the host
 * surface the AppShell uses to decide which content area should render the
 * active tab.
 *
 * The host projection is a UI-routing concern, not a registry concern, which
 * is why it lives outside `tabs/atoms.ts`. The workstation uses a single flat
 * tab pool (`mainPane`), so dispatch to a content renderer is derived from the
 * active tab's type rather than from a separate per-host pane bucket.
 */
import { atom } from "jotai";

import { activeWorkStationTabAtom, mainPaneTabsAtom } from "./tabs";
import type {
  WorkStationTab,
  WorkStationTabCategory,
  WorkStationTabType,
} from "./tabs/types";

export type WorkstationTabHost = "code" | "browser" | "project";

/**
 * Map a tab category onto its content host. Categories are the canonical
 * discriminator already used by the renderer registry.
 *
 * Code-editor-family categories (file, git, terminal, search, settings, lint,
 * ai-impact, preview, subagent, chat, explorer, work-management, launchpad) all
 * project onto `"code"` because they render inside the Code Editor surface.
 */
export function categoryToTabHost(
  category: WorkStationTabCategory | undefined
): WorkstationTabHost {
  switch (category) {
    case "browser":
      return "browser";
    case "project":
      return "project";
    default:
      return "code";
  }
}

/**
 * Map a tab type onto its host. Convenience for callers that have the raw
 * `tab.type` literal rather than the category. Mirrors `categoryToTabHost` via
 * the tab-type → category default mapping in `tabFactory.ts`.
 */
export function tabTypeToTabHost(type: WorkStationTabType): WorkstationTabHost {
  switch (type) {
    case "browser-session":
    case "devtools":
      return "browser";
    case "project-dashboard":
    case "project-work-items":
    case "project-linear-projects":
    case "project-linear-work-items":
    case "project-settings":
    case "project-org":
    case "project-org-settings":
    case "project-git-sync-review":
    case "project-workitems":
    case "workItem-detail":
      return "project";
    default:
      return "code";
  }
}

/** Convenience: derive host from a tab. */
export function tabToHost(tab: WorkStationTab): WorkstationTabHost {
  return tab.category
    ? categoryToTabHost(tab.category)
    : tabTypeToTabHost(tab.type);
}

/**
 * The host whose content the AppShell mounts. The unified workstation runs a
 * single flat tab pool, so the visible host simply follows the active tab's
 * type — clicking a tab in the unified bar swaps the content area without any
 * route navigation. Falls back to `"code"` when no tab is active (empty pool /
 * Launchpad).
 */
export const activeHostAtom = atom<WorkstationTabHost>((get) => {
  const activeTab = get(activeWorkStationTabAtom);
  return activeTab ? tabToHost(activeTab) : "code";
});
activeHostAtom.debugLabel = "activeHostAtom";

/**
 * Launchpad (`start`) tabs are ephemeral placeholders seeded whenever the
 * pool empties (see `useLaunchpadTab`); they never count as real work.
 */
export function isRealWorkstationTab(tab: WorkStationTab): boolean {
  return tab.type !== "start";
}

/**
 * True when the main pane holds any tab besides the ephemeral Launchpad.
 * Derived boolean so subscribers only re-render when the answer flips, not
 * on every tab-pool mutation. The AppShell uses this to release every
 * kept-alive content host once the pool empties.
 */
export const mainPaneHasRealTabsAtom = atom<boolean>((get) =>
  get(mainPaneTabsAtom).some(isRealWorkstationTab)
);
mainPaneHasRealTabsAtom.debugLabel = "mainPaneHasRealTabsAtom";

/**
 * True when any main-pane tab projects onto the browser host. Background
 * `browser-session` tabs need the Browser host mounted even before their
 * first activation — its sessions ↔ tab-strip sync lives inside
 * `BrowserLayout`.
 */
export const mainPaneHasBrowserHostTabsAtom = atom<boolean>((get) =>
  get(mainPaneTabsAtom).some((tab) => tabToHost(tab) === "browser")
);
mainPaneHasBrowserHostTabsAtom.debugLabel = "mainPaneHasBrowserHostTabsAtom";
