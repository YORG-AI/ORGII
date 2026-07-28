/**
 * diffSessionReplay.tabIds
 *
 * Stable string ids for the Diff replay app's top-level tabs, plus the
 * reverse lookup `SimulatorReplayChrome`'s `onTabClick` handler uses to map
 * a clicked tab id back to a `DiffReplayTab`.
 */
import type { DiffReplayTab } from "./types";

export const TAB_IDS: Record<DiffReplayTab, string> = {
  all: "diff-tab:all",
  diff: "diff-tab:diff",
  submissions: "diff-tab:submissions",
  requirements: "diff-tab:requirements",
};

export const TAB_BY_ID: Record<string, DiffReplayTab> = {
  [TAB_IDS.all]: "all",
  [TAB_IDS.diff]: "diff",
  [TAB_IDS.submissions]: "submissions",
  [TAB_IDS.requirements]: "requirements",
};
