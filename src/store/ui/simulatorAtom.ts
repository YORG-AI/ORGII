import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import { SIMULATOR_PRIMARY_SIDEBAR } from "@src/config/simulatorPrimarySidebar";
import {
  REPLAY_SPEED_OPTIONS,
  type ReplaySpeed,
} from "@src/config/workspace/replayConfig";
import type { SimulatorEventFilterValue } from "@src/engines/SessionCore/core/types";
import type { SubagentSession } from "@src/engines/Simulator/hooks/useSubagentSessions";
import type { AppType } from "@src/engines/Simulator/types/appTypes";
import { STATION_MODES, type StationMode } from "@src/types/ui/workstation";
import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

export { STATION_MODE, type StationMode } from "@src/types/ui/workstation";

// ============================================
// Activity Simulator Settings Atoms
// Global state for simulator display settings
// ============================================

const SIMULATOR_GRID_LAYOUTS = [
  "1x1",
  "1x2",
  "2x1",
  "2x2",
  "2x3",
  "3x3",
  "4x2",
  "3x4",
] as const;

export type SimulatorGridLayout = (typeof SIMULATOR_GRID_LAYOUTS)[number];

const SimulatorGridLayoutSchema = z.enum(SIMULATOR_GRID_LAYOUTS);

/**
 * Simulator grid layout setting
 */
export const simulatorLayoutAtom = atomWithStorage<SimulatorGridLayout>(
  "simulatorLayout",
  "1x1",
  createZodJsonStorage(SimulatorGridLayoutSchema)
);
simulatorLayoutAtom.debugLabel = "simulatorLayoutAtom";

/**
 * Auto layout mode - automatically adjust grid based on task count
 */
export const simulatorAutoLayoutAtom = atomWithStorage<boolean>(
  "simulatorAutoLayout",
  true
);
simulatorAutoLayoutAtom.debugLabel = "simulatorAutoLayoutAtom";

/**
 * Simulator show dock setting
 */
export const simulatorShowDockAtom = atomWithStorage<boolean>(
  "simulatorShowDock",
  true,
  createZodJsonStorage(z.boolean())
);
simulatorShowDockAtom.debugLabel = "simulatorShowDockAtom";

/**
 * Cell replay state for multi-task grid
 * Persists currentIndex for each threadId so state survives view switches
 * Key: threadId, Value: { currentIndex, isPlaying, hasUserOverride }
 *
 * `hasUserOverride` flips to `true` when the user manually controls a cell
 * (play, pause, drag progress, step prev/next, etc.). When true, the cell
 * ignores the main replay cursor and uses its own local index. A resync
 * action clears the flag and returns the cell to sync mode.
 */
export interface CellReplayPersistState {
  currentIndex: number;
  isPlaying: boolean;
  hasUserOverride?: boolean;
}
export const cellReplayStatesAtom = atom<
  Record<string, CellReplayPersistState>
>({});
cellReplayStatesAtom.debugLabel = "cellReplayStatesAtom";

/**
 * Global replay control for multi-task grid
 * When triggered, all cells start/stop playing simultaneously
 */
export interface GlobalReplayState {
  /** Whether global playback is active */
  isPlaying: boolean;
  /** Timestamp when play was triggered (used to sync cells) */
  triggerTime: number;
  /** Playback speed multiplier */
  speed: number;
}
export const globalReplayStateAtom = atom<GlobalReplayState>({
  isPlaying: false,
  triggerTime: 0,
  speed: 1,
});
globalReplayStateAtom.debugLabel = "globalReplayStateAtom";

/**
 * Simulator data source. Only `"real"` is currently produced — the atom is
 * kept (instead of inlined) so that future replay sources (mock fixtures,
 * recorded sessions, etc.) can plug in without rewiring every consumer.
 */
export const simulatorDataSourceAtom = atom<"real">("real");
simulatorDataSourceAtom.debugLabel = "simulatorDataSourceAtom";

/**
 * Selected app type for free-switching in simulator.
 * When set, the simulator shows the last event for this app type
 * at or before the current replay position.
 * null = follow mode (show currentEvent)
 */
export const simulatorSelectedAppAtom = atom<AppType | null>(null);
simulatorSelectedAppAtom.debugLabel = "simulatorSelectedAppAtom";

