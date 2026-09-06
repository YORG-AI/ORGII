import { v5 as uuidv5 } from "uuid";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isInternalLifecycleEvent } from "@src/engines/SessionCore/ingestion/visibilityFilters";
import { loadAuthoritativeSessionEvents } from "@src/engines/SessionCore/sync/authoritativeSessionEvents";
import { invokeTauri } from "@src/util/platform/tauri/init";
import { isCliSession } from "@src/util/session/sessionDispatch";

import { conversationSenderStampOf } from "./conversationSenderMetadata";
import {
  type LocalConversationTarget,
  NATIVE_CONVERSATION_CLI_TARGETS,
  type NativeConversationCliTarget,
} from "./conversationTypes";

type NativeConversationItem =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      text: string;
      images: string[];
      createdAt: string;
      /** Stable ORG2 turn identity; provider transports may ignore it. */
      turnId?: string;
    }
  | {
      kind: "tool_call";
      id: string;
      callId: string;
      name: string;
      arguments: string;
      createdAt: string;
    }
  | {
      kind: "tool_result";
      id: string;
      callId: string;
      name: string;
      output: string;
      isError: boolean;
      interrupted: boolean;
      createdAt: string;
    }
  | {
      kind: "context_summary";
      id: string;
      summary: string;
      createdAt: string;
    };

interface NativeMaterializationWireReceipt {
  nativeSessionId: string;
  itemCount: number;
}

export type NativeConversationFidelity =
  | { level: "exact"; omitted: [] }
  | { level: "lossy"; omitted: ["participant_authorship"] };

export interface NativeMaterializationReceipt extends NativeMaterializationWireReceipt {
  /** Content is native; unsupported structured metadata is reported, never injected. */
  fidelity: NativeConversationFidelity;
}

export const MAX_NATIVE_CONVERSATION_ITEMS = 100_000;
export const MAX_NATIVE_CONVERSATION_SERIALIZED_BYTES = 64 * 1024 * 1024;

/** OpenAI's strictest current tool-call identifier envelope. */
export const MAX_PORTABLE_TOOL_CALL_ID_LENGTH = 64;
const PORTABLE_TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const PORTABLE_TOOL_CALL_NAMESPACE = "9e7db8a3-94bf-5c58-9416-a244ba6e30d3";

/**
 * Native providers commonly reuse positional ids (for example `codex-asst-7`)
 * in every session. Scope legacy ids once, then carry that canonical identity
 * through every subsequent native materialization and parse.
 */
const NATIVE_SOURCE_EVENT_ID_NAMESPACE = "45de8858-d25d-51df-a7cf-c7dedcb6d0f1";
const NATIVE_SOURCE_EVENT_ID_PREFIX = "orgii_evt_";

/** Original event identity carried by synthesized/replayed projections. */
export const NATIVE_SOURCE_EVENT_ID_ARG = "__orgiiSourceEventId";

/**
 * Return an identity that has already crossed ORG2's global native boundary.
 * Raw provider-local ids in the same field are deliberately not canonical:
 * they still need session scoping in `nativeSourceEventId`.
 */
export function scopedNativeSourceEventIdOf(
  event: SessionEvent
): string | null {
  const sourceId = event.args?.[NATIVE_SOURCE_EVENT_ID_ARG];
  if (
    typeof sourceId === "string" &&
    sourceId.startsWith(NATIVE_SOURCE_EVENT_ID_PREFIX)
  ) {
    return sourceId;
  }
  return event.id.startsWith(NATIVE_SOURCE_EVENT_ID_PREFIX) ? event.id : null;
}

export function nativeSourceEventId(event: SessionEvent): string {
  // A materialized child created by current writers already carries the
  // globally scoped root identity. Older writers and ordinary provider rows
  // can expose only a provider-local positional id (for example
  // `codex-asst-97`) in this field. That metadata can even point at a later
  // genuine row in the same native Session, so it is not an identity boundary.
  // Ignore every unscoped source hint and scope the row's own provider id;
  // every later materialization carries the resulting `orgii_evt_*` id
  // verbatim.
  const scopedSourceId = scopedNativeSourceEventIdOf(event);
  if (scopedSourceId) return scopedSourceId;
  return `${NATIVE_SOURCE_EVENT_ID_PREFIX}${uuidv5(
    `${event.sessionId}\0${event.id}`,
    NATIVE_SOURCE_EVENT_ID_NAMESPACE
  ).replace(/-/g, "")}`;
}

