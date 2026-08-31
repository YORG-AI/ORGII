import { atom } from "jotai";
import { atomFamily } from "jotai/utils";

export type ConversationComposerMode = "prompt" | "team_chat";

/** Per-session composer target. Ephemeral UI state — always boots at Prompt. */
export const conversationComposerModeAtomFamily = atomFamily(
  (_sessionId: string) => atom<ConversationComposerMode>("prompt")
);
