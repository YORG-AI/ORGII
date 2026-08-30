import { atom } from "jotai";

import { settingsAtom, updateSettingAtom } from "@src/store/settings";

export type ChatPanelPosition = "left" | "right";

export const chatPanelPositionAtom = atom(
  (get) => get(settingsAtom)["general.chatPanelPosition"] as ChatPanelPosition,
  (_get, set, value: ChatPanelPosition) => {
    set(updateSettingAtom, {
      key: "general.chatPanelPosition",
      value,
    });
  }
);
chatPanelPositionAtom.debugLabel = "chatPanelPosition";
