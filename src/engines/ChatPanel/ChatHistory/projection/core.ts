import type { SessionInfo } from "@src/engines/ChatPanel/ChatItems/SessionHeader";
import {
  THREAD_LIFECYCLE_ACTIONS,
  formatThreadDisplayName,
} from "@src/engines/ChatPanel/ThreadSelector/config";
import type { ExecutionThread } from "@src/engines/ChatPanel/ThreadSelector/types";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { processChatItems } from "../chatItemPipeline";
import type {
  ChatPipelineSkipPolicy,
  OptimizedChatItem,
} from "../chatItemPipeline/types";
import {
  type ChatGroupsProjectionOptions,
  type UseChatGroupsReturn,
  projectChatGroups,
} from "../hooks/useChatGroupsProjection";

export interface ChatHistoryProjectionOptions {
  selectedThreadId?: string | null;
  skipPolicy?: ChatPipelineSkipPolicy;
  groups?: ChatGroupsProjectionOptions;
}

export interface ChatHistoryProjectionResult {
  optimizedChatHistory: OptimizedChatItem[];
  sessionInfo: SessionInfo | null;
  groups?: UseChatGroupsReturn;
  projectionRevision: number;
  groupShapeDigest: string;
  itemShapeDigest: string;
}

interface ThreadInfo {
  eventCount: number;
  hasStart: boolean;
  hasEnd: boolean;
  firstEventId: string;
  firstEventTime: string;
}

interface ExecutionRoundInfo {
  roundNumber: number;
  threads: Map<string, ThreadInfo>;
}

function readSessionInfo(events: readonly SessionEvent[]): SessionInfo | null {
  const sessionStartEvent = events.find(
    (event) => event.actionType === "session_start"
  );
  if (!sessionStartEvent) return null;
  return {
    sessionId: sessionStartEvent.sessionId,
    model:
      (sessionStartEvent.args?.model as string) ||
      (sessionStartEvent.result?.model as string) ||
      "",
    startedAt: sessionStartEvent.createdAt,
  };
}

function collectExecutionRounds(
  events: readonly SessionEvent[]
): ExecutionRoundInfo[] {
  const rounds: ExecutionRoundInfo[] = [];
  let currentRound: ExecutionRoundInfo | null = null;
  let inThreadSection = false;

  for (const event of events) {
    const threadId = event.threadId;
    if (threadId) {
      if (!inThreadSection) {
        inThreadSection = true;
        currentRound = { roundNumber: rounds.length + 1, threads: new Map() };
        rounds.push(currentRound);
      }
      if (!currentRound) continue;
      const existing = currentRound.threads.get(threadId) ?? {
        eventCount: 0,
        hasStart: false,
        hasEnd: false,
        firstEventId: event.id || "",
        firstEventTime: event.createdAt || "",
      };
      existing.eventCount += 1;
      if (
        event.createdAt &&
        (!existing.firstEventTime || event.createdAt < existing.firstEventTime)
      ) {
        existing.firstEventTime = event.createdAt;
        existing.firstEventId = event.id || "";
      }
      if (event.actionType === THREAD_LIFECYCLE_ACTIONS.start) {
        existing.hasStart = true;
      }
      if (event.actionType === THREAD_LIFECYCLE_ACTIONS.end) {
        existing.hasEnd = true;
      }
      currentRound.threads.set(threadId, existing);
    } else if (event.actionType === "session_end") {
      inThreadSection = false;
      currentRound = null;
    }
  }
  return rounds;
}

function filterByThread(
  items: OptimizedChatItem[],
  selectedThreadId: string | null
): OptimizedChatItem[] {
  if (!selectedThreadId) return items;
  const result: OptimizedChatItem[] = [];
  for (const item of items) {
    if (item.type === "activity") {
      if (!item.event?.threadId || item.event.threadId === selectedThreadId) {
        result.push(item);
      }
      continue;
    }
    if (item.readFileEvents) {
      const readFileEvents = item.readFileEvents.filter(
        (event) => !event.threadId || event.threadId === selectedThreadId
      );
      if (readFileEvents.length > 0) result.push({ ...item, readFileEvents });
      continue;
    }
    if (item.activityStackGroup) {
      const events = item.activityStackGroup.events.filter(
        (event) => !event.threadId || event.threadId === selectedThreadId
      );
      if (events.length > 0) {
        result.push({
          ...item,
          activityStackGroup: { ...item.activityStackGroup, events },
        });
      }
      continue;
    }
    result.push(item);
  }
  return result;
}

