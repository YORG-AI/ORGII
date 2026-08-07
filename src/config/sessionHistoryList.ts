/**
 * Session history list — shared limits for chat panel, Workstation chat sidebar,
 * and any UI that lists sessions with "load more" pagination.
 *
 * Fetch size applies to flat history; visible counts apply to client-side slicing.
 */

/** Page size for `loadSessions({ limit })` when loading the history cache */
export const SESSION_HISTORY_FETCH_LIMIT = 50;

/** Time buckets (today / yesterday / …) in chat history: initial rows per bucket; "this hour" is not capped */
export const SESSION_HISTORY_TIME_BUCKET_INITIAL_COUNT = 5;

/** Time buckets: rows added per "load more" within a bucket */
export const SESSION_HISTORY_TIME_BUCKET_INCREMENT = 5;

/** Grouped lists (by agent category or by date bucket): initial rows per group */
export const SESSION_HISTORY_GROUP_INITIAL_COUNT = 10;

/** Grouped lists: rows added per "load more" within a group */
export const SESSION_HISTORY_GROUP_INCREMENT = 10;
