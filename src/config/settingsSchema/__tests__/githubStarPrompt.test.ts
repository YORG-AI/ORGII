import {
  getSettingsDefaults,
  validateSettings,
} from "@src/config/settingsSchema";

const SETUP_OUTCOME_KEY = "general.setupWalkthroughOutcome" as const;

const PROMPT_KEYS = {
  completed: "general.githubStarPromptCompleted",
  disabled: "general.githubStarPromptDisabled",
  deferredUntil: "general.githubStarPromptDeferredUntil",
  lastShownAt: "general.githubStarPromptLastShownAt",
  nextEligibleValueCount: "general.githubStarPromptNextEligibleValueCount",
} as const;

describe("GitHub Star prompt settings", () => {
  it("defaults to an eligible, incomplete prompt without a cooldown", () => {
    const defaults = getSettingsDefaults();

    expect(defaults[SETUP_OUTCOME_KEY]).toBe("open");
    expect(defaults[PROMPT_KEYS.completed]).toBe(false);
    expect(defaults[PROMPT_KEYS.disabled]).toBe(false);
    expect(defaults[PROMPT_KEYS.deferredUntil]).toBe(0);
    expect(defaults[PROMPT_KEYS.lastShownAt]).toBe(0);
    expect(defaults[PROMPT_KEYS.nextEligibleValueCount]).toBe(1);
  });

  it("preserves valid durable prompt state", () => {
    const validated = validateSettings({
      [SETUP_OUTCOME_KEY]: "dismissed",
      [PROMPT_KEYS.completed]: true,
      [PROMPT_KEYS.disabled]: true,
      [PROMPT_KEYS.deferredUntil]: 1234,
      [PROMPT_KEYS.lastShownAt]: 1000,
      [PROMPT_KEYS.nextEligibleValueCount]: 2,
    });

    expect(validated[SETUP_OUTCOME_KEY]).toBe("dismissed");
    expect(validated[PROMPT_KEYS.completed]).toBe(true);
    expect(validated[PROMPT_KEYS.disabled]).toBe(true);
    expect(validated[PROMPT_KEYS.deferredUntil]).toBe(1234);
    expect(validated[PROMPT_KEYS.lastShownAt]).toBe(1000);
    expect(validated[PROMPT_KEYS.nextEligibleValueCount]).toBe(2);
  });

  it("replaces invalid cooldown and threshold values with defaults", () => {
    const validated = validateSettings({
      [PROMPT_KEYS.deferredUntil]: -1,
      [PROMPT_KEYS.nextEligibleValueCount]: 0,
    });

    expect(validated[PROMPT_KEYS.deferredUntil]).toBe(0);
    expect(validated[PROMPT_KEYS.nextEligibleValueCount]).toBe(1);
  });
});
