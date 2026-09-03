import { atom } from "jotai";
import type { ReactNode } from "react";

import { activeStatusBarAppAtom } from "@src/store/ui/workStationLayout/statusBarAtoms";

/**
 * Cross-host request to open a new Browser session, fired from anywhere in
 * the app without requiring `BrowserLayout` to be currently focused.
 *
 * Shape:
 *   - `tick`     — monotonic counter that strictly increases with every
 *                  request. `BrowserLayout` watches it and dispatches
 *                  `addSession(url, isPrivate)` whenever the value
 *                  advances past the one observed on mount. Two requests
 *                  with identical payloads are still distinguishable
 *                  because the tick differs.
 *   - `url`      — optional initial URL (or search query, normalized by
 *                  the consumer via `normalizeBrowserInput`).
 *   - `isPrivate`— `true` for an incognito session, omitted/`false`
 *                  otherwise.
 *
 * Decoupling the request from the host lets the unified `+` menu (both
 * All-Tabs and Browser variants) work on first paint, before the user
 * has ever visited Browser.
 *
 * Callers must use the `requestNewBrowserSession` helper rather than
 * writing the atom directly, so the tick advancement is centralized and
 * the payload shape stays consistent.
 */
export interface WorkstationNewBrowserSessionRequest {
  tick: number;
  url?: string;
  isPrivate?: boolean;
}

export const workstationNewBrowserSessionRequestAtom =
  atom<WorkstationNewBrowserSessionRequest>({ tick: 0 });
workstationNewBrowserSessionRequestAtom.debugLabel =
  "workstationNewBrowserSessionRequestAtom";

/**
 * Highest request `tick` the Browser host has already turned into a session.
 *
 * Lives at module scope (not a component ref) so it survives the Browser
 * host mounting/unmounting. On mount the host fires for any request whose
 * tick is greater than this — which lets a request issued *before* the host
 * existed (e.g. "New Browser" from the empty Launchpad) still open a session,
 * while a remount with no new request does not re-fire.
 */
export const workstationNewBrowserSessionConsumedTickAtom = atom<number>(0);
workstationNewBrowserSessionConsumedTickAtom.debugLabel =
  "workstationNewBrowserSessionConsumedTickAtom";

/**
 * Write-only helper: bumps the request tick by one and applies the
 * provided payload atomically. Use this from `useSetAtom` instead of
 * writing the underlying atom directly — it keeps the tick monotonic and
 * the call-site free of the bookkeeping.
 *
 * @example
 *   const requestNewBrowserSession = useSetAtom(requestNewBrowserSessionAtom);
 *   requestNewBrowserSession({});                       // blank tab
 *   requestNewBrowserSession({ isPrivate: true });      // incognito
 *   requestNewBrowserSession({ url: "react.dev" });    // open URL
 */
export const requestNewBrowserSessionAtom = atom(
  null,
  (
    get,
    set,
    payload: Omit<WorkstationNewBrowserSessionRequest, "tick"> = {}
  ) => {
    const prev = get(workstationNewBrowserSessionRequestAtom);
    set(workstationNewBrowserSessionRequestAtom, {
      tick: prev.tick + 1,
      url: payload.url,
      isPrivate: payload.isPrivate,
    });
  }
);
requestNewBrowserSessionAtom.debugLabel = "requestNewBrowserSessionAtom";

/** Project Manager publishes trailing TabBar actions for the Workstation strip */
export const workstationProjectTabBarAtom = atom<{
  onAddProject: () => void;
} | null>(null);
workstationProjectTabBarAtom.debugLabel = "workstationProjectTabBarAtom";

export const WORK_MANAGEMENT_SECTION = {
  KANBAN: "kanban",
  PROJECTS: "projects",
  INBOX: "inbox",
  GITHUB_ISSUES: "github-issues",
  GITHUB_PRS: "github-prs",
  RUNS: "runs",
} as const;

export type WorkManagementSection =
  (typeof WORK_MANAGEMENT_SECTION)[keyof typeof WORK_MANAGEMENT_SECTION];

export const WORK_MANAGEMENT_PROJECTS_VIEW = {
  PROJECTS: "projects",
  WORK_ITEMS: "work-items",
} as const;

export type WorkManagementProjectsView =
  (typeof WORK_MANAGEMENT_PROJECTS_VIEW)[keyof typeof WORK_MANAGEMENT_PROJECTS_VIEW];

export const workManagementProjectsViewAtom = atom<WorkManagementProjectsView>(
  WORK_MANAGEMENT_PROJECTS_VIEW.WORK_ITEMS
);
workManagementProjectsViewAtom.debugLabel = "workManagementProjectsViewAtom";

