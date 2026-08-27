import { atom } from "jotai";

export type RuntimeOrganizationView = "today" | "members" | "sync";
export type RuntimePersonalView =
  | "usage"
  | "profile"
  | "quota"
  | "scanning"
  | "hooks"
  | "assets";

/**
 * One-shot navigation request for opening Runtime at a specific surface. The
 * Runtime panel consumes and clears it once the requested scope is available,
 * so reopening Runtime later preserves the user's own selection instead of
 * replaying an old navigation action.
 *
 * The scope discriminant mirrors the panel's own split: an organization intent
 * also switches the scope picker to that cloud org, a personal intent switches
 * it back to the personal scope.
 */
export interface RuntimeOrganizationNavigationIntent {
  requestId: number;
  scope: "organization";
  orgId: string;
  view: RuntimeOrganizationView;
}

interface RuntimePersonalNavigationIntent {
  requestId: number;
  scope: "personal";
  view: RuntimePersonalView;
}

type RuntimeNavigationIntent =
  | RuntimeOrganizationNavigationIntent
  | RuntimePersonalNavigationIntent;

export const runtimeNavigationIntentAtom = atom<RuntimeNavigationIntent | null>(
  null
);
runtimeNavigationIntentAtom.debugLabel = "runtimeNavigationIntentAtom";

let lastRuntimeNavigationRequestId = 0;

/**
 * Monotonic id for a fresh navigation request. Clock-seeded so an intent
 * written before a remount still outranks one left over from the previous
 * mount, and counter-bumped so two requests inside the same millisecond stay
 * distinguishable.
 */
function nextRuntimeNavigationRequestId(): number {
  lastRuntimeNavigationRequestId = Math.max(
    lastRuntimeNavigationRequestId + 1,
    Date.now()
  );
  return lastRuntimeNavigationRequestId;
}

/** Open Runtime on the personal Scanning tab (external-source inventory). */
export function createRuntimeScanningNavigationIntent(): RuntimePersonalNavigationIntent {
  return {
    requestId: nextRuntimeNavigationRequestId(),
    scope: "personal",
    view: "scanning",
  };
}
