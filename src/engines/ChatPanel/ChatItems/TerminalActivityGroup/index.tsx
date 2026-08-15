/**
 * TerminalActivityGroup
 *
 * Displays consecutive shell commands, MCP calls, and terminal follow-ups in
 * the same collapsible stack used by exploration summaries. Every item still
 * renders through the registry, preserving its specialized behavior.
 */
import { useAtomValue } from "jotai";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getToolIcon } from "@src/config/toolIcons";
import { isMcpToolEvent } from "@src/engines/ChatPanel/ChatHistory/chatItemPipeline/classifiers";
import ToolUsageBadge from "@src/engines/ChatPanel/blocks/ToolCallBlock/ToolUsageBadge";
import OrgtrackEnvelopeCard from "@src/engines/ChatPanel/blocks/ToolCallBlock/cards/OrgtrackEnvelopeCard";
import { parseOrgtrackEnvelope } from "@src/engines/ChatPanel/blocks/ToolCallBlock/helpers";
import { StackedBlock } from "@src/engines/ChatPanel/blocks/primitives";
import { type SessionEvent } from "@src/engines/SessionCore/core/types";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";

import {
  aggregateActivityGroupToolUsage,
  buildActivityGroupItems,
  renderActivityGroupEvent,
} from "../activityGroupProjection";

interface TerminalActivityGroupProps {
  events: SessionEvent[];
  closedByBoundary?: boolean;
}

function parseTerminalOrgtrackEnvelope(
  event: SessionEvent,
  context: {
    projectSlug?: string;
    projectName?: string;
    projectId?: string;
    orgId?: string;
  }
) {
  const extractedOutput =
    event.extracted?.kind === "shell" ? event.extracted.output : undefined;
  const durableOutput =
    event.shellReplay?.terminalPreview || extractedOutput || undefined;
  const result = durableOutput
    ? {
        ...(event.result ?? {}),
        stdout: durableOutput,
        exit_code: event.shellExitCode,
      }
    : (event.result ?? {});
  return parseOrgtrackEnvelope(event.args ?? {}, result, context);
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

const TerminalActivityGroup: React.FC<TerminalActivityGroupProps> = ({
  events,
  closedByBoundary = true,
}) => {
  const { t } = useTranslation("sessions");
  const session = useAtomValue(sessionByIdAtom(events[0]?.sessionId ?? ""));
  const items = useMemo(() => buildActivityGroupItems(events), [events]);
  const workItemResults = useMemo(
    () =>
      events.flatMap((event) => {
        const card = parseTerminalOrgtrackEnvelope(event, {
          projectSlug: session?.projectSlug,
          projectName: session?.projectName,
          projectId: session?.projectId,
          orgId: session?.orgId,
        });
        return card?.ok &&
          ["work.create", "work.update"].includes(card.operationId) &&
          card.shortId
          ? [card]
          : [];
      }),
    [
      events,
      session?.orgId,
      session?.projectId,
      session?.projectName,
      session?.projectSlug,
    ]
  );

  if (items.length === 0) return null;

  const firstEvent = items[0].event;
  const groupToolUsage = aggregateActivityGroupToolUsage(events);
  const groupSummary = buildGroupSummary(events, t);

  return (
    <>
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
            groupToolUsage ? (
              <ToolUsageBadge usage={groupToolUsage} />
            ) : undefined
          }
          renderItem={renderActivityGroupEvent}
        />
      </div>
      {workItemResults.map((card, index) => (
        <OrgtrackEnvelopeCard
          key={`${card.operationId}:${card.shortId}:${index}`}
          card={card}
        />
      ))}
    </>
  );
};

TerminalActivityGroup.displayName = "TerminalActivityGroup";

export default TerminalActivityGroup;