export const simulatorIdeTerminalRevealRequestAtom = atom<number>(0);
simulatorIdeTerminalRevealRequestAtom.debugLabel =
  "simulatorIdeTerminalRevealRequestAtom";

/**
 * Effective dock active app — the app the dock is actually highlighting.
 * Combines user selection (simulatorSelectedAppAtom) with event-derived app type.
 * Written by ActivitySimulator so the toolbar can mirror the dock state.
 */
export const simulatorEffectiveDockAppAtom = atom<AppType | null>(null);
simulatorEffectiveDockAppAtom.debugLabel = "simulatorEffectiveDockAppAtom";

/**
 * Free-browse (replay-mode) app filter.
 *
 * - `null` → "All apps": the dock highlights whatever app the current
 *   event maps to as the user scrubs through history.
 * - `AppType.X` → "This app": only events whose mapped app == X are
 *   surfaced; the simulator stays on X regardless of the current
 *   event's natural app.
 *
 * Only written from the status-bar `FollowModeDropdown` in its
 * `variant="replay"` form. In follow mode there is no target to
 * switch — agent is the only target — so the lock is irrelevant
 * (and the follow-mode pill renders static "Following Agent" text
 * instead of a dropdown). Cleared on session reset.
 */
export const simulatorFollowAppLockAtom = atom<AppType | null>(null);
simulatorFollowAppLockAtom.debugLabel = "simulatorFollowAppLockAtom";

export const simulatorEventFiltersAtom = atom<SimulatorEventFilterValue[]>([]);
simulatorEventFiltersAtom.debugLabel = "simulatorEventFiltersAtom";

export interface SimulatorDiffCommitNavigationRequest {
  sessionId?: string | null;
  commitSha: string;
  nonce: number;
}

export const simulatorDiffCommitNavigationRequestAtom =
  atom<SimulatorDiffCommitNavigationRequest | null>(null);
simulatorDiffCommitNavigationRequestAtom.debugLabel =
  "simulatorDiffCommitNavigationRequestAtom";

/**
 * Per-round Diff scope request.
 *
 * Set by the chat `TurnMetadataFooter` so Agent Station can focus a file from
 * that round inside the cumulative whole-session diff. `null` (the default,
 * and what `openAgentStationDiff` resets it to) means no focus request.
 *
 * - `filePaths` — the round's modified file paths (the scope set).
 * - `selectedPath` — optional clicked row, scrolled/focused on open.
 * - `sessionId` — the round's session; the Diff app ignores the scope when
 *   it doesn't match the session currently being viewed (session switch).
 * - `nonce` — bumped on every set so re-clicking the same file re-focuses.
 */
export interface SimulatorDiffScopeRequest {
  sessionId?: string | null;
  turnId?: string | null;
  filePaths: string[];
  selectedPath?: string | null;
  nonce: number;
}

export const simulatorDiffScopeRequestAtom =
  atom<SimulatorDiffScopeRequest | null>(null);
simulatorDiffScopeRequestAtom.debugLabel = "simulatorDiffScopeRequestAtom";

/**
 * Diff-app refresh signal — a monotonically increasing nonce bumped whenever
 * the user navigates *into* the Agent Station Diff app from chat (the per-round
 * `TurnMetadataFooter` "Review"/file-row click, or the composer "files" pill in
 * `ChatView.openAgentStationDiff`).
 *
 * The Diff app caches its canonical Orgtrack final diffs per session, so a
 * file edited after the cache was warmed would otherwise render a stale diff
 * (e.g. round 2 appends `test2` but the view still shows only round 1's
 * `test1`). The Diff app re-reads its underlying diff data when this nonce
 * changes, so navigating in always reflects the latest working-tree state.
 *
 * Bump it via `bumpSimulatorDiffRefreshNonceAtom` (a write-only helper) so
 * callers never have to read the current value. Tied to explicit navigation —
 * not render cycles — so it cannot cause a refetch loop.
 */
export const simulatorDiffRefreshNonceAtom = atom<number>(0);
simulatorDiffRefreshNonceAtom.debugLabel = "simulatorDiffRefreshNonceAtom";

