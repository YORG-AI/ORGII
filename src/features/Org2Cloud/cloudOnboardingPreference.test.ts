import { describe, expect, it } from "vitest";

import {
  ORG2_CLOUD_ONBOARDING_VERSION,
  isOrg2CloudOnboardingAcknowledged,
} from "./cloudOnboardingPreference";

describe("cloudOnboardingPreference", () => {
  it("accepts the current or a newer integer version", () => {
    expect(
      isOrg2CloudOnboardingAcknowledged(ORG2_CLOUD_ONBOARDING_VERSION)
    ).toBe(true);
    expect(
      isOrg2CloudOnboardingAcknowledged(ORG2_CLOUD_ONBOARDING_VERSION + 1)
    ).toBe(true);
  });

  it("rejects absent, malformed, and older versions", () => {
    expect(isOrg2CloudOnboardingAcknowledged(undefined)).toBe(false);
    expect(isOrg2CloudOnboardingAcknowledged("1")).toBe(false);
    expect(isOrg2CloudOnboardingAcknowledged(0)).toBe(false);
    expect(isOrg2CloudOnboardingAcknowledged(1.5)).toBe(false);
  });
});
