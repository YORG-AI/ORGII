/**
 * TerminalActivityGroup
 *
 * Displays consecutive shell commands, MCP calls, and terminal follow-ups in
 * the same collapsible stack used by exploration summaries. Every item still
 * renders through the registry, preserving its specialized behavior.
 */
import React, { Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getToolIcon } from "@src/config/toolIcons";
import { isMcpToolEvent } from "@src/engines/ChatPanel/ChatHistory/chatItemPipeline/classifiers";
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
import { getRegistryEventType } from "@src/lib/activityData/activityNormalizers";

interface TerminalActivityGroupProps {
  events: SessionEvent[];
  closedByBoundary?: boolean;
}

interface TerminalEventItem {
  event: SessionEvent;
  isLastItem: boolean;
}

export function buildGroupSummary(
  events: readonly SessionEvent[],
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  let commandCount = 0;
  let mcpCount = 0;
  let waitCount = 0;
  let inspectCount = 0;

  for (const event of events) {
    const canonical = event.uiCanonical || event.functionName;
    if (isMcpToolEvent(event)) {
      mcpCount++;
    } else if (canonical === "await_output") {
      waitCount++;
    } else if (canonical === "inspect_terminals") {
      inspectCount++;
    } else {
      commandCount++;
    }
  }

  const parts: string[] = [];
  if (commandCount > 0) {
    parts.push(t("tools.terminalSummary.command", { count: commandCount }));
  }
  if (mcpCount > 0) {
    parts.push(t("tools.terminalSummary.mcp", { count: mcpCount }));
  }
  if (waitCount > 0) {
    parts.push(t("tools.terminalSummary.wait", { count: waitCount }));
  }
  if (inspectCount > 0) {
    parts.push(t("tools.terminalSummary.check", { count: inspectCount }));
  }
  return parts.join(t("tools.terminalSummary.separator"));
}

function ActivityBlock({ event }: { event: SessionEvent }) {
  const eventType = getRegistryEventType(
    event as unknown as Record<string, unknown>
  );
  const EventComponent = getChatLazyComponent(eventType);
  const renderedEvent = React.createElement(EventComponent, { event });
  return <Suspense fallback={<ChatLoadingBlock />}>{renderedEvent}</Suspense>;
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

function readToolUsage(event: SessionEvent): ToolUsageMetadata | undefined {
  if (event.toolUsage) return event.toolUsage;
  const raw = event.args?.[TOOL_USAGE_ARGS_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  return raw as ToolUsageMetadata;
}

function aggregateToolUsage(
  items: readonly TerminalEventItem[]
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

function renderTerminalEvent(
  { event, isLastItem }: TerminalEventItem,
  _index: number
): React.ReactNode {
  return (
    <ActivityBlock
      event={suppressLoadingForNonLastRunningEvent(event, isLastItem)}
    />
  );
}

const TerminalActivityGroup: React.FC<TerminalActivityGroupProps> = ({
  events,
  closedByBoundary = true,
}) => {
  const { t } = useTranslation("sessions");
  const items = useMemo<TerminalEventItem[]>(
    () =>
      events.map((event, index) => ({
        event,
        isLastItem: index === events.length - 1,
      })),
    [events]
  );

  if (items.length === 0) return null;

  const firstEvent = items[0].event;
  const groupToolUsage = aggregateToolUsage(items);
  const groupSummary = buildGroupSummary(events, t);

  return (
    <div
      data-tool-call-event-id={firstEvent.id}
      data-tool-call-name={
        firstEvent.functionName ||
        firstEvent.uiCanonical ||
        firstEvent.actionType
      }
    >
      <StackedBlock
        items={items}
        icon={getToolIcon("run_shell", {
          size: 14,
          className: "text-text-2",
        })}
        label={t("tools.runCommands")}
        groupSummary={groupSummary}
        defaultCollapsed={closedByBoundary}
        collapseWhen={closedByBoundary}
        eventId={firstEvent.id}
        rightContent={
          groupToolUsage ? <ToolUsageBadge usage={groupToolUsage} /> : undefined
        }
        renderItem={renderTerminalEvent}
      />
    </div>
  );
};

TerminalActivityGroup.displayName = "TerminalActivityGroup";

export default TerminalActivityGroup;
