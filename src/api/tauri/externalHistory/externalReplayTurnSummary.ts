/** Compact turn shape retained by the bounded replay presentation. */
export interface ExternalReplayTurnSummary {
  /** Backend locator used by bounded replay read requests. */
  turnId: string;
  /**
   * User SessionEvent id that owns the rendered chat group for this turn.
   * Provider turn locators and normalized event ids are separate identities
   * for sources such as Codex, so presentation code must not compare them.
   */
  renderedUserEventId: string | null;
  nextTurnId: string | null;
  turnIndex: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  userPreview: string;
  eventCount: number;
  bodyEventCount: number;
}
