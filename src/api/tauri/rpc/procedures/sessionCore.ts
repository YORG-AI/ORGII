import { z } from "zod/v4";

import { defineProcedure } from "../invoke";
import * as schemas from "../schemas";
import { snakeToCamel } from "../transforms";

const cache = {
  saveEvents: defineProcedure("cache_save_session_events")
    .input(schemas.sessionCore.SaveEventsInput)
    .build(),

  loadEvents: defineProcedure("cache_load_session_events")
    .input(schemas.sessionCore.SessionIdInput)
    .output(schemas.sessionCore.SessionEventArraySchema)
    .build(),

  saveCachedEvents: defineProcedure("cache_save_events")
    .input(schemas.sessionCore.SaveCachedEventsInput)
    .build(),

  loadCachedEvents: defineProcedure("cache_load_native_cached_events")
    .input(schemas.sessionCore.SessionIdInput)
    .output(schemas.sessionCore.CachedEventRowsSchema)
    .build(),

  loadTurnIndex: defineProcedure("orgtrack_session_turn_metadata_index")
    .input(schemas.sessionCore.TurnMetadataIndexInput)
    .output(z.array(schemas.sessionCore.TurnSummarySchema))
    .build(),

  searchEvents: defineProcedure("cache_search_session_events")
    .input(schemas.sessionCore.SearchEventsInput)
    .output(z.array(schemas.sessionCore.SearchResultSchema))
    .build(),

  searchAllSessions: defineProcedure("cache_search_all_sessions")
    .input(schemas.sessionCore.SearchAllSessionsInput)
    .output(z.array(schemas.sessionCore.CrossSessionSearchHitSchema))
    .build(),

  loadTurnBody: defineProcedure("cache_load_session_turn_body")
    .input(schemas.sessionCore.TurnBodyWindowInput)
    .output(schemas.sessionCore.TurnBodyWindowSchema)
    .build(),

  loadInitialTurnWindow: defineProcedure(
    "cache_load_session_initial_turn_window"
  )
    .input(schemas.sessionCore.InitialTurnWindowInput)
    .output(schemas.sessionCore.InitialTurnWindowSchema)
    .build(),

  getSessionMetadata: defineProcedure("cache_get_session_metadata")
    .input(schemas.sessionCore.SessionIdInput)
    .output(schemas.sessionCore.SessionMetadataSchema.nullable())
    .build(),

  deleteSession: defineProcedure("cache_delete_session")
    .input(schemas.sessionCore.SessionIdInput)
    .build(),

  clearOldSessions: defineProcedure("cache_clear_old_sessions")
    .input(schemas.sessionCore.ClearOldSessionsInput)
    .output(z.number())
    .build(),

  getAllSessions: defineProcedure("cache_get_all_sessions")
    .output(z.array(schemas.sessionCore.SessionMetadataSchema))
    .build(),

  getStats: defineProcedure("cache_get_stats")
    .output(schemas.sessionCore.CacheStatsSchema)
    .build(),

  saveFullSession: defineProcedure("cache_save_full_session")
    .input(schemas.sessionCore.SaveFullSessionInput)
    .build(),

  loadFullSession: defineProcedure("cache_load_full_session")
    .input(schemas.sessionCore.SessionIdInput)
    .output(schemas.sessionCore.FullSessionPayloadSchema.nullable())
    .build(),

  truncateAfterEvent: defineProcedure("cache_truncate_after_event")
    .input(schemas.sessionCore.EventIdInput)
    .output(schemas.sessionCore.TruncateResultSchema)
    .build(),

  deleteEvent: defineProcedure("cache_delete_event")
    .input(schemas.sessionCore.EventIdInput)
    .output(z.boolean())
    .build(),

  updateEvent: defineProcedure("cache_update_session_event")
    .input(schemas.sessionCore.UpdateCacheEventInput)
    .output(z.boolean())
    .build(),

  clearSessionHistory: defineProcedure("cache_clear_session_history")
    .input(schemas.sessionCore.SessionIdInput)
    .output(schemas.sessionCore.TruncateResultSchema)
    .build(),

  getEvent: defineProcedure("cache_get_session_event")
    .input(schemas.sessionCore.EventIdInput)
    .output(schemas.sessionCore.SessionEventSchema.nullable())
    .build(),

  loadEventPayload: defineProcedure("cache_load_event_payload")
    .input(schemas.sessionCore.EventPayloadInput)
    .output(schemas.sessionCore.EventPayloadBodySchema.nullable())
    .build(),
} as const;

