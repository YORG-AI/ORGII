import {
  type LlmUsageSpanRecord,
  TOOL_USAGE_ATTRIBUTION_METHOD,
  type ToolUsageAttributionRecord,
  getSessionLlmUsageSpans,
  getSessionToolUsageAttributions,
} from "@src/api/tauri/session";
import {
  LLM_USAGE_ARGS_KEY,
  type LlmUsageMetadata,
  type SessionEvent,
  TOOL_USAGE_ARGS_KEY,
  type ToolUsageMetadata,
} from "@src/engines/SessionCore/core/types";

const MAX_SESSION_USAGE_CACHE_SIZE = 100;

interface UsageTelemetryMaps {
  toolUsageByCallId: Map<string, ToolUsageMetadata>;
  llmUsageByTurnId: Map<string, LlmUsageMetadata>;
}

const sessionUsageCache = new Map<string, Map<string, ToolUsageMetadata>>();

function touchSessionCache(
  sessionId: string,
  usageByCallId: Map<string, ToolUsageMetadata>
): void {
  if (sessionUsageCache.has(sessionId)) {
    sessionUsageCache.delete(sessionId);
  }
  sessionUsageCache.set(sessionId, usageByCallId);
  while (sessionUsageCache.size > MAX_SESSION_USAGE_CACHE_SIZE) {
    const oldestKey = sessionUsageCache.keys().next().value;
    if (!oldestKey) break;
    sessionUsageCache.delete(oldestKey);
  }
}

interface CacheUsageTotals {
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function parseRelatedToolCallIds(span: LlmUsageSpanRecord): string[] {
  if (!span.relatedToolCallIdsJson) return [];
  const parsed: unknown = JSON.parse(span.relatedToolCallIdsJson);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value): value is string => typeof value === "string");
}

