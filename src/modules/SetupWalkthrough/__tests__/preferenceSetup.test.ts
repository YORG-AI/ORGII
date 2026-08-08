import { describe, expect, it } from "vitest";

import { DEFAULT_SETUP_WALKTHROUGH_PROGRESS } from "@src/config/settingsSchema/setupWalkthroughProgress";

import {
  PREFERENCE_SETUP_COMPLETION_ID,
  completePreferenceSetup,
} from "../preferenceSetup";

describe("preference setup completion", () => {
  it("marks the compact setup complete while preserving optional setup data", () => {
    const previous = {
      ...DEFAULT_SETUP_WALKTHROUGH_PROGRESS,
      completedStepIds: ["tools"],
      selectedOrgId: "org-1",
      repoScopes: ["github.com/acme/app"],
      tutorialId: "code-editor" as const,
    };

    expect(completePreferenceSetup(previous)).toEqual({
      ...previous,
      currentStepId: PREFERENCE_SETUP_COMPLETION_ID,
      completedStepIds: ["tools", PREFERENCE_SETUP_COMPLETION_ID],
      guideHandoff: "pending",
    });
  });

  it("is idempotent when finish is replayed", () => {
    const completed = completePreferenceSetup(
      DEFAULT_SETUP_WALKTHROUGH_PROGRESS
    );

    expect(completePreferenceSetup(completed)).toEqual(completed);
  });
});
