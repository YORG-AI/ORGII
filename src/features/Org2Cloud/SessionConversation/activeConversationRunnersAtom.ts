/**
 * Live overlay registry for in-flight member turns.
 *
 * A member's send runs the turn in an invisible one-shot local runner and
 * only publishes the agent tail to the plane at terminal — so without this,
 * even the SENDER stares at their own message with no thinking, no tools,
 * no "Agent worked for Ns" until the whole turn lands at once.
 *
 * The runner is LOCAL, so its events stream live through the normal
 * per-session events atom. This registry tells the conversation stream
 * which local runner sessions to tap and overlay while their turn is still
 * running. Once the plane carries the turn's `turnId` (the tail push
 * landed), the overlay is dropped in favour of the authoritative plane
 * rows — keyed by turnId so the swap never double-renders.
 *
 * "Carries the turn" means an AGENT row under that turnId: the user's own
 * message row is pushed under the same turnId BEFORE the runner exists, so
 * matching any row would drop the overlay the instant it registered.
 */
import { atom } from "jotai";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

export interface ActiveConversationRunner {
  runnerSessionId: string;
  /** The turnId the tail is pushed under — the plane-landed drop signal. */
  turnId: string;
}

/** plane rootSessionId → this device's in-flight member runners. */
export const activeConversationRunnersAtom = atom<
  Record<string, ActiveConversationRunner[]>
>({});
activeConversationRunnersAtom.debugLabel = "activeConversationRunnersAtom";

/** Plane turnIds whose agent tail has landed (a non-user row is present). */
export function collectLandedTurnIds(
  rows: readonly { turnId: string; event: Pick<SessionEvent, "source"> }[]
): Set<string> {
  const landed = new Set<string>();
  for (const row of rows) {
    if (row.event.source !== "user") landed.add(row.turnId);
  }
  return landed;
}

/** Runners still worth overlaying: their turn has no agent tail on the plane yet. */
export function selectActiveRunners(
  runners: readonly ActiveConversationRunner[],
  landedTurnIds: ReadonlySet<string>
): ActiveConversationRunner[] {
  return runners.filter((runner) => !landedTurnIds.has(runner.turnId));
}
