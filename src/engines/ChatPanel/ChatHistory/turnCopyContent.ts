import { stripThinkTags } from "@src/engines/SessionCore/sync/adapters/shared/streamingParsers";
import { extractAssistantMessageContent } from "@src/lib/activityData/textExtractors";

import { isAssistantMessageEvent } from "./chatItemPipeline/dedup";
import type { OptimizedChatItem } from "./chatItemPipeline/types";

/**
 * A turn-copy source is a settled assistant message that belongs to the
 * resident turn body. Tool activity and bounded unloaded-turn previews are
 * intentionally excluded: the footer copies the assistant's readable reply,
 * not operational cards or an incomplete historical approximation.
 */
export function isAssistantTurnCopySource(
  item: OptimizedChatItem | undefined
): boolean {
  const event = item?.event;
  return Boolean(
    event &&
    event.displayStatus === "completed" &&
    event.args?.turnPreviewOnly !== true &&
    isAssistantMessageEvent(event)
  );
}

export function collectAssistantTurnCopyEventIds(
  items: readonly OptimizedChatItem[]
): string[] {
  const eventIds: string[] = [];
  for (const item of items) {
    if (isAssistantTurnCopySource(item) && item.event?.id) {
      eventIds.push(item.event.id);
    }
  }
  return eventIds;
}

/**
 * Resolve copy text lazily from the uncollapsed projection. Keeping only ids
 * in group metadata avoids duplicating every assistant response string in the
 * worker result and pays the O(n) scan only when the user actually copies.
 */
export function formatAssistantTurnCopyContent(
  items: readonly OptimizedChatItem[],
  eventIds: readonly string[]
): string {
  if (eventIds.length === 0) return "";

  const requestedIds = new Set(eventIds);
  const parts: string[] = [];
  for (const item of items) {
    const event = item.event;
    if (!event?.id || !requestedIds.has(event.id)) continue;
    if (!isAssistantTurnCopySource(item)) continue;

    const rawContent = extractAssistantMessageContent(event);
    if (!rawContent) continue;
    const visibleContent = stripThinkTags(rawContent).trim();
    if (visibleContent) parts.push(visibleContent);
  }
  return parts.join("\n\n");
}