const eventStore = {
  set: defineProcedure("es_set").input(schemas.sessionCore.EventsInput).build(),
  append: defineProcedure("es_append")
    .input(schemas.sessionCore.EventsInput)
    .build(),
  upsert: defineProcedure("es_upsert")
    .input(schemas.sessionCore.EventInput)
    .build(),
  updateById: defineProcedure("es_update_by_id")
    .input(schemas.sessionCore.UpdateByIdInput)
    .output(z.boolean())
    .build(),
  mergeEvents: defineProcedure("es_merge_events")
    .input(schemas.sessionCore.EventsInput)
    .build(),
  mergeRoundWindowEvents: defineProcedure("es_merge_round_window_events")
    .input(schemas.sessionCore.EventsInput)
    .build(),
  setStreaming: defineProcedure("es_set_streaming")
    .input(schemas.sessionCore.StreamingInput)
    .build(),
  clear: defineProcedure("es_clear")
    .input(schemas.sessionCore.NullableSessionIdInput)
    .build(),
  truncateBeforeId: defineProcedure("es_truncate_before_id")
    .input(schemas.sessionCore.TruncateBeforeIdInput)
    .output(z.boolean())
    .build(),
  switchSession: defineProcedure("es_switch_session")
    .input(schemas.sessionCore.SessionIdInput)
    .output(z.boolean())
    .build(),
  pinSession: defineProcedure("es_pin_session")
    .input(schemas.sessionCore.SessionIdInput)
    .build(),
  unpinSession: defineProcedure("es_unpin_session")
    .input(schemas.sessionCore.SessionIdInput)
    .build(),
  evictSession: defineProcedure("es_evict_session")
    .input(schemas.sessionCore.SessionIdInput)
    .build(),
  bufferEvents: defineProcedure("es_buffer_events")
    .input(schemas.sessionCore.BufferEventsInput)
    .build(),
  getSnapshot: defineProcedure("es_get_snapshot")
    .input(schemas.sessionCore.NullableSessionIdInput)
    .output(schemas.sessionCore.DerivedSnapshotSchema)
    .build(),
  getEvents: defineProcedure("es_get_events")
    .input(schemas.sessionCore.NullableSessionIdInput)
    .output(schemas.sessionCore.SessionEventArraySchema)
    .build(),
  extractEventDataWindow: defineProcedure("es_extract_event_data_window")
    .input(schemas.sessionCore.ExtractedEventDataWindowInput)
    .output(schemas.sessionCore.ExtractedEventDataPairsSchema)
    .build(),
  exportMarkdown: defineProcedure("es_export_markdown")
    .input(schemas.sessionCore.NullableSessionIdInput)
    .output(z.string())
    .build(),
  loadFromCache: defineProcedure("es_load_from_cache")
    .input(schemas.sessionCore.SessionIdInput)
    .output(z.number())
    .build(),
  loadInitialTurnWindow: defineProcedure("es_load_initial_turn_window")
    .input(schemas.sessionCore.InitialTurnWindowInput)
    .output(z.number())
    .build(),
  unloadTurnBody: defineProcedure("es_unload_turn_body")
    .input(schemas.sessionCore.TurnBodyWindowInput)
    .output(z.number())
    .build(),
  saveToCache: defineProcedure("es_save_to_cache")
    .input(schemas.sessionCore.SessionIdInput)
    .output(z.number())
    .build(),
  completeLastRunning: defineProcedure("es_complete_last_running")
    .input(schemas.sessionCore.NullableSessionIdInput)
    .output(z.string().nullable())
    .build(),
  patchByIds: defineProcedure("es_patch_by_ids")
    .input(schemas.sessionCore.PatchByIdsInput)
    .output(z.number())
    .build(),
  removeByIdPrefix: defineProcedure("es_remove_by_id_prefix")
    .input(schemas.sessionCore.RemoveByIdPrefixInput)
    .output(z.number())
    .build(),
  removeSyntheticUserInputs: defineProcedure("es_remove_synthetic_user_inputs")
    .input(schemas.sessionCore.NullableSessionIdInput)
    .output(z.number())
    .build(),
  replaceAndRemove: defineProcedure("es_replace_and_remove")
    .input(schemas.sessionCore.ReplaceAndRemoveInput)
    .output(z.boolean())
    .build(),
  updateActiveTaskArgs: defineProcedure("es_update_active_task_args")
    .input(schemas.sessionCore.UpdateActiveTaskArgsInput)
    .output(z.string().nullable())
    .build(),
  hasActiveTask: defineProcedure("es_has_active_task")
    .input(schemas.sessionCore.ActiveTaskInput)
    .output(z.boolean())
    .build(),
  mergeToolResults: defineProcedure("es_merge_tool_results")
    .input(schemas.sessionCore.MergeToolResultsInput)
    .output(schemas.sessionCore.SessionEventArraySchema)
    .build(),
  processChunks: defineProcedure("es_process_chunks")
    .input(schemas.sessionCore.ProcessChunksInput)
    .output(schemas.sessionCore.ProcessChunksOutput)
    .build(),
  normalizeChunk: defineProcedure("es_normalize_chunk")
    .input(schemas.sessionCore.NormalizeChunkInput)
    .output(schemas.sessionCore.SessionEventSchema)
    .build(),
  setRepoContext: defineProcedure("es_set_repo_context")
    .input(schemas.sessionCore.SetRepoContextInput)
    .build(),
} as const;

const shellReplay = {
  readRange: defineProcedure("shell_replay_read_range")
    .input(schemas.sessionCore.ShellReplayRangeInput)
    .output(schemas.sessionCore.ShellReplayRangeSchema)
    .transform(snakeToCamel)
    .build(),
} as const;

export const sessionCore = {
  cache,
  eventStore,
  shellReplay,
} as const;
