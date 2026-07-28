export type TimelineBoundaryReason = "stop" | "force-send" | "rewind";

export interface RewindInterruptSignals {
  turnActive: boolean;
  hasLiveSubagents: boolean;
}

/**
 * Resolve boundary interruption from signals belonging to the target session.
 * Rewind must not consult global UI status, which may describe another session.
 */
export function shouldInterruptTimelineBoundary(
  reason: TimelineBoundaryReason,
  signals: RewindInterruptSignals
): boolean {
  if (reason !== "rewind") return true;
  return signals.turnActive || signals.hasLiveSubagents;
}
