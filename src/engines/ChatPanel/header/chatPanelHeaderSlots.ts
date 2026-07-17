import { atom } from "jotai";
import type { ReactNode } from "react";

export interface ChatPanelHeaderSlots {
  leading?: ReactNode;
  content?: ReactNode;
  trailing?: ReactNode;
  backAction?: (() => void) | null;
  backLabel?: string;
}

export type ChatPanelHeaderContribution =
  | ReactNode
  | ChatPanelHeaderSlots
  | null;

function isChatPanelHeaderSlots(
  contribution: ChatPanelHeaderContribution
): contribution is ChatPanelHeaderSlots {
  return (
    typeof contribution === "object" &&
    contribution !== null &&
    !Array.isArray(contribution) &&
    ("leading" in contribution ||
      "content" in contribution ||
      "trailing" in contribution ||
      "backAction" in contribution ||
      "backLabel" in contribution)
  );
}

export function normalizeChatPanelHeaderContribution(
  contribution: ChatPanelHeaderContribution
): ChatPanelHeaderSlots | null {
  if (
    contribution === null ||
    contribution === undefined ||
    typeof contribution === "boolean"
  ) {
    return null;
  }
  if (isChatPanelHeaderSlots(contribution)) return contribution;
  return { content: contribution };
}

export const chatPanelHeaderSlotsAtom = atom<ChatPanelHeaderSlots | null>(null);
chatPanelHeaderSlotsAtom.debugLabel = "chatPanelHeaderSlotsAtom";
