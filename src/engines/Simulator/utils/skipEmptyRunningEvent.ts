/**
 * Shared logic for skipping empty running file-tool events.
 *
 * Both the main simulator (useSimulatorSession) and subagent grid cells
 * (SubagentEventPane) need to skip file-tool events that are still
 * running with no content yet, to avoid showing blank frames.
 */
import type { SessionEvent } from "@src/engines/SessionCore";
import { isFileTool } from "@src/engines/SessionCore/rendering/registry/toolCategories";

/**
 * Returns true when the event is a file tool that is still running
 * with no content yet (empty placeholder frame).
 */
export function isEmptyRunningEvent(event: SessionEvent): boolean {
  if (!isFileTool(event.functionName || "")) return false;
  const result = event.result;
  if (result?.status !== "running") return false;
  const output = result?.output as Record<string, unknown> | undefined;
  const successData = output?.success as Record<string, unknown> | undefined;
  const hasContent =
    result?.observation ||
    result?.content ||
    (typeof result?.output === "string" && result.output) ||
    successData?.content ||
    successData?.afterFullFileContent ||
    successData?.diffString;
  return !hasContent;
}

/**
 * Given a current event and full event list, skip forward/backward past
 * empty running events to find the nearest event with content.
 */
export function resolveNonEmptyEvent(
  rawCurrentEvent: SessionEvent | null,
  events: SessionEvent[]
): SessionEvent | null {
  return resolveNonEmptyEventFromIds(
    rawCurrentEvent,
    events.map((event) => event.id),
    new Map(events.map((event) => [event.id, event]))
  );
}

export function resolveNonEmptyEventFromIds(
  rawCurrentEvent: SessionEvent | null,
  eventIds: string[],
  eventById: Map<string, SessionEvent>
): SessionEvent | null {
  if (!rawCurrentEvent || !isEmptyRunningEvent(rawCurrentEvent)) {
    return rawCurrentEvent;
  }
  const index = eventIds.findIndex((eventId) => {
    return eventById.get(eventId)?.chunk_id === rawCurrentEvent.chunk_id;
  });
  if (index < 0) return rawCurrentEvent;
  for (
    let forwardIndex = index + 1;
    forwardIndex < eventIds.length;
    forwardIndex++
  ) {
    const event = eventById.get(eventIds[forwardIndex]);
    if (event && !isEmptyRunningEvent(event)) return event;
  }
  for (let backwardIndex = index - 1; backwardIndex >= 0; backwardIndex--) {
    const event = eventById.get(eventIds[backwardIndex]);
    if (event && !isEmptyRunningEvent(event)) return event;
  }
  return rawCurrentEvent;
}
