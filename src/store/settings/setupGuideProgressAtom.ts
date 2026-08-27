import { atom } from "jotai";

import {
  type SidebarGuideProgress,
  normalizeSidebarGuideProgress,
} from "@src/config/settingsSchema/sidebarGuideProgress";

import { saveSettingsBatchAtom, settingsAtom } from "./settingsAtom";

export type SetupGuideProgressUpdater = (
  progress: SidebarGuideProgress
) => SidebarGuideProgress;

/**
 * Functional persisted update for education-only setup progress. Callers do
 * not retain a second snapshot and no-op updates avoid unnecessary disk I/O.
 */
export const saveSetupGuideProgressAtom = atom(
  null,
  async (get, set, update: SetupGuideProgressUpdater) => {
    const current = normalizeSidebarGuideProgress(
      get(settingsAtom)["general.setupWalkthroughProgress"]
    );
    const next = update(current);
    if (next === current) return false;

    await set(saveSettingsBatchAtom, {
      "general.setupWalkthroughProgress": next,
    });
    return true;
  }
);
saveSetupGuideProgressAtom.debugLabel = "saveSetupGuideProgress";
