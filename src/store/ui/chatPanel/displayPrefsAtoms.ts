/**
 * Chat history display preferences: group-chat view opt-in, turn pagination,
 * compact/full history, token-usage and turn-metadata visibility, and the
 * model picker presentation style.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import {
  settingsAtom,
  updateSettingAtom,
} from "@src/store/settings/settingsAtom";
import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

/**
 * Per-session opt-in for the Agent Team group chat view. Holds the
 * coordinator session id whose ChatPanel is currently rendering the
 * group view (or `null` for none). Non-persistent: closing or
 * switching session reverts to the per-member ChatHistory default,
 * matching the user's preference that the dropdown choice not stick.
 *
 * Stored as a single-id atom (not a `Set`) because exactly one chat
 * panel surface is active at a time — secondary surfaces (kanban
 * detail, project manager tab) render a different `ChatView` instance
 * and should not inherit the parent's group-view selection.
 */
export const groupChatViewSessionIdAtom = atom<string | null>(null);
groupChatViewSessionIdAtom.debugLabel = "groupChatViewSessionIdAtom";

/** Whether chat history is displayed as turn-based rounds. */
export const chatTurnPaginationEnabledAtom = atom(
  (get) => get(settingsAtom)["general.chatTurnPaginationEnabled"] as boolean,
  (_get, set, value: boolean) => {
    set(updateSettingAtom, {
      key: "general.chatTurnPaginationEnabled",
      value,
    });
  }
);
chatTurnPaginationEnabledAtom.debugLabel = "chatTurnPaginationEnabledAtom";

export type ChatHistoryDisplayMode = "full" | "compact";

const ChatHistoryDisplayModeSchema = z.enum(["full", "compact"]);

export const chatHistoryDisplayModeAtom =
  atomWithStorage<ChatHistoryDisplayMode>(
    "orgii:chatHistoryDisplayMode",
    "compact",
    createZodJsonStorage(ChatHistoryDisplayModeSchema),
    { getOnInit: true }
  );
chatHistoryDisplayModeAtom.debugLabel = "chatHistoryDisplayModeAtom";

export const chatTokenUsageVisibleAtom = atomWithStorage<boolean>(
  "orgii:chatTokenUsageVisible",
  false,
  undefined,
  { getOnInit: true }
);
chatTokenUsageVisibleAtom.debugLabel = "chatTokenUsageVisibleAtom";

/**
 * Whether the per-round edits/reads summary card (`TurnMetadataFooter`)
 * renders at the end of each agent turn. On by default; turning it off
 * only hides the card — turn metadata is still indexed and still backs
 * the composer files pill and Agent Station diff scoping.
 */
export const chatTurnMetadataVisibleAtom = atomWithStorage<boolean>(
  "orgii:chatTurnMetadataVisible",
  true,
  createZodJsonStorage(z.boolean()),
  { getOnInit: true }
);
chatTurnMetadataVisibleAtom.debugLabel = "chatTurnMetadataVisibleAtom";

/** Presentation style for the chat panel model picker. */
export type ModelPickerStyle = "spotlight" | "dropdown";

/**
 * Whether the chat panel model pill opens the full Spotlight palette
 * (`"spotlight"`) or a compact anchored dropdown (`"dropdown"`).
 */
export const modelPickerStyleAtom = atom(
  (get) => get(settingsAtom)["general.modelPickerStyle"] as ModelPickerStyle,
  (_get, set, value: ModelPickerStyle) => {
    set(updateSettingAtom, {
      key: "general.modelPickerStyle",
      value,
    });
  }
);
modelPickerStyleAtom.debugLabel = "modelPickerStyleAtom";
