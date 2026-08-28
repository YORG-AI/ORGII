import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { planEventContentSignature } from "./planDisplayEvents";

/**
 * Structural identity of a chat transcript for projection / history
 * orchestration. Token-only growth on the last streaming event is ignored
 * so snapshot.version / displayText churn does not look like a new source.
 */
export function chatTranscriptStructureKey(
  events: ReadonlyArray<SessionEvent>
): string {
  if (events.length === 0) return "0";

  let key = `${events.length}`;
  const lastIndex = events.length - 1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const args = event.args as Record<string, unknown> | undefined;
    key += `|${event.id}:${event.displayStatus}:${event.isDelta ? 1 : 0}:${String(args?.["action"] ?? "")}:${String(args?.["subagentSessionId"] ?? "")}:${planEventContentSignature(event)}`;
    if (index === lastIndex && event.isDelta === true) continue;
    key += `:${event.displayText ?? ""}`;
  }
  return key;
}

export function createChatTranscriptVersionTracker(): {
  next: (events: ReadonlyArray<SessionEvent>) => number;
} {
  let previousKey = "";
  let version = 0;
  return {
    next(events: ReadonlyArray<SessionEvent>): number {
      const key = chatTranscriptStructureKey(events);
      if (key !== previousKey) {
        previousKey = key;
        version += 1;
      }
      return version;
    },
  };
}

export function areChatTranscriptsStructurallyEqual(
  next: ReadonlyArray<SessionEvent>,
  prev: ReadonlyArray<SessionEvent>,
  streaming: boolean
): boolean {
  if (next.length !== prev.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (next[index].id !== prev[index].id) return false;
    if (next[index].displayStatus !== prev[index].displayStatus) return false;
    if (next[index].isDelta !== prev[index].isDelta) return false;
    const nextArgs = next[index].args as Record<string, unknown> | undefined;
    const prevArgs = prev[index].args as Record<string, unknown> | undefined;
    if (nextArgs?.["action"] !== prevArgs?.["action"]) return false;
    if (nextArgs?.["subagentSessionId"] !== prevArgs?.["subagentSessionId"]) {
      return false;
    }
    if (
      planEventContentSignature(next[index]) !==
      planEventContentSignature(prev[index])
    ) {
      return false;
    }
  }
  if (next.length === 0) return true;
  if (streaming) return true;
  return (
    next[next.length - 1].displayText === prev[prev.length - 1].displayText
  );
}
