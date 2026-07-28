/**
 * Chat Item Pipeline — Deduplication
 *
 * Two dedup passes:
 *
 * 1. **Running tool_call dedup** — identifies "running" tool_call chunks that
 *    have a matching completed/failed counterpart later in the history.
 *    Also builds a call_id -> args map so result events (which often have
 *    empty args) can inherit the args from their running counterpart.
 *
 * 2. **Assistant message content dedup** — removes consecutive assistant
 *    messages with identical text. This handles the race between
 *    `agent:streaming_complete` (replaceAndRemove) and `agent:complete`
 *    (upsert) where two events with different IDs but the same content
 *    can briefly coexist in the EventStore.
 */
import { isLiveRuntimeResourceEvent } from "@src/engines/SessionCore/core/runningEventGate";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isSyntheticUserInputEvent } from "@src/engines/SessionCore/sync/utils/activityIds";
import { isCodexAppSession } from "@src/util/session/sessionDispatch";

export interface DedupResult {
  /** Chunk IDs of transient tool-call rows that should be skipped once a result row exists */
  runningChunksToSkip: Set<string>;
  /** call_id -> args from running/call events, for merging into result events */
  runningArgsMap: Map<string, Record<string, unknown>>;
  /** Chunk IDs of duplicate assistant messages that should be skipped */
  duplicateAssistantIds: Set<string>;
  /** Chunk IDs of duplicate optimistic/persisted user messages that should be skipped */
  duplicateUserIds: Set<string>;
}

function getEventCallId(event: SessionEvent): string | undefined {
  return (
    event.callId ||
    (event as { call_id?: string }).call_id ||
    (event.result?.call_id as string | undefined)
  );
}

/**
 * Scan event history and build all dedup maps in a single pass.
 */
export function buildDedupMaps(events: SessionEvent[]): DedupResult {
  const runningChunksToSkip = new Set<string>();
  const runningArgsMap = new Map<string, Record<string, unknown>>();

  // ── Pass 1: Tool call/result dedup ──

  const transientByFunc = new Map<string, number[]>();
  const transientByCallId = new Map<string, number[]>();
  const completedToolCallByCallId = new Map<string, number>();
  for (let idx = 0; idx < events.length; idx++) {
    const event = events[idx];
    if (event.actionType !== "tool_call" || !event.id) continue;

    const callId = getEventCallId(event);
    if (callId && event.args && Object.keys(event.args).length > 0) {
      runningArgsMap.set(callId, event.args);
    }

    const isRunning = isLiveRuntimeResourceEvent(event);
    if (callId && !isRunning) completedToolCallByCallId.set(callId, idx);
    if (!isRunning) continue;

    const fn = event.functionName || "";
    if (!transientByFunc.has(fn)) transientByFunc.set(fn, []);
    transientByFunc.get(fn)!.push(idx);
    if (callId) {
      if (!transientByCallId.has(callId)) transientByCallId.set(callId, []);
      transientByCallId.get(callId)!.push(idx);
    }
  }

  for (let jdx = 0; jdx < events.length; jdx++) {
    const event = events[jdx];
    if (
      event.actionType !== "tool_result" &&
      event.actionType !== "tool_call"
    ) {
      continue;
    }
    if (isLiveRuntimeResourceEvent(event)) {
      continue;
    }

    const callId = getEventCallId(event);
    if (event.actionType === "tool_result" && callId) {
      const completedCallIdx = completedToolCallByCallId.get(callId);
      if (completedCallIdx !== undefined && completedCallIdx < jdx) {
        runningChunksToSkip.add(events[completedCallIdx].id);
      }
    }
    const matchingTransientIndices = callId
      ? transientByCallId.get(callId)
      : transientByFunc.get(event.functionName || "");
    if (!matchingTransientIndices) continue;

    for (const transientIdx of matchingTransientIndices) {
      if (transientIdx >= jdx) continue;
      const transient = events[transientIdx];
      if (transient.id !== event.id) {
        runningChunksToSkip.add(transient.id);
      }
    }
  }

  // ── Pass 2: Assistant/user message content dedup ──

  const duplicateAssistantIds = buildAssistantDedupSet(events);
  const duplicateUserIds = buildUserDedupSet(events);

  return {
    runningChunksToSkip,
    runningArgsMap,
    duplicateAssistantIds,
    duplicateUserIds,
  };
}

