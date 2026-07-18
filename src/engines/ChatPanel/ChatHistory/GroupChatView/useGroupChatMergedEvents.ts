import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  AGENT_ORG_USER_SENDER_ID,
  type AgentOrgGroupChatHistoryRow,
  type AgentOrgInboxPreviewRow,
  type AgentOrgRunMemberView,
} from "@src/api/tauri/agent";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { chatEventsForSessionAtomFamily } from "@src/engines/SessionCore/derived/sessionScopedChatEvents";

import { buildGroupChatSessionEvents } from "./groupChatUtils";
import { buildAgentList } from "./useGroupChatFeed";

interface AgentEventsTapProps {
  sessionId: string;
  onEvents: (sessionId: string, events: SessionEvent[]) => void;
}

function AgentEventsTap({ sessionId, onEvents }: AgentEventsTapProps) {
  const events = useAtomValue(chatEventsForSessionAtomFamily(sessionId));
  useEffect(() => {
    onEvents(sessionId, events);
  }, [sessionId, events, onEvents]);
  return null;
}

function toTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function inboxRowToGroupChatUserEvent(
  row: AgentOrgGroupChatHistoryRow,
  coordinatorSessionId: string
): SessionEvent | null {
  const text = row.displayText.trim();
  if (!text.trim()) return null;
  return {
    id: `agent-org-group-user-${row.inboxId}`,
    chunk_id: `agent-org-group-user-${row.inboxId}`,
    sessionId: coordinatorSessionId,
    createdAt: row.createdAt,
    functionName: "agent_org_group_chat_user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {
      recipientMemberId: row.targetMemberId,
      deliveryResolution: row.deliveryResolution ?? null,
      agentOrgGroupChatMessage: true,
    },
    result: {
      type: "user",
      message: { content: text, role: "user" },
      agentOrgGroupChatMessage: true,
    },
    source: "user",
    displayText: text,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  };
}

function groupChatEventIdentity(event: SessionEvent): string {
  const chunkId = typeof event.chunk_id === "string" ? event.chunk_id : "";
  const id = event.id || chunkId;
  if (id) return `${event.sessionId}:${id}`;
  return [
    event.sessionId,
    event.createdAt,
    event.source,
    event.functionName,
    event.displayText,
  ].join("|");
}

function isGroupChatUserSessionEvent(event: SessionEvent): boolean {
  return Boolean(
    event.source === "user" &&
    (event.args?.agentOrgGroupChatMessage === true ||
      event.result?.agentOrgGroupChatMessage === true)
  );
}

function dedupeGroupChatEvents(events: SessionEvent[]): SessionEvent[] {
  const seen = new Set<string>();
  const output: SessionEvent[] = [];
  for (const event of events) {
    const identity = groupChatEventIdentity(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    output.push(event);
  }
  return output;
}

function annotateRepliesToUser(
  eventsBySession: ReadonlyMap<string, SessionEvent[]>,
  inboxRows: ReadonlyArray<AgentOrgInboxPreviewRow>,
  orgMembers: ReadonlyArray<AgentOrgRunMemberView>
): ReadonlyMap<string, SessionEvent[]> {
  const replyCutoffsBySession = new Map<string, number[]>();
  for (const row of inboxRows) {
    if (row.senderAgentId !== AGENT_ORG_USER_SENDER_ID) continue;
    const readAtMs = toTimestampMs(row.readAt);
    if (readAtMs === null) continue;
    const member = orgMembers.find(
      (candidate) => candidate.memberId === row.recipientMemberId
    );
    const sessionId = member?.sessionRuntime?.sessionId;
    if (!sessionId) continue;
    const cutoffs = replyCutoffsBySession.get(sessionId) ?? [];
    cutoffs.push(readAtMs);
    replyCutoffsBySession.set(sessionId, cutoffs);
  }
  if (replyCutoffsBySession.size === 0) return eventsBySession;

  const annotated = new Map(eventsBySession);
  for (const [sessionId, cutoffs] of replyCutoffsBySession) {
    const events = annotated.get(sessionId);
    if (!events || events.length === 0) continue;
    const sortedCutoffs = [...cutoffs].sort((left, right) => left - right);
    const usedEventIds = new Set<string>();
    const nextEvents = events.map((event) => ({ ...event }));
    for (const cutoffMs of sortedCutoffs) {
      const eventIndex = nextEvents.findIndex((event) => {
        if (usedEventIds.has(event.id)) return false;
        if (event.source !== "assistant") return false;
        const eventMs = toTimestampMs(event.createdAt);
        return (
          eventMs !== null && eventMs >= cutoffMs && event.displayText.trim()
        );
      });
      if (eventIndex < 0) continue;
      const event = nextEvents[eventIndex];
      usedEventIds.add(event.id);
      nextEvents[eventIndex] = {
        ...event,
        result: {
          ...(typeof event.result === "object" && event.result !== null
            ? event.result
            : {}),
          agentOrgReplyRecipientName: "User",
        },
      };
    }
    annotated.set(sessionId, nextEvents);
  }
  return annotated;
}

export function useGroupChatMergedEvents(
  coordinatorSessionId: string | null,
  orgMembers: ReadonlyArray<AgentOrgRunMemberView>,
  historyRows: ReadonlyArray<AgentOrgGroupChatHistoryRow> = [],
  inboxPreviewRows: ReadonlyArray<AgentOrgInboxPreviewRow> = []
): {
  mergedEvents: SessionEvent[];
  agents: ReturnType<typeof buildAgentList>;
  handleTapEvents: (sessionId: string, events: SessionEvent[]) => void;
} {
  const agents = useMemo(
    () =>
      coordinatorSessionId
        ? buildAgentList(coordinatorSessionId, orgMembers)
        : [],
    [coordinatorSessionId, orgMembers]
  );

  const [eventsBySession, setEventsBySession] = useState<
    ReadonlyMap<string, SessionEvent[]>
  >(() => new Map());

  const handleTapEvents = useCallback(
    (sessionId: string, events: SessionEvent[]) => {
      setEventsBySession((prev) => {
        if (prev.get(sessionId) === events) return prev;
        const next = new Map(prev);
        next.set(sessionId, events);
        return next;
      });
    },
    []
  );

  const agentSessionIds = useMemo(
    () => new Set(agents.map((agent) => agent.sessionId)),
    [agents]
  );

  const mergedEvents = useMemo(() => {
    if (!coordinatorSessionId || agents.length === 0) return [];
    const annotatedEventsBySession = annotateRepliesToUser(
      eventsBySession,
      inboxPreviewRows,
      orgMembers
    );
    const sessionEvents = buildGroupChatSessionEvents(
      annotatedEventsBySession,
      agentSessionIds,
      coordinatorSessionId,
      orgMembers
    ).filter((event) => !isGroupChatUserSessionEvent(event));
    const inboxEvents = historyRows
      .map((row) => inboxRowToGroupChatUserEvent(row, coordinatorSessionId))
      .filter((event): event is SessionEvent => event !== null);
    return dedupeGroupChatEvents([...sessionEvents, ...inboxEvents]).sort(
      (eventA, eventB) => {
        const msA = new Date(eventA.createdAt).getTime();
        const msB = new Date(eventB.createdAt).getTime();
        if (msA !== msB) return msA - msB;
        return eventA.id < eventB.id ? -1 : 1;
      }
    );
  }, [
    agents.length,
    agentSessionIds,
    coordinatorSessionId,
    eventsBySession,
    historyRows,
    inboxPreviewRows,
    orgMembers,
  ]);

  return {
    mergedEvents,
    agents,
    handleTapEvents,
  };
}

export { AgentEventsTap };
