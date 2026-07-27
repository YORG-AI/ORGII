/**
 * Shared Agent Event Helpers
 *
 * Subagent parent tracking, spawned session detection, tool-call index finders.
 * Used by OS adapter (and any future agent that spawns sub-sessions).
 *
 * NOTE: Subagent spawning detection uses normalizeFunctionName() (Rust source of truth
 * via cli_agents/alias_map.rs). Any tool that normalizes to "subagent" spawns subagents.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { normalizeFunctionName } from "@src/lib/activityData/activityNormalizers";

/**
 * Check if a tool spawns subagents.
 * All subagent-spawning tools normalize to "subagent" via CLI alias map.
 */
export function isSubagentSpawningTool(toolName: string): boolean {
  return normalizeFunctionName(toolName) === "subagent";
}

/**
 * Array of canonical subagent tool names for event store queries.
 * Includes both the raw tool names and ui_canonical ("subagent") since events
 * may be stored with either form depending on source.
 *
 * "agent" is the Rust-native AgentTool name (tool_names::AGENT). It must be
 * included here so that updateActiveTaskArgs() and hasActiveTask() can locate
 * the active subagent call in the EventStore during subagent progress events.
 */
export const SPAWNING_TOOLS_ARRAY = [
  "agent",
  "task",
  "Task",
  "spawn_agent",
  "spawn_sub_agent",
  "subagent",
];

export const SPAWNED_SESSION_RE =
  /(?:agentsession|subagent|agent-[A-Za-z0-9:_-]+)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/;

/**
 * Find the most recent subagent-spawning tool_call that hasn't received
 * a result yet — that's the active subagent's parent.
 */
export function findActiveSubagentCallIndex(
  events: ReadonlyArray<SessionEvent>
): number {
  for (let idx = events.length - 1; idx >= 0; idx--) {
    const evt = events[idx];
    if (
      evt.actionType === "tool_call" &&
      evt.functionName &&
      isSubagentSpawningTool(evt.functionName)
    ) {
      return idx;
    }
    if (
      evt.actionType === "tool_result" &&
      evt.functionName &&
      isSubagentSpawningTool(evt.functionName)
    ) {
      return -1;
    }
  }
  return -1;
}

/**
 * Find the subagent-spawning tool_call whose result contains the given
 * coding agent session ID. Returns the event's id, or null.
 */
export function findSubagentParentEventId(
  events: ReadonlyArray<SessionEvent>,
  codingSessionId: string
): string | null {
  for (let idx = events.length - 1; idx >= 0; idx--) {
    const evt = events[idx];
    if (
      evt.actionType === "tool_call" &&
      evt.functionName &&
      isSubagentSpawningTool(evt.functionName)
    ) {
      const resultText =
        (evt.result?.content as string) ||
        (evt.result?.observation as string) ||
        "";
      if (resultText.includes(codingSessionId)) {
        return evt.id;
      }
    }
  }
  return null;
}

// ============================================================================
// Stream Content Helpers
// ============================================================================

const MAX_STREAM_CONTENT_LENGTH = 500_000;

/**
 * Cap streaming content to prevent memory issues.
 * Trims from the beginning, preserving line boundaries.
 */
export function capStreamContent(text: string): string {
  if (text.length <= MAX_STREAM_CONTENT_LENGTH) return text;
  let trimmed = text.slice(-MAX_STREAM_CONTENT_LENGTH);
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline > 0) trimmed = trimmed.slice(firstNewline + 1);
  return trimmed;
}
