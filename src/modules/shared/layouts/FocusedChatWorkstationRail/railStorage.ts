/**
 * Rail collapse persistence and CI status-dot mapping.
 *
 * Storage is best-effort: the responsive control still works when
 * localStorage is unavailable.
 */
import type { BranchCiStatus } from "@src/services/git/branchPullRequestStatus";

const FOCUSED_CHAT_RAIL_COLLAPSED_KEY =
  "orgii:focusedChatWorkstationRailCollapsed";

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
