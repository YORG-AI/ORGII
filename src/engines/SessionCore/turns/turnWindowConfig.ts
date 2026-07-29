/**
 * Keep only the latest complete turn body resident on first open. Older
 * turns remain represented by lightweight headers/placeholders and are
 * fetched as the user navigates backwards. This bound matters for imported
 * CLI/Codex histories where one turn can contain hundreds of tool events.
 */
export const TURN_WINDOW_RECENT_BODY_COUNT = 1;
export const TURN_PAGE_PREFETCH_RADIUS = 1;
export const MAX_LOADED_HISTORICAL_TURN_BODIES = 8;
export const MAX_LOADED_CODEX_HISTORICAL_TURN_BODIES = 1;

/**
 * Forward-prefetch radius (in distinct turns) for the Workstation
 * Communication ("Messages") replay surface. As the playback cursor
 * advances through an imported history, each newly-revealed unloaded turn
 * would otherwise show a "Loading message…" beat (`UnloadedTurnBubble`)
 * until its body round-trips. Warming the next `REPLAY_TURN_PREFETCH_AHEAD`
 * distinct turns *before* the cursor reaches them keeps continuous
 * playback beat-free. See `useReplayTurnPrefetch`
 * (src/modules/WorkStation/Chat/Communication/hooks/useReplayTurnPrefetch.ts).
 */
export const REPLAY_TURN_PREFETCH_AHEAD = 2;
