import { atom } from "jotai";

import type { PublishedHeaderSlots } from "@src/components/WindowChrome";

export type ChatPanelHeaderSlots = PublishedHeaderSlots;

export type ChatPanelHeaderContribution = ChatPanelHeaderSlots | null;

export const chatPanelHeaderSlotsAtom = atom<ChatPanelHeaderSlots | null>(null);
chatPanelHeaderSlotsAtom.debugLabel = "chatPanelHeaderSlotsAtom";