function nativeConversationTurnId(event: SessionEvent): string | undefined {
  const resultTurnId = (event.result as Record<string, unknown> | undefined)
    ?.turnIntentId;
  if (typeof resultTurnId === "string" && resultTurnId.length > 0) {
    return resultTurnId;
  }
  const argTurnId = event.args?.conversationTurnId;
  return typeof argTurnId === "string" && argTurnId.length > 0
    ? argTurnId
    : undefined;
}

function eventText(event: SessionEvent): string {
  const result = event.result as Record<string, unknown> | undefined;
  const message = result?.message as Record<string, unknown> | undefined;
  for (const candidate of [
    message?.content,
    result?.content,
    result?.observation,
    result?.output,
    event.displayText,
  ]) {
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

function eventImages(event: SessionEvent): string[] {
  const images = (event.result as Record<string, unknown> | undefined)?.images;
  if (!Array.isArray(images)) return [];
  return images.filter(
    (image): image is string => typeof image === "string" && image.length > 0
  );
}

function isUndeliveredUserEvent(event: SessionEvent): boolean {
  if (event.source !== "user") return false;
  const deliveryStatus = (event.result as Record<string, unknown> | undefined)
    ?.deliveryStatus;
  return (
    event.displayStatus === "pending" ||
    event.displayStatus === "failed" ||
    deliveryStatus === "pending" ||
    deliveryStatus === "failed"
  );
}

function transferableToolArgs(event: SessionEvent): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(event.args ?? {}).filter(
      ([key]) =>
        key !== "conversationTurnId" &&
        key !== "conversationSender" &&
        !key.startsWith("__orgii")
    )
  );
}

function isPrivateProviderEvent(event: SessionEvent): boolean {
  const action = event.actionType.toLowerCase();
  const fn = event.functionName.toLowerCase();
  return (
    action.includes("thinking") ||
    action.includes("reasoning") ||
    fn.includes("thinking") ||
    fn.includes("reasoning")
  );
}

function isToolEvent(event: SessionEvent): boolean {
  return (
    event.actionType === "tool_call" ||
    Boolean(event.callId && event.functionName)
  );
}

function portableToolCallId(event: SessionEvent): string {
  const sourceId = event.callId?.trim();
  if (
    sourceId &&
    sourceId.length <= MAX_PORTABLE_TOOL_CALL_ID_LENGTH &&
    PORTABLE_TOOL_CALL_ID_PATTERN.test(sourceId)
  ) {
    return sourceId;
  }

  // Provider-native call IDs are pairing keys, not user-visible content. A
  // stable UUID keeps the call/result relation exact while fitting the
  // strictest supported provider instead of leaking namespaced event IDs.
  const identity = sourceId || event.id;
  return `call_${uuidv5(identity, PORTABLE_TOOL_CALL_NAMESPACE).replace(
    /-/g,
    ""
  )}`;
}

function hasToolResult(event: SessionEvent): boolean {
  const resultStatus = event.result?.status;
  return (
    event.displayStatus !== "running" &&
    event.displayStatus !== "pending" &&
    resultStatus !== "running" &&
    resultStatus !== "pending"
  );
}

function toolResultFlags(event: SessionEvent): {
  isError: boolean;
  interrupted: boolean;
} {
  const result = event.result as Record<string, unknown> | undefined;
  const status =
    typeof result?.status === "string" ? result.status.toLowerCase() : "";
  const displayStatus = event.displayStatus?.toLowerCase() ?? "";
  const interrupted =
    result?.interrupted === true ||
    status === "interrupted" ||
    displayStatus === "interrupted" ||
    displayStatus === "cancelled";
  return {
    interrupted,
    isError:
      interrupted ||
      result?.isError === true ||
      result?.is_error === true ||
      ["error", "failed", "cancelled"].includes(status) ||
      ["error", "failed", "cancelled"].includes(displayStatus),
  };
}

/**
 * Provider-native conversation content. It preserves roles and tool pairing;
 * it never renders history into a prompt. Provider-private reasoning, system
 * policy and unsupported participant metadata are outside the item contract;
 * callers that need the fidelity result use `projectNativeConversation`.
 */