function buildRelatedCacheMap(
  spans: readonly LlmUsageSpanRecord[]
): Map<string, CacheUsageTotals> {
  const cacheByCallId = new Map<string, CacheUsageTotals>();
  for (const span of spans) {
    const relatedToolCallIds = parseRelatedToolCallIds(span);
    if (relatedToolCallIds.length === 0) continue;
    for (const toolCallId of relatedToolCallIds) {
      const existing = cacheByCallId.get(toolCallId) ?? {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      cacheByCallId.set(toolCallId, {
        cacheReadTokens: existing.cacheReadTokens + span.cacheReadTokens,
        cacheWriteTokens: existing.cacheWriteTokens + span.cacheWriteTokens,
      });
    }
  }
  return cacheByCallId;
}

function toMetadata(
  record: ToolUsageAttributionRecord,
  relatedCache?: CacheUsageTotals
): ToolUsageMetadata {
  return {
    decisionCompletionTokens: record.decisionCompletionTokens,
    resultContextTokens: record.resultContextTokens,
    followupCompletionTokens: record.followupCompletionTokens,
    inputBytes: record.inputBytes,
    outputBytes: record.outputBytes,
    relatedCacheReadTokens: relatedCache?.cacheReadTokens ?? 0,
    relatedCacheWriteTokens: relatedCache?.cacheWriteTokens ?? 0,
    attributionMethod: record.attributionMethod,
  };
}

export function buildUsageMap(
  records: readonly ToolUsageAttributionRecord[],
  spans: readonly LlmUsageSpanRecord[] = []
): Map<string, ToolUsageMetadata> {
  const cacheByCallId = buildRelatedCacheMap(spans);
  const usageByCallId = new Map<string, ToolUsageMetadata>();
  for (const record of records) {
    const existing = usageByCallId.get(record.toolCallId);
    if (!existing) {
      usageByCallId.set(
        record.toolCallId,
        toMetadata(record, cacheByCallId.get(record.toolCallId))
      );
      continue;
    }
    usageByCallId.set(record.toolCallId, {
      decisionCompletionTokens:
        existing.decisionCompletionTokens + record.decisionCompletionTokens,
      resultContextTokens:
        existing.resultContextTokens + record.resultContextTokens,
      followupCompletionTokens:
        existing.followupCompletionTokens + record.followupCompletionTokens,
      inputBytes: existing.inputBytes + record.inputBytes,
      outputBytes: existing.outputBytes + record.outputBytes,
      relatedCacheReadTokens: existing.relatedCacheReadTokens,
      relatedCacheWriteTokens: existing.relatedCacheWriteTokens,
      attributionMethod:
        existing.attributionMethod === record.attributionMethod
          ? existing.attributionMethod
          : record.attributionMethod,
    });
  }
  for (const record of records) {
    const usage = usageByCallId.get(record.toolCallId);
    if (usage) usageByCallId.set(record.eventId, usage);
  }
  return usageByCallId;
}

export function buildLlmUsageByTurnMap(
  spans: readonly LlmUsageSpanRecord[]
): Map<string, LlmUsageMetadata> {
  const usageByTurnId = new Map<string, LlmUsageMetadata>();
  for (const span of spans) {
    if (parseRelatedToolCallIds(span).length > 0) continue;
    const existing = usageByTurnId.get(span.turnId);
    usageByTurnId.set(span.turnId, {
      inputTokens: (existing?.inputTokens ?? 0) + span.promptTokens,
      outputTokens: (existing?.outputTokens ?? 0) + span.completionTokens,
      cacheReadTokens: (existing?.cacheReadTokens ?? 0) + span.cacheReadTokens,
      cacheWriteTokens:
        (existing?.cacheWriteTokens ?? 0) + span.cacheWriteTokens,
      model: existing?.model ?? span.model,
      attributionMethod: TOOL_USAGE_ATTRIBUTION_METHOD.PROVIDER_EXACT,
    });
  }
  return usageByTurnId;
}

export function withToolUsageArgs(
  args: Record<string, unknown>,
  toolUsage: ToolUsageMetadata
): Record<string, unknown> {
  return {
    ...args,
    [TOOL_USAGE_ARGS_KEY]: toolUsage,
  };
}

export function withLlmUsageArgs(
  args: Record<string, unknown>,
  llmUsage: LlmUsageMetadata
): Record<string, unknown> {
  return {
    ...args,
    [LLM_USAGE_ARGS_KEY]: llmUsage,
  };
}

function eventTurnId(event: SessionEvent): string | null {
  const turnId = event.args?.turnId;
  return typeof turnId === "string" ? turnId : null;
}

function isAssistantMessageEvent(event: SessionEvent): boolean {
  return (
    event.source === "assistant" &&
    event.displayVariant === "message" &&
    event.functionName !== "turn_summary"
  );
}

function isThinkingEvent(event: SessionEvent): boolean {
  return (
    event.displayVariant === "thinking" || event.uiCanonical === "thinking"
  );
}

function selectLlmUsageTargetEvents(
  events: readonly SessionEvent[]
): Map<string, SessionEvent> {
  const targetsByTurnId = new Map<string, SessionEvent>();
  for (const event of events) {
    const turnId = eventTurnId(event);
    if (!turnId) continue;
    if (isAssistantMessageEvent(event)) {
      targetsByTurnId.set(turnId, event);
      continue;
    }
    if (isThinkingEvent(event) && !targetsByTurnId.has(turnId)) {
      targetsByTurnId.set(turnId, event);
    }
  }
  return targetsByTurnId;
}

export function applyLlmUsageToEvents(
  events: readonly SessionEvent[],
  usageByTurnId: ReadonlyMap<string, LlmUsageMetadata>
): SessionEvent[] {
  if (usageByTurnId.size === 0) return [...events];
  const targetEvents = selectLlmUsageTargetEvents(events);
  const targetIds = new Set(
    [...targetEvents.values()].map((event) => event.id)
  );
  return events.map((event) => {
    if (!targetIds.has(event.id)) return event;
    const turnId = eventTurnId(event);
    const llmUsage = turnId ? usageByTurnId.get(turnId) : undefined;
    if (!llmUsage) return event;
    return {
      ...event,
      args: withLlmUsageArgs(event.args, llmUsage),
      llmUsage,
    };
  });
}

export function applyToolUsageToEvents(
  events: readonly SessionEvent[],
  usageByCallId: ReadonlyMap<string, ToolUsageMetadata>
): SessionEvent[] {
  if (usageByCallId.size === 0) return [...events];
  return events.map((event) => {
    const toolUsage = event.callId
      ? (usageByCallId.get(event.callId) ?? usageByCallId.get(event.id))
      : usageByCallId.get(event.id);
    if (!toolUsage) return event;
    return {
      ...event,
      args: withToolUsageArgs(event.args, toolUsage),
      toolUsage,
    };
  });
}

export async function loadUsageTelemetry(
  sessionId: string
): Promise<UsageTelemetryMaps> {
  const [records, spans] = await Promise.all([
    getSessionToolUsageAttributions(sessionId),
    getSessionLlmUsageSpans(sessionId),
  ]);
  const toolUsageByCallId = buildUsageMap(records, spans);
  const llmUsageByTurnId = buildLlmUsageByTurnMap(spans);
  touchSessionCache(sessionId, toolUsageByCallId);
  return { toolUsageByCallId, llmUsageByTurnId };
}
