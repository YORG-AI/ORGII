/**
 * Rail collapse / width persistence and CI status-dot mapping.
 *
 * Storage is best-effort: the responsive control still works when
 * localStorage is unavailable, and every reader falls back to the shipped
 * defaults in `./trailWidth`.
 */
import type { BranchCiStatus } from "@src/services/git/branchPullRequestStatus";

const FOCUSED_CHAT_RAIL_COLLAPSED_KEY =
  "orgii:focusedChatWorkstationRailCollapsed";
const FOCUSED_CHAT_RAIL_WIDTH_KEY = "orgii:focusedChatWorkstationRailWidth";
const FOCUSED_CHAT_RAIL_MIN_WIDTH_KEY =
  "orgii:focusedChatWorkstationRailMinWidth";

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
    // The trail still resizes for this session when storage is unavailable.
  }
}

/** Persisted expanded width, or `null` when never set / unreadable. */
export function getStoredRailWidth(): number | null {
  return readStoredNumber(FOCUSED_CHAT_RAIL_WIDTH_KEY);
}

export function persistRailWidth(width: number): void {
  writeStoredNumber(FOCUSED_CHAT_RAIL_WIDTH_KEY, width);
}

/** Persisted user-set minimum width, or `null` when never set. */
export function getStoredRailMinWidth(): number | null {
  return readStoredNumber(FOCUSED_CHAT_RAIL_MIN_WIDTH_KEY);
}

export function persistRailMinWidth(minWidth: number): void {
  writeStoredNumber(FOCUSED_CHAT_RAIL_MIN_WIDTH_KEY, minWidth);
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