export function projectNativeConversationItems(
  events: readonly SessionEvent[]
): NativeConversationItem[] {
  const items: NativeConversationItem[] = [];
  const persistedUserMessageIds = new Set(
    events.flatMap((event) => {
      if (event.functionName !== "user_message") return [];
      const messageId = (event.result as Record<string, unknown> | undefined)
        ?.messageId;
      return typeof messageId === "string" && messageId.length > 0
        ? [messageId]
        : [];
    })
  );
  for (const event of events) {
    if (
      event.actionType === "context_compacted" ||
      event.functionName === "context_compacted"
    ) {
      const summary = eventText(event);
      if (summary.trim().length > 0) {
        // The full canonical log remains intact for ORG2 history, but the
        // provider's effective context is its latest native summary plus the
        // structured suffix. Rebuild that message list instead of feeding the
        // superseded prefix back until every runtime compacts again.
        items.length = 0;
        items.push({
          kind: "context_summary",
          id: nativeSourceEventId(event),
          summary,
          createdAt: event.createdAt,
        });
      }
      continue;
    }
    if (
      event.isDelta ||
      isInternalLifecycleEvent(event) ||
      isPrivateProviderEvent(event) ||
      isUndeliveredUserEvent(event)
    ) {
      continue;
    }
    // Rust Agent persistence emits a low-level `user_input` acceptance row
    // followed by the canonical `user_message` whose result.messageId points
    // back to it. The UI collapses that pair to one bubble; the provider
    // projection must do the same or every rebuilt runtime sees the prompt
    // twice. A standalone imported `user_input` remains portable.
    if (
      event.source === "user" &&
      event.functionName === "user_input" &&
      persistedUserMessageIds.has(event.id)
    ) {
      continue;
    }
    if (isToolEvent(event)) {
      // An interrupted provider turn may leave an unresolved tool_use /
      // function_call in its native store. A call without a result is not a
      // portable conversation boundary: replaying it into another provider
      // either violates that provider's message grammar or makes the next
      // user message look like the missing tool result. Keep the user row,
      // completed narration and every closed call/result pair, but drop only
      // this unfinished tail. Standalone tool_result rows are likewise not a
      // pair; normal ingestion merges them into their tool_call first.
      if (event.actionType === "tool_result" || !hasToolResult(event)) {
        continue;
      }
      const callId = portableToolCallId(event);
      const name = event.functionName.trim();
      if (!name) {
        throw new Error(`native transcript tool event ${event.id} has no name`);
      }
      items.push({
        kind: "tool_call",
        id: `${nativeSourceEventId(event)}:call`,
        callId,
        name,
        arguments: JSON.stringify(transferableToolArgs(event)),
        createdAt: event.createdAt,
      });
      if (hasToolResult(event)) {
        const { isError, interrupted } = toolResultFlags(event);
        items.push({
          kind: "tool_result",
          id: `${nativeSourceEventId(event)}:result`,
          callId,
          name,
          output: eventText(event),
          isError,
          interrupted,
          createdAt: event.createdAt,
        });
      }
      continue;
    }
    if (event.source !== "user" && event.source !== "assistant") continue;
    // A provider without structured participant metadata receives the exact
    // human body. Never smuggle ORG2 markup into visible native user text;
    // `projectNativeConversation` reports that authorship loss explicitly.
    const text = eventText(event);
    const images = eventImages(event);
    if (!text && images.length === 0) continue;
    const turnId =
      event.source === "user" ? nativeConversationTurnId(event) : undefined;
    items.push({
      kind: "message",
      id: nativeSourceEventId(event),
      role: event.source,
      text,
      images,
      createdAt: event.createdAt,
      ...(turnId ? { turnId } : {}),
    });
  }
  // The canonical timeline normally collapses copied source rows while it
  // stitches native, plane and discussion segments. Old persisted plane rows
  // can already carry the same globally scoped identity, though, and an
  // execution overlay can reintroduce that copy after the stitch. Native item
  // identity is the final transport boundary: two items with the same durable
  // id are the same message/call/result, so keep the first instead of sending
  // an invalid duplicate transcript to the provider writer.
  const seenItemIds = new Set<string>();
  return items.filter((item) => {
    if (seenItemIds.has(item.id)) return false;
    seenItemIds.add(item.id);
    return true;
  });
}

/**
 * Remove provider-native echoes of a canonical prefix from a streamed suffix.
 *
 * A freshly materialized CLI session can expose its copied prefix after the
 * newly accepted user row while its live EventStore projection settles. Native
 * source ids survive that copy, so compare portable item identity instead of
 * relying on provider event order or a raw array index.
 */
