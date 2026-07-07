export type TimelineBoundaryReason = "stop" | "force-send" | "rewind";

export interface RewindInterruptSignals {
  turnActive: boolean;
  hasLiveSubagents: boolean;
}

/**
 * Whether a rewind boundary should call the backend interrupt for this
 * session. Session-scoped only — must not consult global UI mirrors that
 * reflect whichever session the user is currently viewing.
 */
export function shouldInterruptRewindBoundary(
  signals: RewindInterruptSignals
): boolean {
  return signals.turnActive || signals.hasLiveSubagents;
}

export function resolveShouldInterruptForTimelineBoundary(
  reason: TimelineBoundaryReason,
  signals: RewindInterruptSignals
): boolean {
  if (reason !== "rewind") return true;
  return shouldInterruptRewindBoundary(signals);
}