export const bumpSimulatorDiffRefreshNonceAtom = atom(null, (get, set) => {
  set(simulatorDiffRefreshNonceAtom, get(simulatorDiffRefreshNonceAtom) + 1);
});
bumpSimulatorDiffRefreshNonceAtom.debugLabel =
  "bumpSimulatorDiffRefreshNonceAtom";

/**
 * Playback speed for simulator replay (grid cells).
 * Matches replay bar options: 0.25x–6x; default 1x.
 */
export type SimulatorPlaybackSpeed = ReplaySpeed;
const SimulatorPlaybackSpeedSchema = z.literal(REPLAY_SPEED_OPTIONS);

export const simulatorPlaybackSpeedAtom =
  atomWithStorage<SimulatorPlaybackSpeed>(
    "simulatorPlaybackSpeed",
    1,
    createZodJsonStorage(SimulatorPlaybackSpeedSchema),
    { getOnInit: true }
  );
simulatorPlaybackSpeedAtom.debugLabel = "simulatorPlaybackSpeedAtom";

/**
 * Auto-scroll setting for simulator replay.
 * When enabled, content auto-scrolls during playback.
 */
export const simulatorAutoScrollAtom = atomWithStorage<boolean>(
  "simulatorAutoScroll",
  true,
  createZodJsonStorage(z.boolean()),
  { getOnInit: true }
);
simulatorAutoScrollAtom.debugLabel = "simulatorAutoScrollAtom";

// ============================================
// Station Mode — switches the right-side WorkStation surface between live
// tools and the agent simulator. Chat-panel maximization is a separate axis.
// ============================================

const StationModeSchema = z.enum(STATION_MODES);

export const stationModeAtom = atomWithStorage<StationMode>(
  "stationMode",
  "my-station",
  createZodJsonStorage(StationModeSchema),
  { getOnInit: true }
);
stationModeAtom.debugLabel = "stationModeAtom";

/**
 * Shared primary-sidebar collapsed state for Agent Station's session-replay
 * surfaces (Code Editor replay, Browser replay, Chat Communication).
 *
 * These are read-only "drill-down" views where the viewport matters more
 * than the rail, so the sidebar defaults to CLOSED and one state is shared
 * across them.
 */
export const simulatorReplaySidebarCollapsedAtom = atomWithStorage<boolean>(
  "simulatorReplaySidebarCollapsed",
  true,
  createZodJsonStorage(z.boolean())
);
simulatorReplaySidebarCollapsedAtom.debugLabel =
  "simulatorReplaySidebarCollapsedAtom";

/**
 * Router atom for simulator replay sidebar chrome.
 */
export const simulatorPrimarySidebarCollapsedAtom = atom<
  boolean,
  [boolean | "toggle" | ((prev: boolean) => boolean)],
  void
>(
  (get) => get(simulatorReplaySidebarCollapsedAtom),
  (get, set, next) => {
    const prev = get(simulatorReplaySidebarCollapsedAtom);
    const value =
      next === "toggle"
        ? !prev
        : typeof next === "function"
          ? next(prev)
          : next;
    set(simulatorReplaySidebarCollapsedAtom, value);
  }
);
simulatorPrimarySidebarCollapsedAtom.debugLabel =
  "simulatorPrimarySidebarCollapsedAtom";

/**
 * Which side the sidebar sits on inside simulator apps.
 * "left" (default) or "right" — toggled via the ArrowLeftRight button.
 */
export const simulatorPrimarySidebarPositionAtom = atom<"left" | "right">(
  "left"
);
simulatorPrimarySidebarPositionAtom.debugLabel =
  "simulatorPrimarySidebarPositionAtom";

/**
 * Persisted width of the simulator primary sidebar (CodeEditor / Chat / Browser
 * session replay views). Separate from the live Workstation left panel so the
 * replay UIs can have their own default (200px) without affecting My Station.
 *
 * Clamped to SIMULATOR_PRIMARY_SIDEBAR.minWidth .. maxWidth on write via the
 * persist atom below.
 */
export const simulatorPrimarySidebarWidthAtom = atomWithStorage<number>(
  "simulatorPrimarySidebarWidth",
  SIMULATOR_PRIMARY_SIDEBAR.defaultWidth,
  createZodJsonStorage(z.number())
);
simulatorPrimarySidebarWidthAtom.debugLabel =
  "simulatorPrimarySidebarWidthAtom";

