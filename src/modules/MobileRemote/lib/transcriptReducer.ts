/** Minimal transcript projection from orgii/snapshot upserts (Phase 0). */
import type { ExtractedData } from "@src/engines/SessionCore/core/types";

export type TranscriptItemKind = "user" | "agent" | "tool";

export type MobileToolData =
  | ExtractedData
  | ({ kind: "unknown" } & Record<string, unknown>);

export interface TranscriptItem {
  id: string;
  kind: TranscriptItemKind;
  text: string;
  toolName?: string;
  toolCanonical?: string;
  toolStatus?: string;
  toolSummary?: string;
  toolData?: MobileToolData;
  toolDataTruncated?: boolean;
  toolFilePath?: string;
  toolCommand?: string;
  toolCallId?: string;
  streaming?: boolean;
  createdAt?: string;
  /** Frontend-only row shown until the EventStore echoes this user turn. */
  optimistic?: boolean;
  /** Canonical identity shared by submit, persistence, and snapshot echo. */
  turnIntentId?: string;
  /** Last authoritative row visible when this optimistic turn was submitted. */
  localAnchorId?: string;
}

export interface SnapshotUpsertEvent {
  id?: string;
  turnIntentId?: string;
  uiCanonical?: string;
  functionName?: string;
  actionType?: string;
  source?: string;
  displayVariant?: string;
  displayStatus?: string;
  displayText?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  toolSummary?: string;
  toolData?: MobileToolData;
  toolDataTruncated?: boolean;
  filePath?: string;
  command?: string;
  callId?: string;
  createdAt?: string;
}

export interface TranscriptState {
  items: TranscriptItem[];
}

export interface TranscriptPatchOptions {
  removedIds?: string[];
  /** Full snapshots replace the prior projection; deltas merge by event id. */
  replace?: boolean;
}

export const MAX_MOBILE_TRANSCRIPT_ITEMS = 1_000;

export function createInitialTranscriptState(): TranscriptState {
  return { items: [] };
}

function resolveEventId(event: SnapshotUpsertEvent, index: number): string {
  return event.id ?? `evt-${index}`;
}

function resolveCanonical(event: SnapshotUpsertEvent): string {
  return (event.uiCanonical ?? event.functionName ?? "").toLowerCase();
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveEventText(event: SnapshotUpsertEvent): string {
  if (typeof event.displayText === "string" && event.displayText.trim()) {
    return event.displayText;
  }
  const direct = [
    event.args?.content,
    event.result?.content,
    event.result?.output,
    event.result?.observation,
    event.result?.response,
  ]
    .map(stringField)
    .find(Boolean);
  if (direct) return direct;

  const message = event.result?.message;
  if (message && typeof message === "object") {
    return stringField((message as Record<string, unknown>).content);
  }
  return "";
}

function isUserMessage(event: SnapshotUpsertEvent, canonical: string): boolean {
  return (
    event.source?.toLowerCase() === "user" ||
    canonical === "user" ||
    canonical === "user_message"
  );
}

function isAgentMessage(
  event: SnapshotUpsertEvent,
  canonical: string
): boolean {
  if (
    canonical === "agent" ||
    canonical === "assistant" ||
    canonical === "agent_message" ||
    canonical === "assistant_message"
  ) {
    return true;
  }
  return (
    event.source?.toLowerCase() === "assistant" &&
    event.displayVariant?.toLowerCase() === "message"
  );
}

function isToolCall(event: SnapshotUpsertEvent, canonical: string): boolean {
  return (
    event.displayVariant?.toLowerCase() === "tool_call" ||
    event.actionType?.toLowerCase() === "tool_call" ||
    canonical.startsWith("tool_")
  );
}

export function reduceTranscriptFromUpserts(
  state: TranscriptState,
  upserts: SnapshotUpsertEvent[],
  options: TranscriptPatchOptions = {}
): TranscriptState {
  const removed = new Set(options.removedIds ?? []);
  if (upserts.length === 0 && removed.size === 0 && !options.replace) {
    return state;
  }

  const nextItems = options.replace
    ? []
    : state.items.filter((item) => !removed.has(item.id));
  const indexById = new Map(
    nextItems.map((item, index) => [item.id, index] as const)
  );
  const mergeItem = (item: TranscriptItem) => {
    const existingIndex = indexById.get(item.id);
    if (existingIndex == null) {
      indexById.set(item.id, nextItems.length);
      nextItems.push(item);
    } else {
      nextItems[existingIndex] = item;
    }
  };

  for (let index = 0; index < upserts.length; index += 1) {
    const event = upserts[index];
    const id = resolveEventId(event, index);
    const canon = resolveCanonical(event);

    if (isUserMessage(event, canon)) {
      mergeItem({
        id,
        kind: "user",
        text: resolveEventText(event),
        createdAt: event.createdAt,
        turnIntentId: event.turnIntentId,
      });
      continue;
    }

    if (isAgentMessage(event, canon)) {
      mergeItem({
        id,
        kind: "agent",
        text: resolveEventText(event),
        streaming:
          event.displayStatus?.toLowerCase() === "running" ||
          Boolean(event.args?.streaming),
        createdAt: event.createdAt,
      });
      continue;
    }

    if (isToolCall(event, canon)) {
      mergeItem({
        id,
        kind: "tool",
        text: resolveEventText(event) || event.functionName || "tool",
        toolName: event.functionName,
        toolCanonical: event.uiCanonical,
        toolStatus: event.displayStatus,
        toolSummary: event.toolSummary,
        toolData: event.toolData,
        toolDataTruncated: event.toolDataTruncated,
        toolFilePath: event.filePath,
        toolCommand: event.command,
        toolCallId: event.callId,
        createdAt: event.createdAt,
      });
    }
  }

  nextItems.sort((left, right) => {
    if (!left.createdAt || !right.createdAt) return 0;
    return left.createdAt.localeCompare(right.createdAt);
  });

  return {
    items:
      nextItems.length > MAX_MOBILE_TRANSCRIPT_ITEMS
        ? nextItems.slice(-MAX_MOBILE_TRANSCRIPT_ITEMS)
        : nextItems,
  };
}

export function demoTranscriptItems(): TranscriptItem[] {
  return [
    { id: "demo-user-1", kind: "user", text: "继续跑测试" },
    {
      id: "demo-agent-1",
      kind: "agent",
      text: "需要执行 pnpm test，请批准 shell 命令。",
    },
  ];
}