/**
 * Public predicate: true when the event is a user-visible assistant/agent
 * message (as opposed to a tool call, system message, or raw event).
 *
 * Exported because turn-level UI actions (e.g., Regenerate) need to find
 * the last assistant message in a group without reimplementing the
 * classification rules.
 */
function normalizeDisplayText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isUserMessageEvent(event: SessionEvent): boolean {
  return event.source === "user" && event.displayVariant === "message";
}

function isOptimisticUserEvent(event: SessionEvent): boolean {
  return isSyntheticUserInputEvent(event);
}

function buildUserDedupSet(events: SessionEvent[]): Set<string> {
  const duplicates = new Set<string>();
  let pendingOptimisticByText = new Map<string, SessionEvent>();

  for (const event of events) {
    if (!isUserMessageEvent(event)) {
      pendingOptimisticByText = new Map();
      continue;
    }

    const text = normalizeDisplayText(event.displayText);
    if (!text) continue;

    if (isOptimisticUserEvent(event)) {
      pendingOptimisticByText.set(text, event);
      continue;
    }

    const optimistic = pendingOptimisticByText.get(text);
    if (optimistic) {
      duplicates.add(optimistic.id);
      pendingOptimisticByText.delete(text);
    }
  }

  return duplicates;
}

function isTurnSummaryEvent(event: SessionEvent): boolean {
  return (
    event.displayVariant === "summary" ||
    event.functionName === "turn_summary" ||
    event.uiCanonical === "turn_summary"
  );
}

export function isAssistantMessageEvent(event: SessionEvent): boolean {
  if (isTurnSummaryEvent(event)) return false;
  return (
    event.actionType === "assistant" ||
    event.uiCanonical === "assistant_message" ||
    event.uiCanonical === "agent_message" ||
    event.functionName === "assistant_message" ||
    event.functionName === "agent_message" ||
    event.functionName === "message"
  );
}

function isAssistantMessage(event: SessionEvent): boolean {
  return isAssistantMessageEvent(event);
}

function isThinkingMessage(event: SessionEvent): boolean {
  return (
    event.displayVariant === "thinking" ||
    event.functionName === "thinking" ||
    event.actionType === "llm_thinking" ||
    event.actionType === "llm_thinking_delta"
  );
}

const assistantTextCache = new WeakMap<SessionEvent, string>();

// Memoized on the (immutable) event: `extractAssistantText` is called once per
// event in each of `buildTextSegment` and `buildAssistantDedupSet`, and the
// whole dedup pass re-runs on every projection. Caching keeps the trim/read
// off already-seen events so a re-projection only pays for the changed tail.
function extractAssistantText(event: SessionEvent): string {
  const cached = assistantTextCache.get(event);
  if (cached !== undefined) return cached;
  const text = computeAssistantText(event);
  assistantTextCache.set(event, text);
  return text;
}

function computeAssistantText(event: SessionEvent): string {
  const result = event.result;
  if (!result) return event.displayText?.trim() ?? "";
  const content =
    (result["content"] as string | undefined) ??
    (result["observation"] as string | undefined) ??
    "";
  return content.trim();
}

function isTurnTextEvent(event: SessionEvent): boolean {
  return isAssistantMessage(event) || isThinkingMessage(event);
}

interface ThinkingSnapshot {
  id: string;
  text: string;
}

function containsThinkingSnapshot(
  container: string,
  candidate: string
): boolean {
  if (container === candidate) return true;

  const start = container.indexOf(candidate);
  if (start < 0) return false;

  const end = start + candidate.length;
  const startsAtBoundary = start === 0 || /\s/.test(container[start - 1]);
  const endsAtBoundary = end === container.length || /\s/.test(container[end]);
  return startsAtBoundary && endsAtBoundary;
}

interface TextSegment {
  ids: string[];
  signature: string;
}

