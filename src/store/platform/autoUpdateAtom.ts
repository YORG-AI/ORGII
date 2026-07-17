import { atom } from "jotai";

import {
  settingsAtom,
  updateSettingAtom,
} from "@src/store/settings/settingsAtom";

/** Default-on automatic app updates, persisted in settings.jsonc. */
export const autoUpdateEnabledAtom = atom(
  (get) => get(settingsAtom)["general.autoUpdateEnabled"] ?? true,
  (_get, set, value: boolean) => {
    set(updateSettingAtom, {
      key: "general.autoUpdateEnabled",
      value,
    });
  }
);
autoUpdateEnabledAtom.debugLabel = "autoUpdateEnabledAtom";
