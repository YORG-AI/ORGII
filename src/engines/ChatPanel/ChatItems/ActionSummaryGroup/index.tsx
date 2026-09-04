/**
 * ActionSummaryGroup Component
 *
 * Displays a collapsible group of consecutive exploration tool calls
 * (read, search, glob, list) using StackedBlock.
 *
 * Each event renders via the same registry event component used by
 * ActivityRouter — no manual data extraction or per-category block
 * construction. Loading / failed / completed states are handled by
 * each event component natively.
 */
import React, { Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";

import ToolUsageBadge from "@src/engines/ChatPanel/blocks/ToolCallBlock/ToolUsageBadge";
import {
  ChatLoadingBlock,
  StackedBlock,
} from "@src/engines/ChatPanel/blocks/primitives";
import {
  type SessionEvent,
  TOOL_USAGE_ARGS_KEY,
  type ToolUsageMetadata,
} from "@src/engines/SessionCore/core/types";
import { getChatLazyComponent } from "@src/engines/SessionCore/rendering/registry/events";
import { HugeiconsIcon, WaypointsIcon } from "@src/icons";
import { getRegistryEventType } from "@src/lib/activityData/activityNormalizers";

import type { ActionSummaryCategory } from "../../ChatHistory/chatItemPipeline/classifiers";
import type { ActionSummaryEntry } from "../../ChatHistory/chatItemPipeline/types";

// ============================================
// Types
// ============================================

interface ActionSummaryGroupProps {
  entries: ActionSummaryEntry[];
  items?: { category: ActionSummaryCategory; event: SessionEvent }[];
  closedByBoundary?: boolean;
}

interface CategorizedEvent {
  category: ActionSummaryCategory;
  event: SessionEvent;
  isLastItem?: boolean;
}

// ============================================
// Activity Block — renders via the registry
// ============================================

function ActivityBlock({ event }: { event: SessionEvent }) {
  const renderEvent = () => {
    const eventType = getRegistryEventType(
      event as unknown as Record<string, unknown>
    );
    const EventComponent = getChatLazyComponent(eventType);
    return <EventComponent event={event} />;
  };

  return <Suspense fallback={<ChatLoadingBlock />}>{renderEvent()}</Suspense>;
}

function suppressLoadingForNonLastRunningEvent(
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

// ============================================
// Header Label Builder
// ============================================

function buildGroupSummary(
  entries: ActionSummaryEntry[],
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  const parts: string[] = [];
  for (const entry of entries) {
    const count = entry.events.length;
    switch (entry.category) {
      case "read":
        parts.push(t("tools.exploreSummary.read", { count }));
        break;
      case "search":
        parts.push(t("tools.exploreSummary.search", { count }));
        break;
      case "glob":
        parts.push(t("tools.exploreSummary.glob", { count }));
        break;
      case "list":
        parts.push(t("tools.exploreSummary.ls", { count }));
        break;
      case "lsp":
        parts.push(t("tools.exploreSummary.lsp", { count }));
        break;
    }
  }
  return parts.join(t("tools.exploreSummary.separator"));
}

// ============================================
// Render Item — delegates to registry component
// ============================================

function readToolUsage(event: SessionEvent): ToolUsageMetadata | undefined {
  if (event.toolUsage) return event.toolUsage;
  const raw = event.args?.[TOOL_USAGE_ARGS_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  return raw as ToolUsageMetadata;
}

function aggregateToolUsage(
  items: readonly CategorizedEvent[]
): ToolUsageMetadata | undefined {
  const usages = items
    .map((item) => readToolUsage(item.event))
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

function renderEventBlock(
  { event, isLastItem }: CategorizedEvent,
  _index: number
): React.ReactNode {
  const renderedEvent = suppressLoadingForNonLastRunningEvent(
    event,
    isLastItem === true
  );
  return <ActivityBlock event={renderedEvent} />;
}

// ============================================
// Component
// ============================================

const ActionSummaryGroup: React.FC<ActionSummaryGroupProps> = ({
  entries,
  items,
  closedByBoundary = true,
}) => {
  const { t } = useTranslation("sessions");

  const totalCount = useMemo(
    () => entries.reduce((sum, entry) => sum + entry.events.length, 0),
    [entries]
  );

  const groupSummary = useMemo(
    () => buildGroupSummary(entries, t),
    [entries, t]
  );

  const orderedItems: CategorizedEvent[] = useMemo(() => {
    const baseItems =
      items && items.length > 0
        ? items
        : entries.flatMap((entry) =>
            entry.events.map((event) => ({
              category: entry.category,
              event,
            }))
          );

    return baseItems.map((item, index) => ({
      ...item,
      isLastItem: index === baseItems.length - 1,
    }));
  }, [items, entries]);

  if (totalCount === 0) return null;

  const firstEvent = orderedItems[0]?.event;
  const toolName =
    firstEvent?.functionName ||
    firstEvent?.uiCanonical ||
    firstEvent?.actionType;
  const groupToolUsage = aggregateToolUsage(orderedItems);

  return (
    <div
      data-tool-call-event-id={firstEvent?.id}
      data-tool-call-name={toolName}
    >
      <StackedBlock
        items={orderedItems}
        icon={
          <HugeiconsIcon
            icon={WaypointsIcon}
            data-icon="waypoints"
            size={14}
            className="text-text-2"
          />
        }
        label={t("tools.explore")}
        groupSummary={groupSummary}
        defaultCollapsed={closedByBoundary}
        collapseWhen={closedByBoundary}
        eventId={firstEvent?.id}
        rightContent={
          groupToolUsage ? <ToolUsageBadge usage={groupToolUsage} /> : undefined
        }
        renderItem={renderEventBlock}
      />
    </div>
  );
};

export default ActionSummaryGroup;
