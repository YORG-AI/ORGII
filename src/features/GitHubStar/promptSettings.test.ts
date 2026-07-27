import {
  GITHUB_STAR_PROMPT_COOLDOWN_MS,
  type GitHubStarPromptSettings,
  deferGitHubStarPrompt,
  isGitHubStarPromptEligible,
} from "./promptSettings";

const ELIGIBLE: GitHubStarPromptSettings = {
  completed: false,
  disabled: false,
  deferredUntil: 0,
  lastShownAt: 0,
  nextEligibleValueCount: 1,
};

describe("GitHub Star prompt gating", () => {
  it("blocks completed, disabled, cooling-down, and below-threshold prompts", () => {
    expect(isGitHubStarPromptEligible(ELIGIBLE, 100, 1)).toBe(true);
    expect(
      isGitHubStarPromptEligible({ ...ELIGIBLE, completed: true }, 100, 1)
    ).toBe(false);
    expect(
      isGitHubStarPromptEligible({ ...ELIGIBLE, disabled: true }, 100, 1)
    ).toBe(false);
    expect(
      isGitHubStarPromptEligible({ ...ELIGIBLE, deferredUntil: 101 }, 100, 1)
    ).toBe(false);
    expect(
      isGitHubStarPromptEligible(
        { ...ELIGIBLE, nextEligibleValueCount: 2 },
        100,
        1
      )
    ).toBe(false);
  });

  it("defers for three days and doubles the next value threshold", () => {
    expect(
      deferGitHubStarPrompt({ ...ELIGIBLE, nextEligibleValueCount: 2 }, 1000)
    ).toEqual({
      deferredUntil: 1000 + GITHUB_STAR_PROMPT_COOLDOWN_MS,
      lastShownAt: 1000,
      nextEligibleValueCount: 4,
    });
  });
});
