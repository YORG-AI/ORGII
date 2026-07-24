/** Compact turn shape retained by the bounded replay presentation. */
export interface ExternalReplayTurnSummary {
  turnId: string;
  nextTurnId: string | null;
  turnIndex: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  userPreview: string;
  eventCount: number;
  bodyEventCount: number;
}
