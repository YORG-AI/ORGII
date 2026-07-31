import type { SetupWalkthroughProgress } from "@src/config/settingsSchema/setupWalkthroughProgress";

export const PREFERENCE_SETUP_COMPLETION_ID = "preferences";

/**
 * Completion is a single persisted transition. Legacy setup data is retained
 * so opening the optional setup surfaces later never loses previous work.
 */
export function completePreferenceSetup(
  progress: SetupWalkthroughProgress
): SetupWalkthroughProgress {
  return {
    ...progress,
    currentStepId: PREFERENCE_SETUP_COMPLETION_ID,
    completedStepIds: Array.from(
      new Set([...progress.completedStepIds, PREFERENCE_SETUP_COMPLETION_ID])
    ),
  };
}
