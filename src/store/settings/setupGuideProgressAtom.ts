import { atom } from "jotai";

import {
  type SetupWalkthroughProgress,
  normalizeSetupWalkthroughProgress,
} from "@src/config/settingsSchema/setupWalkthroughProgress";

import { saveSettingsBatchAtom, settingsAtom } from "./settingsAtom";

export type SetupGuideProgressUpdater = (
  progress: SetupWalkthroughProgress
) => SetupWalkthroughProgress;

/**
 * Functional persisted update for education-only setup progress. Callers do
 * not retain a second snapshot and no-op updates avoid unnecessary disk I/O.
 */
export const saveSetupGuideProgressAtom = atom(
  null,
  async (get, set, update: SetupGuideProgressUpdater) => {
    const current = normalizeSetupWalkthroughProgress(
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