export function removeKnownNativeConversationEchoes(
  knownEvents: readonly SessionEvent[],
  candidates: readonly SessionEvent[]
): SessionEvent[] {
  const knownItems = projectNativeConversationItems(knownEvents);
  const seen = new Set(knownItems.map((item) => item.id));
  const semanticCounts = new Map<string, number>();
  let semanticPrefixOpen = true;
  for (const item of knownItems) {
    const key = JSON.stringify(semanticItem(item));
    semanticCounts.set(key, (semanticCounts.get(key) ?? 0) + 1);
  }
  return candidates.filter((event) => {
    const items = projectNativeConversationItems([event]);
    if (items.length === 0) return true;
    const hasKnownIds = items.every((item) => seen.has(item.id));
    const keys = items.map((item) => JSON.stringify(semanticItem(item)));
    const remaining = new Map(semanticCounts);
    const hasKnownSemantics = keys.every((key) => {
      const count = remaining.get(key) ?? 0;
      if (count <= 0) return false;
      remaining.set(key, count - 1);
      return true;
    });
    // Provider-local ids can change when a copied prefix crosses runtimes, so
    // semantic matching is necessary while that prefix is being replayed.
    // Once the first genuinely new portable row arrives, however, an equal
    // later answer/tool result is a legitimate repetition and must survive.
    // Globally scoped identity remains safe to collapse anywhere.
    const isKnown = hasKnownIds || (semanticPrefixOpen && hasKnownSemantics);
    if (!isKnown) semanticPrefixOpen = false;
    if (isKnown) {
      for (const key of keys) {
        const count = semanticCounts.get(key) ?? 0;
        if (count > 0) semanticCounts.set(key, count - 1);
      }
    }
    for (const item of items) seen.add(item.id);
    return !isKnown;
  });
}

export function projectNativeConversation(events: readonly SessionEvent[]): {
  items: NativeConversationItem[];
  fidelity: NativeConversationFidelity;
} {
  const items = projectNativeConversationItems(events);
  const projectedUserIds = new Set(
    items.flatMap((item) =>
      item.kind === "message" && item.role === "user" ? [item.id] : []
    )
  );
  const losesAuthorship = events.some(
    (event) =>
      event.source === "user" &&
      projectedUserIds.has(nativeSourceEventId(event)) &&
      conversationSenderStampOf(event) !== null
  );
  return {
    items,
    fidelity: losesAuthorship
      ? { level: "lossy", omitted: ["participant_authorship"] }
      : { level: "exact", omitted: [] },
  };
}

/** Mirror Rust's ingress cap before Tauri deserializes a potentially huge Vec. */
export function assertNativeConversationPayloadWithinBounds(
  items: readonly NativeConversationItem[],
  limits: { maxItems?: number; maxBytes?: number } = {}
): number {
  const maxItems = limits.maxItems ?? MAX_NATIVE_CONVERSATION_ITEMS;
  const maxBytes = limits.maxBytes ?? MAX_NATIVE_CONVERSATION_SERIALIZED_BYTES;
  if (items.length > maxItems) {
    throw new Error(
      `native transcript has ${items.length} items; limit is ${maxItems}`
    );
  }
  let bytes = 2; // JSON array brackets.
  const encoder = new TextEncoder();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    // Rust reserializes serde-defaulted fields while validating. Measure that
    // canonical shape so the TS preflight cannot pass a near-limit payload
    // that Rust rejects only after allocating/deserializing the full Vec.
    const validatedShape =
      item.kind === "message" ? { ...item, turnId: item.turnId ?? null } : item;
    bytes += encoder.encode(JSON.stringify(validatedShape)).length;
    if (index > 0) bytes += 1; // JSON array comma.
    if (bytes > maxBytes) {
      throw new Error(
        `native transcript is ${bytes} bytes; limit is ${maxBytes}`
      );
    }
  }
  return bytes;
}

export function sourceEventIdOfNativeItem(
  item: NativeConversationItem
): string {
  return item.kind === "message"
    ? item.id
    : item.id.replace(/:(?:call|result)$/, "");
}

/**
 * Native CLIs can be killed before their newest fork is flushed. In that
 * case the native reader deliberately falls back to the previous readable
 * fork, while EventStore still holds the accepted user row and any durable
 * partial output already streamed by the interrupted turn. Extend the native
 * semantic prefix with exactly that portable suffix instead of blanking it
 * during reconcile. Divergent histories fail closed and keep native truth.
 */
