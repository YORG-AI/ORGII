import React, { Suspense } from "react";

import { ChatLoadingBlock } from "@src/engines/ChatPanel/blocks/primitives";
import {
  type SessionEvent,
  TOOL_USAGE_ARGS_KEY,
  type ToolUsageMetadata,
} from "@src/engines/SessionCore/core/types";
import { getChatLazyComponent } from "@src/engines/SessionCore/rendering/registry/events";
import { getRegistryEventType } from "@src/lib/activityData/activityNormalizers";

export interface ActivityGroupEventItem {
  event: SessionEvent;
  isLastItem: boolean;
}

export function buildActivityGroupItems(
  events: readonly SessionEvent[]
): ActivityGroupEventItem[] {
  return events.map((event, index) => ({
    event,
    isLastItem: index === events.length - 1,
  }));
}

export function suppressIntermediateRunningState(
  event: SessionEvent,
  isLastItem: boolean
): SessionEvent {
  if (isLastItem || event.displayStatus !== "running") return event;
  return {
    ...event,
    displayStatus: "completed",
    activityStatus: "processed",
    isDelta: false,
  };
}

function readToolUsage(event: SessionEvent): ToolUsageMetadata | undefined {
  if (event.toolUsage) return event.toolUsage;
  const raw = event.args?.[TOOL_USAGE_ARGS_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  return raw as ToolUsageMetadata;
}

export function aggregateActivityGroupToolUsage(
  events: readonly SessionEvent[]
): ToolUsageMetadata | undefined {
  const usages = events
    .map(readToolUsage)
    .filter((usage): usage is ToolUsageMetadata => Boolean(usage));
  if (usages.length === 0) return undefined;

  return usages.reduce<ToolUsageMetadata>(
    (total, usage) => ({
      decisionCompletionTokens:
        total.decisionCompletionTokens + usage.decisionCompletionTokens,
      resultContextTokens:
        total.resultContextTokens + usage.resultContextTokens,
      followupCompletionTokens:
        total.followupCompletionTokens + usage.followupCompletionTokens,
      inputBytes: total.inputBytes + usage.inputBytes,
      outputBytes: total.outputBytes + usage.outputBytes,
      relatedCacheReadTokens:
        total.relatedCacheReadTokens + usage.relatedCacheReadTokens,
      relatedCacheWriteTokens:
        total.relatedCacheWriteTokens + usage.relatedCacheWriteTokens,
      attributionMethod:
        total.attributionMethod === usage.attributionMethod
          ? total.attributionMethod
          : usage.attributionMethod,
    }),
    {
      decisionCompletionTokens: 0,
      resultContextTokens: 0,
      followupCompletionTokens: 0,
      inputBytes: 0,
      outputBytes: 0,
      relatedCacheReadTokens: 0,
      relatedCacheWriteTokens: 0,
      attributionMethod: usages[0].attributionMethod,
    }
  );
}

function ActivityGroupEventBlock({ event }: { event: SessionEvent }) {
  const eventType = getRegistryEventType(
    event as unknown as Record<string, unknown>
  );
  const EventComponent = getChatLazyComponent(eventType);
  return (
    <Suspense fallback={<ChatLoadingBlock />}>
      {React.createElement(EventComponent, { event })}
    </Suspense>
  );
}

export function renderActivityGroupEvent({
  event,
  isLastItem,
}: ActivityGroupEventItem): React.ReactNode {
  return (
    <ActivityGroupEventBlock
      event={suppressIntermediateRunningState(event, isLastItem)}
    />
  );
}
