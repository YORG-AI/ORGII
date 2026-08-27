/**
 * Per-Station chat visibility.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod/v4";

import { createZodJsonStorage } from "@src/util/core/storage/zodStorage";

import { chatWidthAtom, restoreChatWidthAtom } from "./widthAtoms";

const StationChatVisibilitySchema = z.object({
  "my-station": z.boolean(),
  "agent-station": z.boolean(),
});

export type StationChatVisibility = z.infer<typeof StationChatVisibilitySchema>;
export type ChatStationMode = keyof StationChatVisibility;

export const stationChatVisibilityAtom = atomWithStorage<StationChatVisibility>(
  "stationChatVisibility",
  {
    "my-station": true,
    "agent-station": true,
  },
  createZodJsonStorage(StationChatVisibilitySchema),
  { getOnInit: true }
);
stationChatVisibilityAtom.debugLabel = "stationChatVisibilityAtom";

export const activeStationChatVisibleAtom = atom(
  (get) => (mode: ChatStationMode) => get(stationChatVisibilityAtom)[mode],
  (_get, set, mode: ChatStationMode, visible: boolean) => {
    set(stationChatVisibilityAtom, (prev) => ({
      ...prev,
      [mode]: visible,
    }));
    if (visible) {
      set(restoreChatWidthAtom);
    } else {
      set(chatWidthAtom, 0);
    }
  }
);
activeStationChatVisibleAtom.debugLabel = "activeStationChatVisibleAtom";
