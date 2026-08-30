/**
 * Session Ingestion
 *
 * Data normalization and processing for session events.
 * Transforms raw backend chunks into normalized SessionEvent objects.
 */

// Rust bridge - Tauri IPC for chunk processing
export {
  processChunksRust,
  normalizeChunkRust,
  setEventStoreRepoContext,
} from "./rustBridge";

// Agent message adapters - OS/SDE agent message conversion
export type {
  AgentMessageBase,
  PersistedMessage,
} from "./agentMessageAdapters";
export {
  persistedMessageToSessionEvent,
  mergeToolResults,
} from "./agentMessageAdapters";

// Visibility filters - chat visibility only; simulator/messages visibility
// is computed exclusively in Rust (derived.rs) and consumed via snapshots
// NOTE: normalizeChunk/normalizeChunks have been archived — use rustBridge instead
export { stripTerminalCodeBlocks, isVisibleInChat } from "./visibilityFilters";
