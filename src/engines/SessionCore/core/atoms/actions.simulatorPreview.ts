/**
 * Simulator preview helpers for session action atoms.
 *
 * Local approximation of the Rust simulator/messages visibility rule and the
 * lightweight preview projection used to seed `derivedSnapshotAtom` before
 * the authoritative Rust snapshot arrives. Extracted from actions.ts.
 */
import { isLiveRuntimeResourceEvent } from "../runningEventGate";
import type { SessionEvent, SimulatorEventPreview } from "../types";

/**
 * Local approximation of the Rust simulator/messages visibility rule
 * (`is_visible_in_simulator_or_messages` in `derived.rs`).
 *
 * Used ONLY for synchronous optimistic paths: seeding the local snapshot
 * before the Rust `mergeEvents` push lands, and picking a follow/display
 * target from freshly appended events. The authoritative pre-filtered arrays
 * (`sortedSimulatorEvents` / `messagesEvents`) arrive with the next Rust
 * snapshot and overwrite anything computed here.
 */
export function isSimulatorVisibleApprox(event: SessionEvent): boolean {
  if (event.isDelta) return false;
  if (event.actionType === "tool_result") return false;
  if (
    isLiveRuntimeResourceEvent(event) &&
    event.displayVariant !== "tool_call"
  ) {
    return false;
  }
  return (
    event.displayVariant === "tool_call" ||
    event.displayVariant === "thinking" ||
    event.displayVariant === "message"
  );
}

function getSimulatorFilterCategory(
  event: SessionEvent
): SimulatorEventPreview["filterCategory"] {
  if (event.source === "user") return "key_interactions";
  if (
    event.uiCanonical === "edit_file" ||
    event.uiCanonical === "delete_file"
  ) {
    return "file_changes";
  }
  if (event.command || event.uiCanonical === "run_shell") {
    return "terminal_events";
  }
  if (
    event.uiCanonical === "read_file" ||
    event.uiCanonical === "list_dir" ||
    event.uiCanonical === "code_search" ||
    event.uiCanonical === "glob" ||
    event.uiCanonical === "find_files" ||
    event.uiCanonical === "search"
  ) {
    return "explore";
  }
  if (event.filePath) return "file_changes";
  return "other";
}

function buildSimulatorPreview(event: SessionEvent): SimulatorEventPreview {
  return {
    id: event.id,
    sessionId: event.sessionId,
    createdAt: event.createdAt,
    functionName: event.functionName,
    uiCanonical: event.uiCanonical,
    actionType: event.actionType,
    source: event.source,
    displayText: event.displayText,
    displayStatus: event.displayStatus,
    displayVariant: event.displayVariant,
    activityStatus: event.activityStatus,
    filterCategory: getSimulatorFilterCategory(event),
    threadId: event.threadId,
    processId: event.processId,
    callId: event.callId,
    filePath: event.filePath,
    command: event.command,
    isDelta: event.isDelta,
    repoId: event.repoId,
    repoPath: event.repoPath,
  };
}

export function buildSimulatorPreviewFields(events: SessionEvent[]): {
  sortedSimulatorEventIds: string[];
  eventPreviewById: Record<string, SimulatorEventPreview>;
  createdAtById: Record<string, string>;
  threadIdById: Record<string, string>;
  functionNameById: Record<string, string>;
  displayStatusById: Record<string, string>;
  displayVariantById: Record<string, string>;
} {
  const sortedSimulatorEventIds: string[] = [];
  const eventPreviewById: Record<string, SimulatorEventPreview> = {};
  const createdAtById: Record<string, string> = {};
  const threadIdById: Record<string, string> = {};
  const functionNameById: Record<string, string> = {};
  const displayStatusById: Record<string, string> = {};
  const displayVariantById: Record<string, string> = {};

  for (const event of events) {
    sortedSimulatorEventIds.push(event.id);
    eventPreviewById[event.id] = buildSimulatorPreview(event);
    createdAtById[event.id] = event.createdAt;
    if (event.threadId) threadIdById[event.id] = event.threadId;
    functionNameById[event.id] = event.functionName;
    displayStatusById[event.id] = event.displayStatus;
    displayVariantById[event.id] = event.displayVariant;
  }

  return {
    sortedSimulatorEventIds,
    eventPreviewById,
    createdAtById,
    threadIdById,
    functionNameById,
    displayStatusById,
    displayVariantById,
  };
}