function buildTextSegment(events: SessionEvent[]): TextSegment | null {
  const parts: string[] = [];
  const ids: string[] = [];

  for (const event of events) {
    const text = extractAssistantText(event);
    if (!text) continue;
    const kind = isThinkingMessage(event) ? "thinking" : "assistant";
    parts.push(`${kind}:${text}`);
    ids.push(event.id);
  }

  if (parts.length === 0) return null;
  return { ids, signature: parts.join("\n---\n") };
}

/**
 * Identify duplicate assistant messages. Covers both single adjacent assistant
 * duplicates and repeated streaming segment pairs such as:
 * `thinking(A), assistant(B), thinking(A), assistant(B)`.
 */
function buildAssistantDedupSet(events: SessionEvent[]): Set<string> {
  const duplicates = new Set<string>();
  let prevText = "";
  let prevId = "";
  let thinkingByTextInTurn = new Map<string, string>();
  let codexThinkingSnapshotsInRun: ThinkingSnapshot[] = [];
  let assistantByTextInTurn = new Map<string, string>();

  for (const event of events) {
    if (event.source === "user") {
      thinkingByTextInTurn = new Map();
      codexThinkingSnapshotsInRun = [];
      assistantByTextInTurn = new Map();
      prevText = "";
      prevId = "";
      continue;
    }

    if (isThinkingMessage(event)) {
      const text = normalizeDisplayText(extractAssistantText(event));
      if (text) {
        const previousThinkingId = thinkingByTextInTurn.get(text);
        if (previousThinkingId) {
          duplicates.add(previousThinkingId);
        }
        thinkingByTextInTurn.set(text, event.id);

        // Codex App rollouts can persist one reasoning summary several times
        // while it streams: first as individual `agent_reasoning` updates,
        // then as progressively wider cumulative `reasoning.summary`
        // snapshots. Each snapshot has a fresh ID, so exact-text dedup alone
        // leaves the growing copies visible. Within one uninterrupted run,
        // keep only maximal snapshots; unrelated thoughts remain separate.
        if (isCodexAppSession(event.sessionId)) {
          let currentIsContained = false;
          const survivingSnapshots: ThinkingSnapshot[] = [];

          for (const snapshot of codexThinkingSnapshotsInRun) {
            if (snapshot.text === text) {
              // Exact duplicates already prefer the newest event above.
              continue;
            }
            if (containsThinkingSnapshot(text, snapshot.text)) {
              duplicates.add(snapshot.id);
              continue;
            }
            if (containsThinkingSnapshot(snapshot.text, text)) {
              currentIsContained = true;
              duplicates.add(event.id);
            }
            survivingSnapshots.push(snapshot);
          }

          if (!currentIsContained) {
            survivingSnapshots.push({ id: event.id, text });
          }
          codexThinkingSnapshotsInRun = survivingSnapshots;
        }
      }
      continue;
    }

    codexThinkingSnapshotsInRun = [];

    if (!isAssistantMessage(event)) {
      prevText = "";
      prevId = "";
      continue;
    }

    const text = extractAssistantText(event);
    if (!text) {
      prevText = "";
      prevId = "";
      continue;
    }

    const normalizedText = normalizeDisplayText(text);
    const previousAssistantId = assistantByTextInTurn.get(normalizedText);
    if (previousAssistantId) {
      duplicates.add(previousAssistantId);
    }
    assistantByTextInTurn.set(normalizedText, event.id);

    if (text === prevText && prevId) {
      duplicates.add(prevId);
    }

    prevText = text;
    prevId = event.id;
  }

  let pendingTextEvents: SessionEvent[] = [];
  let previousSegment: TextSegment | null = null;

  const flushSegment = () => {
    const currentSegment = buildTextSegment(pendingTextEvents);
    pendingTextEvents = [];
    if (!currentSegment) return;

    if (
      previousSegment &&
      previousSegment.signature === currentSegment.signature
    ) {
      for (const id of previousSegment.ids) {
        duplicates.add(id);
      }
    }

    previousSegment = currentSegment;
  };

  for (const event of events) {
    if (!isTurnTextEvent(event)) {
      flushSegment();
      previousSegment = null;
      continue;
    }

    pendingTextEvents.push(event);
    if (isAssistantMessage(event)) {
      flushSegment();
    }
  }
  flushSegment();

  return duplicates;
}