function insertThreadSelectors(
  pipelineItems: OptimizedChatItem[],
  executionRounds: ExecutionRoundInfo[],
  selectedThreadId: string | null
): OptimizedChatItem[] {
  const selectors: OptimizedChatItem[] = executionRounds
    .filter((round) => round.threads.size > 0)
    .map((round) => ({
      type: "threadSelector",
      chunk_id: `thread-selector-round-${round.roundNumber}`,
      threadSelectorData: {
        roundNumber: round.roundNumber,
        threads: Array.from(round.threads).map(([threadId, info]) => ({
          threadId,
          displayName: formatThreadDisplayName(threadId),
          isActive: selectedThreadId === threadId,
          eventCount: info.eventCount,
          isCompleted: info.hasEnd,
          isRunning: info.hasStart && !info.hasEnd,
        })) satisfies ExecutionThread[],
        threadFirstEventMap: new Map(
          Array.from(round.threads)
            .filter(([, info]) => Boolean(info.firstEventId))
            .map(([threadId, info]) => [threadId, info.firstEventId])
        ),
      },
    }));
  if (selectors.length === 0) return pipelineItems;

  const result: OptimizedChatItem[] = [];
  let selectorIndex = 0;
  let insertedForCurrentSection = false;
  for (const item of pipelineItems) {
    const isThreadActivity =
      item.type === "activity" && Boolean(item.event?.threadId);
    if (!isThreadActivity) insertedForCurrentSection = false;
    if (
      selectorIndex < selectors.length &&
      !insertedForCurrentSection &&
      isThreadActivity
    ) {
      result.push(selectors[selectorIndex++]);
      insertedForCurrentSection = true;
    }
    result.push(item);
  }
  while (selectorIndex < selectors.length)
    result.push(selectors[selectorIndex++]);
  return result;
}

function digestGroupShape(groups: UseChatGroupsReturn): string {
  let hash = 2166136261;
  const update = (value: string | number | null | undefined) => {
    const text = String(value ?? "");
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  for (let index = 0; index < groups.groupCounts.length; index++) {
    const header = groups.groupHeaders[index];
    update(groups.groupCounts[index] ?? 0);
    update(header?.chunk_id);
    update(header?.event?.displayText?.length ?? 0);
  }
  return (hash >>> 0).toString(36);
}

function digestItemShape(items: readonly OptimizedChatItem[]): string {
  let hash = 2166136261;
  const update = (value: string | number | boolean | null | undefined) => {
    const text = String(value ?? "");
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  for (const item of items) {
    update(item.chunk_id);
    update(item.type);
    update(item.structuralOnly === true);
    update(item.event?.displayVariant);
    update(item.event?.displayText?.length ?? 0);
    update(item.readFileEvents?.length ?? 0);
    update(item.actionSummaryItems?.length ?? 0);
    update(item.activityStackGroup?.events.length ?? 0);
  }
  return (hash >>> 0).toString(36);
}

export function projectChatHistory(
  events: SessionEvent[],
  options: ChatHistoryProjectionOptions = {}
): ChatHistoryProjectionResult {
  const selectedThreadId =
    options.selectedThreadId &&
    events.some((event) => event.threadId === options.selectedThreadId)
      ? options.selectedThreadId
      : null;
  const base = processChatItems(events, {
    consolidatePartialObservations: true,
    skipPolicy: options.skipPolicy ?? "none",
  }).items;
  const filtered = filterByThread(base, selectedThreadId);
  const optimizedChatHistory = insertThreadSelectors(
    filtered,
    collectExecutionRounds(events),
    selectedThreadId
  );
  const groups = options.groups
    ? projectChatGroups(optimizedChatHistory, options.groups)
    : undefined;
  return {
    optimizedChatHistory,
    sessionInfo: readSessionInfo(events),
    groups,
    projectionRevision: 0,
    groupShapeDigest: groups ? digestGroupShape(groups) : "0",
    itemShapeDigest: digestItemShape(groups?.flatItems ?? optimizedChatHistory),
  };
}
