/**
 * Shared Agent Adapter Utilities
 *
 * Re-exports types, event builders, parsers, and helpers used by all
 * agent session adapters. New adapters compose from these modules.
 */

// Types
export type { AgentWSEvent, PermissionRequestEvent } from "./types";

// Event factories
export {
  makeAssistantEvent,
  makeErrorEvent,
  makeThinkingEvent,
  makeToolCallEvent,
  makeToolResultEvent,
  createSyntheticUserEvent,
} from "./eventFactories";

// Parsers (streaming args, think tags, shell detection)
export {
  extractThinkContent,
  isShellTool,
  parsePartialToolArgs,
  stripThinkTags,
} from "./streamingParsers";

// Helpers (subagent tracking, spawned session detection, stream content)
export {
  capStreamContent,
  findSubagentParentEventId,
  SPAWNED_SESSION_RE,
} from "./subagentTracking";

// Subagent session store (in-memory buffer + live streaming + SQLite flush)
