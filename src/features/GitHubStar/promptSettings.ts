import { atom } from "jotai";

import {
  settingsAtom,
  updateSettingsBatchAtom,
} from "@src/store/settings/settingsAtom";

export interface GitHubStarPromptSettings {
  completed: boolean;
  disabled: boolean;
  deferredUntil: number;
  lastShownAt: number;
  nextEligibleValueCount: number;
}

export const GITHUB_STAR_PROMPT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

const githubStarPromptSettingsValueAtom = atom<GitHubStarPromptSettings>(
  (get) => {
    const settings = get(settingsAtom);
    return {
      completed: settings["general.githubStarPromptCompleted"],
      disabled: settings["general.githubStarPromptDisabled"],
      deferredUntil: settings["general.githubStarPromptDeferredUntil"],
      lastShownAt: settings["general.githubStarPromptLastShownAt"],
      nextEligibleValueCount:
        settings["general.githubStarPromptNextEligibleValueCount"],
    };
  }
);

export const githubStarPromptSettingsAtom = atom(
  (get) => get(githubStarPromptSettingsValueAtom),
  (get, set, update: Partial<GitHubStarPromptSettings>) => {
    const current = get(githubStarPromptSettingsValueAtom);
    const next = { ...current, ...update };
    set(updateSettingsBatchAtom, {
      "general.githubStarPromptCompleted": next.completed,
      "general.githubStarPromptDisabled": next.disabled,
      "general.githubStarPromptDeferredUntil": next.deferredUntil,
      "general.githubStarPromptLastShownAt": next.lastShownAt,
      "general.githubStarPromptNextEligibleValueCount":
        next.nextEligibleValueCount,
    });
  }
);
githubStarPromptSettingsAtom.debugLabel = "githubStarPromptSettingsAtom";

export function isGitHubStarPromptEligible(
  settings: GitHubStarPromptSettings,
  now = Date.now(),
  valueCount = 1
): boolean {
  return (
    !settings.completed &&
    !settings.disabled &&
    settings.deferredUntil <= now &&
    valueCount >= settings.nextEligibleValueCount
  );
}

export function deferGitHubStarPrompt(
  settings: GitHubStarPromptSettings,
  now = Date.now()
): Partial<GitHubStarPromptSettings> {
  return {
    deferredUntil: now + GITHUB_STAR_PROMPT_COOLDOWN_MS,
    lastShownAt: now,
    nextEligibleValueCount: Math.max(2, settings.nextEligibleValueCount * 2),
  };
}
