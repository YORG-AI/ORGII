import { atom } from "jotai";

import type { StreamRetryStatus } from "@src/store/session/cliSessionStatusAtom";
import type { SubagentJobMap } from "@src/store/session/subagentJobAtom";
import type { CliSessionStatus } from "@src/types/session/session";

import { derivedSnapshotAtom } from "../core/atoms/events";
import { isInteractiveTool } from "../core/interactiveTools";
import {
  hasLiveRuntimeResourceInLatestTurn,
  hasRunningAwaitWaitForInLatestTurn,
} from "../core/runningEventGate";

/**
 * Stable noop atoms for scoped planning-indicator surfaces. When a
 * ChatHistory instance passes a session scope, the hook reads scoped
 * snapshot meta instead of the global pipeline atoms — these prevent
 * unrelated global subscriptions from waking scoped-only consumers.
 */
export const noopPlanningBooleanAtom = atom(false);
noopPlanningBooleanAtom.debugLabel = "planning/noopBoolean";

export const noopPlanningRuntimeStatusAtom = atom<CliSessionStatus>("idle");
noopPlanningRuntimeStatusAtom.debugLabel = "planning/noopRuntimeStatus";

export const noopPlanningVersionAtom = atom(0);
noopPlanningVersionAtom.debugLabel = "planning/noopVersion";

export const noopPlanningSessionIdAtom = atom<string | null>(null);
noopPlanningSessionIdAtom.debugLabel = "planning/noopSessionId";

export const noopSubagentJobMapAtom = atom<SubagentJobMap>(new Map());
noopSubagentJobMapAtom.debugLabel = "planning/noopSubagentJobMap";

export const noopStreamRetryStatusAtom = atom<StreamRetryStatus | null>(null);
noopStreamRetryStatusAtom.debugLabel = "planning/noopStreamRetryStatus";

/**
 * Stable derived atoms for the global planning-indicator booleans.
 *
 * Both atoms compute a boolean from `derivedSnapshotAtom`. Jotai only
 * notifies subscribers when the returned value changes, so components that
 * read these atoms re-render only when the state actually flips (e.g. a
 * running tool call completes) — NOT on every streamed token.
 *
 * Previously these computations lived as `useMemo` calls inside
 * `usePlanningIndicator`, which meant `ChatHistory/index.tsx` re-rendered on
 * every snapshot update (i.e. every token) because `derivedSnapshotAtom`
 * itself changed that frequently.
 */

/**
 * True when the latest agent turn has at least one live runtime resource
 * (e.g. a running shell process). Changes only when run state transitions,
 * not on every streaming token.
 */
export const globalAnyRunningAtom = atom((get) => {
  const snapshot = get(derivedSnapshotAtom);
  if (!snapshot || !("chatEvents" in snapshot)) return false;
  return hasLiveRuntimeResourceInLatestTurn(snapshot.chatEvents);
});
globalAnyRunningAtom.debugLabel = "planning/globalAnyRunning";

/**
 * True when the latest turn has a still-running `await_output` wait_for call.
 * Its own live "Waiting {countdown} for …" title already conveys activity, so
 * the planning footer is suppressed in this window to avoid two stacked
 * waiting indicators. Changes only when the wait_for starts/ends.
 */
export const globalHasRunningAwaitWaitForAtom = atom((get) => {
  const snapshot = get(derivedSnapshotAtom);
  if (!snapshot || !("chatEvents" in snapshot)) return false;
  return hasRunningAwaitWaitForInLatestTurn(snapshot.chatEvents);
});
globalHasRunningAwaitWaitForAtom.debugLabel =
  "planning/globalHasRunningAwaitWaitFor";

/**
 * True when there is a pending interactive tool call awaiting user input.
 * Changes only when an interactive event arrives or is processed, not on
 * every streaming token.
 */
export const globalHasAwaitingUserInteractionAtom = atom((get) => {
  const snapshot = get(derivedSnapshotAtom);
  if (!snapshot || !("events" in snapshot)) return false;
  return snapshot.events.some(
    (event) =>
      event.displayStatus === "awaiting_user" &&
      event.activityStatus !== "processed" &&
      isInteractiveTool(event.functionName)
  );
});
globalHasAwaitingUserInteractionAtom.debugLabel =
  "planning/globalHasAwaitingUserInteraction";
