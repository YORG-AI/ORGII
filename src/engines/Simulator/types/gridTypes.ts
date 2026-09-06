/**
 * Grid Types for ActivitySimulatorGrid
 *
 * Shared types used across grid cell components, hooks, and utilities.
 */
import type { SessionEvent, SessionSpec } from "@src/engines/SessionCore";
import type { SimulatorGridLayout } from "@src/store/ui/simulatorAtom";

import type { AppType } from "./appTypes";

// ============================================
// Task Thread (multi-screen display)
// ============================================

export interface TaskThread {
  threadId: string;
  eventCount: number;
}

// ============================================
// Grid Cell Props
// ============================================

export interface GridCellProps {
  historyLoad?: import("../hooks/useMultiSessionSimulatorEvents").SubagentHistoryLoad;
  index: number;
  color: string;
  title: string;
  /**
   * Optional non-bold subtitle rendered after the title, separated by a
   * middle-dot (`·`). Used by subagent cells to show the agent name as
   * `title` and the current task description as `subtitle`.
   */
  subtitle?: string;
  events: SessionEvent[];
  specs: SessionSpec[];
  forceAppType?: AppType | null;
  /** Thread ID this cell is displaying (for multi-task mode) */
  threadId?: string;
  /** Use independent replay (for multi-task mode) */
  independentReplay?: boolean;
  /** Child session `session_type` from DB (subagent vs terminal, when known). */
  sessionType?: string;
  /**
   * External replay cursor (epoch ms) from the main simulator slider. When
   * provided and the cell is not user-detached, the cell's displayed event
   * follows this cursor via timestamp lookup (video-editor clip model).
   */
  externalCursorMs?: number | null;
  /**
   * Whether this cell should render the active-at-cursor highlight
   * (top accent bar + header tint) AND follow the main timeline cursor.
   * Computed by the parent: true when the main replay cursor falls inside
   * this subagent's active time window (± HIGHLIGHT_LEAD_MS).
   */
  isHighlighted?: boolean;
  /** Whether this cell is currently in full-screen expanded mode. */
  isExpanded?: boolean;
  /** Called when the user clicks the expand / collapse button. */
  onExpand?: () => void;
  /**
   * Backend-authoritative liveness of the cell's session (clip still
   * open — `endedAtMs === null`). Drives the session-scoped planning
   * footer inside the cell's chat pane so the last block never sits
   * static while the subagent is still working. Defaults to false
   * (no footer) when unknown.
   */
  isSessionLive?: boolean;
}

// ============================================
// Main Grid Props
// ============================================

export interface ActivitySimulatorGridProps {
  /** Current grid layout */
  layout?: SimulatorGridLayout;
  /** Selected current event (optional) */
  currentEvent?: SessionEvent | null;
  /** All events for lookup */
  events?: SessionEvent[];
  /** Specs */
  specs?: SessionSpec[];
  /** Free-switch mode: force display of a specific app type */
  forceAppType?: AppType | null;
  /** Task threads for multi-screen display (each cell shows different task) */
  taskThreads?: TaskThread[];
  /** Selected thread ID for single-task mode (shows thread name as title) */
  selectedThreadId?: string | null;
}

// ============================================
// Internal Grid Cell Data (used by useGridLayout)
// ============================================

export interface GridCellData {
  index: number;
  color: string;
  title: string;
  threadId?: string;
  eventCount: number;
}