// ============================================
// Global tab-header strip (36px, full-width)
//
// Each My Station app pane publishes structured chrome for the global tab
// header (breadcrumb / URL bar / commit info / mode controls / filters) into a
// per-host slot. `AppShell` renders a single {@link WorkstationTabHeader} below
// the {@link WorkstationTabBar}; the header reads the active app's slot and
// renders it next to the sidebar toggle.
//
// Why per-host slots (not one shared slot): app modes are kept-alive (display:
// none) so multiple panes are mounted concurrently. Writing into a shared slot
// would race; per-host slots let each pane keep its content current
// independently.
// ============================================

export interface WorkstationTabHeaderSlots {
  leading?: ReactNode;
  content?: ReactNode;
  trailing?: ReactNode;
  sidebarToggleDisabled?: boolean;
  /** Hide shell-owned leading chrome when the published surface has no sidebar. */
  shellLeadingChromeHidden?: boolean;
  /** Visually joins this 40px header to a following pane-owned row. */
  joinWithFollowingRow?: boolean;
  /** The active split view renders its controls in the left column instead. */
  hidden?: boolean;
}

export type WorkstationTabHeaderContribution =
  | ReactNode
  | WorkstationTabHeaderSlots
  | null;

function isWorkstationTabHeaderSlots(
  contribution: WorkstationTabHeaderContribution
): contribution is WorkstationTabHeaderSlots {
  return (
    typeof contribution === "object" &&
    contribution !== null &&
    !Array.isArray(contribution) &&
    ("leading" in contribution ||
      "content" in contribution ||
      "trailing" in contribution ||
      "sidebarToggleDisabled" in contribution ||
      "shellLeadingChromeHidden" in contribution ||
      "joinWithFollowingRow" in contribution ||
      "hidden" in contribution)
  );
}

export function normalizeWorkstationTabHeaderContribution(
  contribution: WorkstationTabHeaderContribution
): WorkstationTabHeaderSlots | null {
  if (
    contribution === null ||
    contribution === undefined ||
    typeof contribution === "boolean"
  ) {
    return null;
  }
  if (isWorkstationTabHeaderSlots(contribution)) return contribution;
  return { content: contribution };
}

const codeWorkstationTabHeaderAtom = atom<WorkstationTabHeaderSlots | null>(
  null
);
codeWorkstationTabHeaderAtom.debugLabel = "codeWorkstationTabHeaderAtom";

const browserWorkstationTabHeaderAtom = atom<WorkstationTabHeaderSlots | null>(
  null
);
browserWorkstationTabHeaderAtom.debugLabel = "browserWorkstationTabHeaderAtom";

const dataWorkstationTabHeaderAtom = atom<WorkstationTabHeaderSlots | null>(
  null
);
dataWorkstationTabHeaderAtom.debugLabel = "dataWorkstationTabHeaderAtom";

const projectWorkstationTabHeaderAtom = atom<WorkstationTabHeaderSlots | null>(
  null
);
projectWorkstationTabHeaderAtom.debugLabel = "projectWorkstationTabHeaderAtom";

const workManagementWorkstationTabHeaderAtom =
  atom<WorkstationTabHeaderSlots | null>(null);
workManagementWorkstationTabHeaderAtom.debugLabel =
  "workManagementWorkstationTabHeaderAtom";

/**
 * Simulator (Agent Station replay) tab-header slot. Unlike the My Station
 * hosts above, only one simulator app is mounted at a time per session view
 * (Code Editor / Browser / DB / Project / Communication share this single
 * atom), so we don't split it per app — whichever simulator pane is active
 * publishes its header content here, and the simulator's own
 * `SimulatorWorkstationTabHeader` reads it directly (no `activeStatusBarApp`
 * indirection).
 */
const simulatorWorkstationTabHeaderAtom =
  atom<WorkstationTabHeaderSlots | null>(null);
simulatorWorkstationTabHeaderAtom.debugLabel =
  "simulatorWorkstationTabHeaderAtom";

export const workstationTabHeaderAtomByHost = {
  code: codeWorkstationTabHeaderAtom,
  browser: browserWorkstationTabHeaderAtom,
  data: dataWorkstationTabHeaderAtom,
  project: projectWorkstationTabHeaderAtom,
  workManagement: workManagementWorkstationTabHeaderAtom,
  simulator: simulatorWorkstationTabHeaderAtom,
} as const;

/**
 * Active app's tab-header content slot — readers (the global header strip)
 * should subscribe to this; writers (panes) should target their host slot
 * directly via {@link workstationTabHeaderAtomByHost}.
 */
export const activeWorkstationTabHeaderAtom =
  atom<WorkstationTabHeaderSlots | null>((get) => {
    const host = get(activeStatusBarAppAtom);
    return get(workstationTabHeaderAtomByHost[host]);
  });
activeWorkstationTabHeaderAtom.debugLabel = "activeWorkstationTabHeaderAtom";
