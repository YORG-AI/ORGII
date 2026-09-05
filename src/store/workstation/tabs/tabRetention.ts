/**
 * Tab retention policy — the one place that says which WorkStation tabs are
 * PRESERVED (kept mounted but hidden after you leave them) and which are
 * REBUILT from stores on the next visit.
 *
 * Default is rebuild: a content host mounts only the active tab, and a tab
 * renderer that needs continuity keeps it in per-tab view state
 * (`tabViewState.ts`, `useTabViewState`). That is the right default for
 * surfaces that multiply (one xterm per terminal tab, one webview per
 * browser tab, twelve `ChatHistory` cells in a simulator grid) — hidden DOM
 * there grows without bound.
 *
 * A handful of tabs are visited constantly, exist once, and are cheap to
 * keep: the pinned Review (Source Control) pane and the Project Manager
 * list trio. Rebuilding those on every visit costs a lazy-chunk suspend, a
 * refetch, and a visible flash for no memory win. Those opt in here.
 *
 * To widen or narrow the preserved set, edit `RETAINED_TAB_TYPES` (and add
 * a pool if the new type should not share a window with an existing one).
 * Hosts pick up the change through `useRetainedTabPool`; the sidebar slot
 * keeps a retained tab's sidebar warm alongside its main pane.
 *
 * Retention is bounded, never monotonic: a pool keeps at most `maxWarm`
 * tabs and drops a tab left hidden for longer than `graceMs`, after which
 * it rebuilds from view state like any other tab.
 *
 * Contract for a type listed here: its renderer must gate side effects
 * (header publishing, focus, polling) on the `isActive` prop it receives,
 * because it stays mounted while another tab is on screen.
 */
import type { WorkStationTab, WorkStationTabType } from "./types";

export type RetentionPoolId = "source-control" | "project-trio";

export interface RetentionPool {
  id: RetentionPoolId;
  /** How long a hidden tab in this pool stays mounted after deactivation. */
  graceMs: number;
  /** Upper bound on mounted tabs in this pool, including the active one. */
  maxWarm: number;
}

export const RETENTION_POOLS: Readonly<Record<RetentionPoolId, RetentionPool>> =
  {
    /** The pinned Review tab: one instance, flipped to and from constantly. */
    "source-control": { id: "source-control", graceMs: 60_000, maxWarm: 1 },
    /**
     * Project Manager lists: two warm tabs cover the "compare two lists"
     * flip; each is a full non-virtualized table, so no more than that.
     */
    "project-trio": { id: "project-trio", graceMs: 60_000, maxWarm: 2 },
  };

/** Tab types that are preserved, and the pool whose window bounds them. */
const RETAINED_TAB_TYPES: Readonly<
  Partial<Record<WorkStationTabType, RetentionPoolId>>
> = {
  "source-control": "source-control",
  "project-workitems": "project-trio",
  "project-linear-projects": "project-trio",
  "project-linear-work-items": "project-trio",
};

/** The pool a tab type is preserved in, or `null` when it is rebuilt. */
export function getTabRetentionPool(
  tabType: WorkStationTabType
): RetentionPool | null {
  const poolId = RETAINED_TAB_TYPES[tabType];
  return poolId ? RETENTION_POOLS[poolId] : null;
}

export function isRetainedTabType(tabType: WorkStationTabType): boolean {
  return RETAINED_TAB_TYPES[tabType] !== undefined;
}

export function isTabInRetentionPool(
  tab: Pick<WorkStationTab, "type">,
  poolId: RetentionPoolId
): boolean {
  return RETAINED_TAB_TYPES[tab.type] === poolId;
}

/** Ids of the tabs in `tabs` that belong to `poolId`, in tab order. */
export function selectRetentionPoolTabIds(
  tabs: readonly Pick<WorkStationTab, "id" | "type">[],
  poolId: RetentionPoolId
): string[] {
  return tabs
    .filter((tab) => isTabInRetentionPool(tab, poolId))
    .map((tab) => tab.id);
}