export function mergeInterruptedConversationProjection(
  nativeEvents: readonly SessionEvent[],
  projectedEvents: readonly SessionEvent[]
): SessionEvent[] {
  const nativeItems = projectNativeConversationItems(nativeEvents);
  const projectedItems = projectNativeConversationItems(projectedEvents);
  if (
    nativeItems.length >= projectedItems.length ||
    !nativeConversationItemsArePrefix(nativeItems, projectedItems)
  ) {
    return [...nativeEvents];
  }

  const suffixSourceIds = new Set(
    projectedItems.slice(nativeItems.length).map(sourceEventIdOfNativeItem)
  );
  const nativeEventIds = new Set(nativeEvents.map((event) => event.id));
  const suffix = projectedEvents.filter(
    (event) =>
      suffixSourceIds.has(nativeSourceEventId(event)) &&
      !nativeEventIds.has(event.id)
  );
  return suffix.length > 0 ? [...nativeEvents, ...suffix] : [...nativeEvents];
}

function semanticItem(item: NativeConversationItem): unknown {
  switch (item.kind) {
    case "message":
      return [item.kind, item.role, item.text, item.images];
    case "tool_call":
      return [
        item.kind,
        item.callId,
        item.name,
        canonicalJson(JSON.parse(item.arguments) as unknown),
      ];
    case "tool_result":
      return [
        item.kind,
        item.callId,
        item.name,
        item.output,
        item.isError,
        item.interrupted,
      ];
    case "context_summary":
      return [item.kind, item.summary];
  }
}

/**
 * Provider-neutral semantic identity for one canonical event. Unlike event
 * ids, this survives a native provider parser that exposes only positional
 * ids after materialization. Callers must still match occurrences one-to-one:
 * repeated equal messages in different turns are valid conversation events.
 */
export function nativeConversationEventSemanticKey(
  event: SessionEvent
): string | null {
  const items = projectNativeConversationItems([event]);
  return items.length > 0
    ? JSON.stringify(items.map((item) => semanticItem(item)))
    : null;
}

function nativeItemShape(item: NativeConversationItem | undefined): string {
  if (!item) return "missing";
  switch (item.kind) {
    case "message":
      return `message:${item.role}:text=${item.text.length}:images=${item.images.length}`;
    case "tool_call":
      return `tool_call:${item.name}:call=${item.callId}:arguments=${item.arguments.length}`;
    case "tool_result":
      return `tool_result:${item.name}:call=${item.callId}:output=${item.output.length}`;
    case "context_summary":
      return `context_summary:text=${item.summary.length}`;
  }
}

function nativeConversationMismatch(
  expected: readonly NativeConversationItem[],
  actual: readonly NativeConversationItem[]
): string {
  const sharedLength = Math.min(expected.length, actual.length);
  let firstMismatch = sharedLength;
  for (let index = 0; index < sharedLength; index += 1) {
    if (
      JSON.stringify(semanticItem(expected[index])) !==
      JSON.stringify(semanticItem(actual[index]))
    ) {
      firstMismatch = index;
      break;
    }
  }
  return [
    `expected=${expected.length}`,
    `actual=${actual.length}`,
    `firstMismatch=${firstMismatch}`,
    `expectedShape=${nativeItemShape(expected[firstMismatch])}`,
    `actualShape=${nativeItemShape(actual[firstMismatch])}`,
  ].join(" ");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)])
    );
  }
  return value;
}

export function nativeConversationItemsEqual(
  left: readonly NativeConversationItem[],
  right: readonly NativeConversationItem[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        JSON.stringify(semanticItem(item)) ===
        JSON.stringify(semanticItem(right[index]))
    )
  );
}

export function nativeConversationItemsArePrefix(
  prefix: readonly NativeConversationItem[],
  complete: readonly NativeConversationItem[]
): boolean {
  return (
    prefix.length <= complete.length &&
    prefix.every(
      (item, index) =>
        JSON.stringify(semanticItem(item)) ===
        JSON.stringify(semanticItem(complete[index]))
    )
  );
}

function providerPortableSemanticItems(
  items: readonly NativeConversationItem[]
): unknown[] {
  const callAliases = new Map<string, number>();
  const callAlias = (callId: string): number => {
    const existing = callAliases.get(callId);
    if (existing !== undefined) return existing;
    const alias = callAliases.size;
    callAliases.set(callId, alias);
    return alias;
  };

  return items.map((item) => {
    switch (item.kind) {
      case "tool_call":
        return [
          item.kind,
          callAlias(item.callId),
          item.name,
          canonicalJson(JSON.parse(item.arguments) as unknown),
        ];
      case "tool_result":
        return [
          item.kind,
          callAlias(item.callId),
          item.name,
          item.output,
          item.isError,
          item.interrupted,
        ];
      default:
        return semanticItem(item);
    }
  });
}

