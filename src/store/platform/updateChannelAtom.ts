import { atom } from "jotai";

import {
  settingsAtom,
  updateSettingAtom,
} from "@src/store/settings/settingsAtom";

/** Persisted preference; "auto" follows the installed build's channel. */
export type UpdateChannelPreference = "auto" | "stable" | "beta";

/** Concrete channel the updater actually polls. */
export type UpdateChannel = "stable" | "beta";

/** Update channel preference, persisted in settings.jsonc. */
export const updateChannelPreferenceAtom = atom(
  (get) =>
    (get(settingsAtom)["general.updateChannel"] ??
      "auto") as UpdateChannelPreference,
  (_get, set, value: UpdateChannelPreference) => {
    set(updateSettingAtom, {
      key: "general.updateChannel",
      value,
    });
  }
);
updateChannelPreferenceAtom.debugLabel = "updateChannelPreferenceAtom";

/**
 * Resolve "auto" against the running build: a manually installed beta
 * (SemVer prerelease version) keeps tracking the beta channel without the
 * user ever finding the toggle, while release builds track stable.
 */
export function resolveUpdateChannel(
  preference: UpdateChannelPreference,
  currentVersion: string | undefined
): UpdateChannel {
  if (preference !== "auto") return preference;
  return currentVersion?.includes("-") ? "beta" : "stable";
}
