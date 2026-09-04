import type { TranscriptItem } from "../../lib/transcriptReducer";

/**
 * Mobile transcript spacing — tighter than desktop `CHAT_ITEM_GAP` (`py-1`, 8px
 * between adjacent items). Desktop consecutive compact tool headers inside a
 * stack use `gap-0.5` (2px); mobile renders each tool as its own row, so we
 * collapse the doubled padding when tools run back-to-back.
 */
export const MOBILE_CHAT_ITEM_GAP = "py-0.5";

export function mobileTranscriptItemGapClass(
  item: TranscriptItem,
  previousItem: TranscriptItem | undefined
): string {
  if (item.kind === "tool" && previousItem?.kind === "tool") {
    return "pt-0 pb-0.5";
  }
  return MOBILE_CHAT_ITEM_GAP;
}