/**
 * Prefix identity across two provider-native transcripts. Provider call ids
 * are local pairing keys and can be rewritten when Codex history is rebuilt
 * for Claude (or vice versa). Normalize each transcript's ids by first-use
 * order so the call/result topology remains strict while equivalent provider
 * ids do not make an otherwise exact materialized child look divergent.
 */
export function nativeConversationItemsAreProviderPortablePrefix(
  prefix: readonly NativeConversationItem[],
  complete: readonly NativeConversationItem[]
): boolean {
  if (prefix.length > complete.length) return false;
  const prefixSemantic = providerPortableSemanticItems(prefix);
  const completeSemantic = providerPortableSemanticItems(complete);
  return prefixSemantic.every(
    (item, index) =>
      JSON.stringify(item) === JSON.stringify(completeSemantic[index])
  );
}

export function supportsNativeConversationTarget(
  target: Pick<LocalConversationTarget, "cliAgentType">
): boolean {
  return (
    !target.cliAgentType ||
    NATIVE_CONVERSATION_CLI_TARGETS.includes(
      target.cliAgentType as NativeConversationCliTarget
    )
  );
}

export async function materializeNativeConversation(params: {
  sessionId: string;
  timeline: readonly SessionEvent[];
}): Promise<{ events: SessionEvent[]; receipt: NativeMaterializationReceipt }> {
  const { items, fidelity } = projectNativeConversation(params.timeline);
  if (params.timeline.length > 0 && items.length === 0) {
    throw new Error(
      "conversation has no portable native role/tool transcript to materialize"
    );
  }
  // With no history there is nothing to migrate. Leave the fresh target
  // unbound so its normal first send creates the provider-native session.
  if (items.length === 0) {
    return {
      events: [],
      receipt: { nativeSessionId: "", itemCount: 0, fidelity },
    };
  }
  assertNativeConversationPayloadWithinBounds(items);
  const wireReceipt = await invokeTauri<NativeMaterializationWireReceipt>(
    "materialize_native_conversation",
    { sessionId: params.sessionId, items }
  );
  const receipt: NativeMaterializationReceipt = { ...wireReceipt, fidelity };
  try {
    if (receipt.itemCount !== items.length) {
      throw new Error(
        `native materializer wrote ${receipt.itemCount} of ${items.length} items`
      );
    }
    const { events } = await loadAuthoritativeSessionEvents(params.sessionId);
    const roundTripped = projectNativeConversationItems(events);
    if (!nativeConversationItemsEqual(items, roundTripped)) {
      throw new Error(
        `native transcript round-trip verification failed; the target session was not started (${nativeConversationMismatch(items, roundTripped)})`
      );
    }
    return { events, receipt };
  } catch (error) {
    if (isCliSession(params.sessionId)) {
      await invokeTauri("discard_native_conversation_materialization", {
        sessionId: params.sessionId,
        nativeSessionId: receipt.nativeSessionId,
      }).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Bring an existing execution episode up to the canonical transcript before
 * native resume. The complete structured role/tool history is written into
 * the target provider's own transcript format; no delta is rendered as a
 * user prompt. Only strict semantic-prefix growth is allowed, so a branch or
 * rewrite rolls to a new episode instead of mutating unrelated history.
 */
export async function synchronizeNativeConversation(params: {
  sessionId: string;
  timeline: readonly SessionEvent[];
}): Promise<{ events: SessionEvent[]; receipt: NativeMaterializationReceipt }> {
  const { items: complete, fidelity } = projectNativeConversation(
    params.timeline
  );
  assertNativeConversationPayloadWithinBounds(complete);
  const wireReceipt = await invokeTauri<NativeMaterializationWireReceipt>(
    "synchronize_native_conversation",
    {
      sessionId: params.sessionId,
      completeItems: complete,
    }
  );
  const receipt: NativeMaterializationReceipt = { ...wireReceipt, fidelity };
  if (receipt.itemCount !== complete.length) {
    throw new Error(
      `native synchronizer wrote ${receipt.itemCount} of ${complete.length} items`
    );
  }
  const { events } = await loadAuthoritativeSessionEvents(params.sessionId);
  if (
    !nativeConversationItemsEqual(
      complete,
      projectNativeConversationItems(events)
    )
  ) {
    throw new Error(
      `native transcript synchronization round-trip verification failed (${nativeConversationMismatch(complete, projectNativeConversationItems(events))})`
    );
  }
  return { events, receipt };
}