/**
 * Write-side wrapper that clamps incoming widths into the allowed range before
 * persisting. Matches the pattern used by workStationPrimarySidebarWidthPersistAtom.
 */
export const simulatorPrimarySidebarWidthPersistAtom = atom(
  (get) => get(simulatorPrimarySidebarWidthAtom),
  (_get, set, value: number) => {
    const { minWidth, maxWidth } = SIMULATOR_PRIMARY_SIDEBAR;
    const clamped = Math.max(minWidth, Math.min(maxWidth, value));
    set(simulatorPrimarySidebarWidthAtom, clamped);
  }
);
simulatorPrimarySidebarWidthPersistAtom.debugLabel =
  "simulatorPrimarySidebarWidthPersistAtom";

/**
 * Session replay auto-play is active (SimulatorStatusBar play/pause).
 * Drives SimulatorSingleView breathing highlight during free-browse playback (with follow highlight enabled).
 */
export const simulatorSessionPlaybackPlayingAtom = atom<boolean>(false);
simulatorSessionPlaybackPlayingAtom.debugLabel =
  "simulatorSessionPlaybackPlayingAtom";

/**
 * When the session chat panel is hidden, whether the inline composer above the dock is collapsed.
 * false = input row visible; true = hidden (open via chat icon in SimulatorStatusBar).
 */
export const simulatorInlineChatInputCollapsedAtom = atom<boolean>(true);
simulatorInlineChatInputCollapsedAtom.debugLabel =
  "simulatorInlineChatInputCollapsedAtom";

/**
 * Whether the MiniCPM step explanation card is visible above replay controls.
 * The floating replay controls can reveal it again after the user closes it.
 */
export const simulatorMiniCPMStepExplanationVisibleAtom = atom<boolean>(false);
simulatorMiniCPMStepExplanationVisibleAtom.debugLabel =
  "simulatorMiniCPMStepExplanationVisibleAtom";

/**
 * Whether the caption bar — which surfaces the latest agent text message
 * of the current turn in Agent Station chrome — is enabled. Persisted via
 * localStorage so the choice survives reloads.
 * Defaults to on so session context is visible immediately.
 */
export const simulatorCaptionBarEnabledAtom = atomWithStorage<boolean>(
  "orgii:simulator:captionBarEnabled:v2",
  true,
  createZodJsonStorage(z.boolean())
);
simulatorCaptionBarEnabledAtom.debugLabel = "simulatorCaptionBarEnabledAtom";

/**
 * Focused subagent cell in the simulator grid.
 * Set when a SubagentBlock header is clicked in the chat panel —
 * the grid highlights the matching cell with a ring.
 * null = no cell focused (default).
 */
export const focusedSubagentCellAtom = atom<string | null>(null);
focusedSubagentCellAtom.debugLabel = "focusedSubagentCellAtom";

/**
 * Incremented whenever the user clicks the "locate" icon on a SubagentBlock.
 * ActivitySimulator watches this to re-open the subagent split pane if it
 * was previously dismissed by the user.
 */
export const subagentPanelRevealRequestAtom = atom<number>(0);
subagentPanelRevealRequestAtom.debugLabel = "subagentPanelRevealRequestAtom";

/**
 * All child subagent sessions for the current parent session.
 * Written by ActivitySimulator from `allSubagentSessions` (DB-sourced),
 * read by SessionReplayMessages to inline SubagentChip rows in the chat
 * transcript. Uses SubagentSession directly — no separate type needed.
 */
export const simulatorSubagentSessionsAtom = atom<SubagentSession[]>([]);
simulatorSubagentSessionsAtom.debugLabel = "simulatorSubagentSessionsAtom";

/**
 * Whether the subagent panel is in picture-in-picture (mini) mode.
 * When true, the full-width BackgroundTasksApp is replaced by a floating
 * mini card in the bottom-right corner, preserving visibility without
 * consuming the full workspace area.
 */
export const subagentPanelPipModeAtom = atom<boolean>(false);
subagentPanelPipModeAtom.debugLabel = "subagentPanelPipModeAtom";
