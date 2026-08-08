export interface LoadTurnBodyIntoStoreArgs {
  sessionId: string;
  turnId: string;
}

export interface SessionTurnLoader {
  /**
   * Resolves true only when body events actually merged into the store.
   * "Nothing there yet" (e.g. a cloud replay still downloading behind a
   * turn-index skeleton) must resolve false so the turn is NOT marked
   * loaded and retry affordances stay armed.
   */
  loadTurnBodyIntoStore(args: LoadTurnBodyIntoStoreArgs): Promise<boolean>;
}
