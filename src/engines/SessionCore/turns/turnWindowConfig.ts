/**
 * Keep only the latest complete turn body resident on first open. Older
 * turns remain represented by lightweight headers/placeholders and are
 * fetched as the user navigates backwards. This bound matters for imported
 * CLI/Codex histories where one turn can contain hundreds of tool events.
 */
export const TURN_WINDOW_RECENT_BODY_COUNT = 1;
export const TURN_PAGE_PREFETCH_RADIUS = 1;
export const MAX_LOADED_HISTORICAL_TURN_BODIES = 8;
