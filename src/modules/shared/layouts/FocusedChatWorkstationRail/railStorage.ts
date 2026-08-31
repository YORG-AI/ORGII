/**
 * Rail collapse / terminal size persistence and CI status-dot mapping.
 *
 * Storage is best-effort: the responsive control still works when
 * localStorage is unavailable, and every reader falls back to the shipped
 * defaults in the terminal size model.
 */
import type { BranchCiStatus } from "@src/services/git/branchPullRequestStatus";

const FOCUSED_CHAT_RAIL_COLLAPSED_KEY =
  "orgii:focusedChatWorkstationRailCollapsed";
const TRAIL_TERMINAL_WIDTH_KEY = "orgii:workstationTrailTerminalWidth";
const TRAIL_TERMINAL_HEIGHT_KEY = "orgii:workstationTrailTerminalHeight";

function readStoredNumber(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // The terminal still resizes for this session when storage is unavailable.
  }
}

export function getStoredTrailTerminalWidth(): number | null {
  return readStoredNumber(TRAIL_TERMINAL_WIDTH_KEY);
}

export function getStoredTrailTerminalHeight(): number | null {
  return readStoredNumber(TRAIL_TERMINAL_HEIGHT_KEY);
}

export function persistTrailTerminalSize(width: number, height: number): void {
  writeStoredNumber(TRAIL_TERMINAL_WIDTH_KEY, width);
  writeStoredNumber(TRAIL_TERMINAL_HEIGHT_KEY, height);
}

export function getStoredRailCollapsed(): boolean {
  try {
    return localStorage.getItem(FOCUSED_CHAT_RAIL_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function persistRailCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(FOCUSED_CHAT_RAIL_COLLAPSED_KEY, String(collapsed));
  } catch {
    // The responsive control still works when storage is unavailable.
  }
}

export function resolveRailStatusDotClass(state: BranchCiStatus): string {
  switch (state) {
    case "success":
      return "bg-success-6";
    case "failure":
      return "bg-danger-6";
    case "checking":
    case "pending":
      return "animate-pulse bg-warning-6";
    default:
      return "bg-fill-3";
  }
}
