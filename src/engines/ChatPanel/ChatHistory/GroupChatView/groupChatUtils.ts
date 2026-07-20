import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import { TOOL_NAMES } from "@src/api/tauri/agent/toolNames";
import { willEventRenderContent } from "@src/engines/ChatPanel/ChatHistory/chatItemPipeline";
import { parseAgentMessageCard } from "@src/engines/ChatPanel/blocks/ToolCallBlock/helpers";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { getRegistryEventType } from "@src/lib/activityData/activityNormalizers";
import { prettifyMemberName } from "@src/util/data/formatters/memberName";

import {
  isAgentOrgGroupChatUserMessage,
  isAgentOrgInboxTranscriptEvent,
  isCoordinatorHumanUserEvent,
} from "./groupChatPredicates";
import { parseTaskAssignedPrompt } from "./parseTaskAssignedPrompt";

export {
  isAgentOrgGroupChatUserMessage,
  isAgentOrgInboxTranscriptEvent,
  isCoordinatorHumanUserEvent,
} from "./groupChatPredicates";

function readStringField(
  record: Record<string, unknown> | undefined,
  keys: readonly string[]
): string {
  if (!record) return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function extractGroupMessageContent(event: SessionEvent): string {
  const direct = readStringField(event.args, [
    "message",
    "content",
    "text",
    "body",
    "summary",
    "prompt",
    "question",
    "title",
  ]);
  if (direct) return direct;

  const result = event.result as Record<string, unknown> | undefined;
  const resultDirect = readStringField(result, [
    "message",
    "content",
    "text",
    "body",
    "summary",
    "response",
    "observation",
    "agent_response",
  ]);
  if (resultDirect) return resultDirect;

  const resultMessage = result?.message as
    | { content?: unknown; role?: string }
    | undefined;
  if (typeof resultMessage?.content === "string") return resultMessage.content;
  const resultMessageContent = resultMessage?.content;
  if (Array.isArray(resultMessageContent)) {
    const textPart = resultMessageContent.find(
      (part): part is { type?: string; text?: string } =>
        typeof part === "object" && part !== null && "text" in part
    );
    if (typeof textPart?.text === "string") return textPart.text;
  }

  return event.displayText || "";
}

function isGroupRenderableEvent(event: SessionEvent): boolean {
  if (event.source === "system") return false;
  return willEventRenderContent(event);
}

export function isTaskRelatedGroupChatEvent(event: SessionEvent): boolean {
  const functionName = event.functionName.toLowerCase();
  return (
    functionName === TOOL_NAMES.TASK_CREATE ||
    functionName === TOOL_NAMES.TASK_GRAPH_CREATE ||
    functionName === TOOL_NAMES.TASK_UPDATE ||
    functionName === TOOL_NAMES.TASK_LIST ||
    functionName === TOOL_NAMES.TASK_GET ||
    functionName === "org_task"
  );
}

function isMemberInternalUserPrompt(
  event: SessionEvent,
  coordinatorSessionId: string
): boolean {
  if (event.sessionId === coordinatorSessionId) return false;
  if (event.source !== "user") return false;
  if (isAgentOrgInboxTranscriptEvent(event)) return false;
  if (parseTaskAssignedPrompt(extractGroupMessageContent(event))) return false;
  return true;
}

export function resolveGroupSenderName(
  event: SessionEvent,
  coordinatorSessionId: string,
  orgMembers: ReadonlyArray<AgentOrgRunMemberView>
): string {
  if (event.sessionId === coordinatorSessionId) return "Coordinator";
  const member = orgMembers.find(
    (candidate) => candidate.sessionRuntime?.sessionId === event.sessionId
  );
  if (member?.name.trim()) return member.name.trim();
  if (member) return prettifyMemberName(member.memberId);
  return "Agent";
}

type GroupChatMessageEntryKind =
  | "message"
  | "detail"
  | "inboxTranscript"
  | "taskDetail";

interface GroupChatMessageEntry {
  event: SessionEvent;
  sender: "agent" | "user";
  entryKind: GroupChatMessageEntryKind;
}

interface Round {
  header: GroupChatMessageEntry | null;
  items: GroupChatMessageEntry[];
}

function convertToGroupEntry(
  event: SessionEvent,
  coordinatorSessionId: string,
  orgMembers: ReadonlyArray<AgentOrgRunMemberView>
): GroupChatMessageEntry | null {
  const isHumanUser = isCoordinatorHumanUserEvent(event, coordinatorSessionId);
  if (isHumanUser) {
    return {
      event,
      sender: "user",
      entryKind: "message",
    };
  }
  if (isMemberInternalUserPrompt(event, coordinatorSessionId)) return null;
  if (!isGroupRenderableEvent(event)) return null;
  const simpleMessage = resolveGroupChatMessageBubble(
    event,
    coordinatorSessionId,
    orgMembers
  );
  if (simpleMessage) {
    return {
      event,
      sender: "agent",
      entryKind: "message",
    };
  }
  if (isAgentOrgInboxTranscriptEvent(event)) {
    return {
      event,
      sender: "agent",
      entryKind: "inboxTranscript",
    };
  }
  if (isTaskRelatedGroupChatEvent(event)) {
    return {
      event,
      sender: "agent",
      entryKind: "taskDetail",
    };
  }
  return {
    event,
    sender: "agent",
    entryKind: "detail",
  };
}

function buildRounds(entries: GroupChatMessageEntry[]): Round[] {
  const rounds: Round[] = [];
  let current: Round | null = null;
  for (const entry of entries) {
    if (entry.sender === "user") {
      current = { header: entry, items: [] };
      rounds.push(current);
      continue;
    }
    if (!current) {
      current = { header: null, items: [] };
      rounds.push(current);
    }
    current.items.push(entry);
  }
  return rounds;
}

function mergeEntryStreams(
  streams: ReadonlyArray<{
    sessionId: string;
    entries: GroupChatMessageEntry[];
  }>
): GroupChatMessageEntry[] {
  const flat: Array<
    GroupChatMessageEntry & { timestamp: string; order: number }
  > = [];
  for (const { sessionId, entries } of streams) {
    entries.forEach((entry, order) => {
      flat.push({
        ...entry,
        timestamp: entry.event.createdAt,
        order,
        event: {
          ...entry.event,
          sessionId: entry.event.sessionId || sessionId,
        },
      });
    });
  }
  flat.sort((entryA, entryB) => {
    const msA = new Date(entryA.timestamp).getTime();
    const msB = new Date(entryB.timestamp).getTime();
    if (msA !== msB) return msA - msB;
    const sidA = entryA.event.sessionId;
    const sidB = entryB.event.sessionId;
    if (sidA !== sidB) return sidA < sidB ? -1 : 1;
    return entryA.order - entryB.order;
  });
  return flat.map(({ event, sender, entryKind }) => ({
    event,
    sender,
    entryKind,
  }));
}

function compactGroupChatDetailEntries(
  entries: GroupChatMessageEntry[],
  coordinatorSessionId: string,
  orgMembers: ReadonlyArray<AgentOrgRunMemberView>
): SessionEvent[] {
  const output: SessionEvent[] = [];
  let sequenceSenderName: string | null = null;
  let sequenceLastMessageIndex: number | null = null;
  let sequenceSummary = emptyGroupChatToolUseSummary();

  const flushSequenceSummary = () => {
    if (
      sequenceLastMessageIndex === null ||
      !hasGroupChatToolUseSummary(sequenceSummary)
    ) {
      return;
    }
    output[sequenceLastMessageIndex] = attachGroupChatToolUseSummary(
      output[sequenceLastMessageIndex],
      sequenceSummary
    );
  };

  const resetSequence = (senderName: string | null) => {
    flushSequenceSummary();
    sequenceSenderName = senderName;
    sequenceLastMessageIndex = null;
    sequenceSummary = emptyGroupChatToolUseSummary();
  };

  for (const entry of entries) {
    if (entry.sender === "user") {
      resetSequence(null);
      output.push(entry.event);
      continue;
    }

    const senderName = resolveGroupSenderName(
      entry.event,
      coordinatorSessionId,
      orgMembers
    );
    if (senderName !== sequenceSenderName) {
      resetSequence(senderName);
    }

    if (entry.entryKind === "message") {
      output.push(entry.event);
      sequenceLastMessageIndex = output.length - 1;
      continue;
    }

    if (
      entry.entryKind === "inboxTranscript" ||
      entry.entryKind === "taskDetail"
    ) {
      flushSequenceSummary();
      output.push(entry.event);
      sequenceLastMessageIndex = null;
      sequenceSummary = emptyGroupChatToolUseSummary();
      continue;
    }

    sequenceSummary = addGroupChatToolUseSummaryEvent(
      sequenceSummary,
      entry.event
    );
  }

  flushSequenceSummary();
  return output;
}

export function buildGroupChatSessionEvents(
  eventsBySession: ReadonlyMap<string, SessionEvent[]>,
  agentSessionIds: ReadonlySet<string>,
  coordinatorSessionId: string,
  orgMembers: ReadonlyArray<AgentOrgRunMemberView>
): SessionEvent[] {
  const streams: { sessionId: string; entries: GroupChatMessageEntry[] }[] = [];
  for (const [sessionId, events] of eventsBySession) {
    if (!agentSessionIds.has(sessionId)) continue;
    const entries: GroupChatMessageEntry[] = [];
    events.forEach((event) => {
      const entry = convertToGroupEntry(
        event,
        coordinatorSessionId,
        orgMembers
      );
      if (entry) entries.push(entry);
    });
    streams.push({ sessionId, entries });
  }

  const merged = mergeEntryStreams(streams);
  const rounds = buildRounds(merged);
  const compactedEntries: GroupChatMessageEntry[] = [];
  for (const round of rounds) {
    if (round.header) {
      compactedEntries.push(round.header);
    }
    for (const item of round.items) {
      compactedEntries.push(item);
    }
  }
  return compactGroupChatDetailEntries(
    compactedEntries,
    coordinatorSessionId,
    orgMembers
  );
}

export function resolveGroupSenderNameForSession(
  sessionId: string,
  coordinatorSessionId: string,
  orgMembers: ReadonlyArray<AgentOrgRunMemberView>
): string {
  if (sessionId === coordinatorSessionId) return "Coordinator";
  const member = orgMembers.find(
    (candidate) => candidate.sessionRuntime?.sessionId === sessionId
  );
  if (member?.name.trim()) return member.name.trim();
  if (member) return prettifyMemberName(member.memberId);
  return "Agent";
}

export function resolveGroupMessageRecipient(
  event: SessionEvent,
  coordinatorSessionId: string,
  orgMembers: ReadonlyArray<AgentOrgRunMemberView>
): string | null {
  const args = event.args ?? {};
  const recipientMemberId = readStringField(args, [
    "recipient_member_id",
    "recipientMemberId",
  ]);
  if (recipientMemberId) {
    const member = orgMembers.find(
      (candidate) => candidate.memberId === recipientMemberId
    );
    if (member?.name.trim()) return member.name.trim();
    return prettifyMemberName(recipientMemberId);
  }

  const recipientSessionId = readStringField(args, [
    "recipient_session_id",
    "recipientSessionId",
  ]);
  if (recipientSessionId) {
    return resolveGroupSenderNameForSession(
      recipientSessionId,
      coordinatorSessionId,
      orgMembers
    );
  }

  return null;
}

export type GroupChatMessageBubbleKind =
  | "task"
  | "agent_message"
  | "org_send_message";

export interface GroupChatMessageBubbleContent {
  senderName: string;
  recipientName: string | null;
  bodyMarkdown: string;
  kind: GroupChatMessageBubbleKind;
}

export interface GroupChatToolUseSummary {
  readFiles: number;
  editedFiles: number;
  terminalUses: number;
  explorations: number;
  otherTools: number;
}

const GROUP_CHAT_TOOL_USE_SUMMARY_RESULT_KEY = "__groupChatToolUseSummary";

function attachGroupChatToolUseSummary(
  event: SessionEvent,
  summary: GroupChatToolUseSummary
): SessionEvent {
  return {
    ...event,
    result: {
      ...(event.result ?? {}),
      [GROUP_CHAT_TOOL_USE_SUMMARY_RESULT_KEY]: summary,
    },
  };
}

export function resolveGroupChatToolUseSummary(
  event: SessionEvent
): GroupChatToolUseSummary | null {
  if (typeof event.result !== "object" || event.result === null) return null;
  const candidate = event.result[GROUP_CHAT_TOOL_USE_SUMMARY_RESULT_KEY];
  if (typeof candidate !== "object" || candidate === null) return null;
  const record = candidate as Partial<
    Record<keyof GroupChatToolUseSummary, unknown>
  >;
  const summary: GroupChatToolUseSummary = {
    readFiles: typeof record.readFiles === "number" ? record.readFiles : 0,
    editedFiles:
      typeof record.editedFiles === "number" ? record.editedFiles : 0,
    terminalUses:
      typeof record.terminalUses === "number" ? record.terminalUses : 0,
    explorations:
      typeof record.explorations === "number" ? record.explorations : 0,
    otherTools: typeof record.otherTools === "number" ? record.otherTools : 0,
  };
  return hasGroupChatToolUseSummary(summary) ? summary : null;
}

export function resolveGroupChatMessageBubble(
  event: SessionEvent,
  coordinatorSessionId: string,
  orgMembers: ReadonlyArray<AgentOrgRunMemberView>
): GroupChatMessageBubbleContent | null {
  const parsedTask = parseTaskAssignedPrompt(extractGroupMessageContent(event));
  if (parsedTask) {
    const recipientName = resolveGroupSenderName(
      event,
      coordinatorSessionId,
      orgMembers
    );
    return {
      senderName: parsedTask.assignedBy,
      recipientName,
      bodyMarkdown: parsedTask.description.trim(),
      kind: "task",
    };
  }

  const registryType = getRegistryEventType(event);
  const senderName = resolveGroupSenderName(
    event,
    coordinatorSessionId,
    orgMembers
  );

  if (isAgentOrgGroupChatUserMessage(event)) return null;

  if (registryType === "agent_message") {
    const body = extractGroupMessageContent(event).trim();
    if (!body) return null;
    const result = event.result as Record<string, unknown> | undefined;
    const replyRecipientName =
      typeof result?.agentOrgReplyRecipientName === "string"
        ? result.agentOrgReplyRecipientName.trim()
        : "";
    const recipientName =
      replyRecipientName ||
      (event.sessionId !== coordinatorSessionId ? "Coordinator" : null);
    return {
      senderName,
      recipientName,
      bodyMarkdown: body,
      kind: "agent_message",
    };
  }

  const functionName = event.functionName?.toLowerCase() ?? "";
  if (functionName === TOOL_NAMES.ORG_SEND_MESSAGE) {
    const card = parseAgentMessageCard(event.args ?? {}, event.result ?? {});
    const body = (card.fullText || card.summary || "").trim();
    if (!body && !card.recipient) return null;

    let recipientName: string | null = null;
    if (!card.isBroadcast) {
      const cardRecipient =
        card.recipient && card.recipient !== "?" ? card.recipient : null;
      recipientName =
        cardRecipient ??
        resolveGroupMessageRecipient(event, coordinatorSessionId, orgMembers);
    }

    return {
      senderName,
      recipientName,
      bodyMarkdown: body,
      kind: "org_send_message",
    };
  }

  return null;
}

export function isCoordinatorSessionEvent(
  event: SessionEvent,
  coordinatorSessionId: string
): boolean {
  return event.sessionId === coordinatorSessionId;
}

export function isGroupChatDetailSummaryEvent(
  event: SessionEvent,
  coordinatorSessionId: string
): boolean {
  if (isCoordinatorSessionEvent(event, coordinatorSessionId)) return false;
  if (event.source === "system") return false;
  if (isAgentOrgInboxTranscriptEvent(event)) return false;
  if (isTaskRelatedGroupChatEvent(event)) return false;
  if (isMemberInternalUserPrompt(event, coordinatorSessionId)) return false;
  if (resolveGroupChatMessageBubble(event, coordinatorSessionId, []) !== null) {
    return false;
  }
  return isGroupRenderableEvent(event);
}

export function emptyGroupChatToolUseSummary(): GroupChatToolUseSummary {
  return {
    readFiles: 0,
    editedFiles: 0,
    terminalUses: 0,
    explorations: 0,
    otherTools: 0,
  };
}

export function addGroupChatToolUseSummaryEvent(
  summary: GroupChatToolUseSummary,
  event: SessionEvent
): GroupChatToolUseSummary {
  const functionName = event.functionName.toLowerCase();
  if (
    functionName.includes("read") ||
    functionName.includes("grep") ||
    functionName.includes("glob")
  ) {
    return { ...summary, readFiles: summary.readFiles + 1 };
  }
  if (
    functionName.includes("edit") ||
    functionName.includes("write") ||
    functionName.includes("replace") ||
    functionName.includes("delete")
  ) {
    return { ...summary, editedFiles: summary.editedFiles + 1 };
  }
  if (
    functionName.includes("terminal") ||
    functionName.includes("shell") ||
    functionName.includes("bash") ||
    functionName.includes("command")
  ) {
    return { ...summary, terminalUses: summary.terminalUses + 1 };
  }
  if (
    functionName.includes("explore") ||
    functionName.includes("search") ||
    functionName.includes("list")
  ) {
    return { ...summary, explorations: summary.explorations + 1 };
  }
  return { ...summary, otherTools: summary.otherTools + 1 };
}

export function hasGroupChatToolUseSummary(
  summary: GroupChatToolUseSummary
): boolean {
  return (
    summary.readFiles > 0 ||
    summary.editedFiles > 0 ||
    summary.terminalUses > 0 ||
    summary.explorations > 0 ||
    summary.otherTools > 0
  );
}
