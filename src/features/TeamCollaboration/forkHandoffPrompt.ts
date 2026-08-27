/**
 * First-send handoff (LLM context continuity).
 *
 * A fork starts with an empty `agent_messages` table, so the agent is blind to
 * the teammate's context. There is no Tauri command to seed it; the handoff
 * rides the FIRST message instead as a bounded digest of the inherited events
 * (same technique as the imported-history handoff in `externalHistoryFork.ts`),
 * while `displayText` keeps the user's own words in the transcript.
 */
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { SessionForkedFrom } from "@src/store/session/sessionAtom/types";

import { readRegistry } from "./forkRelayRegistry";

export const MAX_HANDOFF_ITEMS = 80;
export const MAX_ITEM_TEXT_LENGTH = 1200;

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value.map(textValue).filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      textValue(record.text) ??
      textValue(record.content) ??
      textValue(record.message) ??
      textValue(record.output) ??
      textValue(record.observation) ??
      textValue(record.summary)
    );
  }
  return undefined;
}

function truncateText(text: string): string {
  return text.length > MAX_ITEM_TEXT_LENGTH
    ? `${text.slice(0, MAX_ITEM_TEXT_LENGTH)}…`
    : text;
}

function eventToHandoffItem(event: SessionEvent): string | undefined {
  const actionType = event.actionType ?? "";
  // Thinking is the owner's model-internal state — never part of a handoff
  // (same rule as the Codex external-history fork).
  if (actionType.includes("thinking") || actionType.includes("reasoning")) {
    return undefined;
  }

  const primary =
    (event.displayText || "").trim() ||
    textValue(event.result) ||
    textValue(event.args);

  if (event.source === "user") {
    return primary ? `User: ${truncateText(primary)}` : undefined;
  }
  if (actionType === "tool_call" || actionType.includes("tool")) {
    const lines = [
      "[Inherited session action]",
      `Tool: ${event.functionName || "unknown_tool"}`,
    ];
    const argsText = textValue(event.args);
    const resultText = textValue(event.result);
    if (argsText) lines.push(`Input: ${truncateText(argsText)}`);
    if (resultText)
      lines.push(`Result at that time: ${truncateText(resultText)}`);
    return lines.join("\n");
  }
  return primary ? `Assistant: ${truncateText(primary)}` : undefined;
}

/** Exported for tests; assembles the wrapped first-send content. */
export function buildForkHandoffPrompt(
  events: SessionEvent[],
  forkedFrom: SessionForkedFrom,
  userText: string
): string {
  const items = events
    .map(eventToHandoffItem)
    .filter((item): item is string => Boolean(item))
    .slice(-MAX_HANDOFF_ITEMS);

  return [
    "You are taking over a teammate's shared ORGII session and continuing it as your own session.",
    `Original owner: ${forkedFrom.ownerDisplayName}. The transcript below is the inherited history (${forkedFrom.atCount} events) from their machine, provided as read-only context.`,
    "Do not treat inherited tool calls as tools you executed or as current workspace state. Results may be stale; verify files, commands, and outcomes against the current workspace before relying on them.",
    "Thinking/reasoning items were intentionally omitted.",
    "",
    "## Inherited session context",
    items.length > 0
      ? items.join("\n\n")
      : "No usable transcript items were found.",
    "",
    "## Continuation request",
    userText,
  ].join("\n");
}

export interface ForkHandoffContent {
  /** Wire content for the LLM: handoff digest + the user's message. */
  content: string;
  /** What the transcript should show — the user's own words. */
  displayText: string;
}

/**
 * When `sessionId` is a fork whose handoff has not been consumed yet, build
 * the wrapped first-send content from the inherited events (bounded digest).
 * Pure read — call `markForkHandoffConsumed` after the send SUCCEEDS so a
 * failed send retries with the handoff intact. Returns null for every
 * non-fork session and for forks that already relayed their context.
 */
export async function buildPendingForkHandoff(
  sessionId: string,
  userText: string
): Promise<ForkHandoffContent | null> {
  const entry = readRegistry()[sessionId];
  if (!entry?.handoffPending) return null;

  const events = await eventStoreProxy.getPersistedEvents(sessionId);
  // Slice to the fork point: by first-send time the composer may already have
  // appended the new user's own message to the store — inherited history is
  // exactly the first `atCount` events.
  const inherited = events.slice(0, entry.forkedFrom.atCount);
  return {
    content: buildForkHandoffPrompt(inherited, entry.forkedFrom, userText),
    displayText: userText,
  };
}
