import {
  getCanvasRevisionTargetId,
  isCanvasRevisionToolName,
  materializeCanvasRevisionArgs,
} from "@src/engines/ChatPanel/blocks/CanvasInlineCard/canvasRevision";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

/**
 * Project immutable render events into logical Canvases.
 *
 * A valid revision must point backwards to another Canvas event in the same
 * session. The latest event replaces that logical Canvas at its original list
 * position, while every event remains available in the session history for
 * replay and diagnostics.
 */
export function projectLatestCanvasEvents(
  events: readonly SessionEvent[]
): SessionEvent[] {
  const projected: SessionEvent[] = [];
  const eventById = new Map<string, SessionEvent>();
  const rootIdByEventId = new Map<string, string>();
  const projectedIndexByRootId = new Map<string, number>();

  for (const event of events) {
    const targetId = getCanvasRevisionTargetId(event.args);
    const isDedicatedRevision = isCanvasRevisionToolName(event.functionName);
    if (targetId && event.displayStatus === "failed") {
      continue;
    }
    const targetEvent = targetId ? eventById.get(targetId) : undefined;
    const canRevise =
      targetEvent !== undefined && targetEvent.sessionId === event.sessionId;

    if (canRevise && targetId) {
      const materializedArgs = materializeCanvasRevisionArgs(
        targetEvent.args,
        event.args
      );
      if (!materializedArgs) {
        continue;
      }
      const materializedEvent =
        materializedArgs === event.args
          ? event
          : { ...event, args: materializedArgs };
      const rootId = rootIdByEventId.get(targetId) ?? targetId;
      const projectedIndex = projectedIndexByRootId.get(rootId);
      if (projectedIndex !== undefined) {
        projected[projectedIndex] = materializedEvent;
        eventById.set(event.id, materializedEvent);
        rootIdByEventId.set(event.id, rootId);
        continue;
      }
    }

    if (isDedicatedRevision) {
      continue;
    }

    const projectedIndex = projected.length;
    projected.push(event);
    eventById.set(event.id, event);
    rootIdByEventId.set(event.id, event.id);
    projectedIndexByRootId.set(event.id, projectedIndex);
  }

  return projected;
}
