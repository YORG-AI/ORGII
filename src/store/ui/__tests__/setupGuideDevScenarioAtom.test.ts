import { describe, expect, it } from "vitest";

import {
  SETUP_GUIDE_DEV_SCENARIO,
  resolveSetupGuideDevCloudOrg,
  resolveSetupGuideDevRole,
} from "../setupGuideDevScenarioAtom";

describe("setup guide development scenarios", () => {
  const realOrg = { orgId: "org-a", name: "ORG A", role: "member" };

  it("preserves the authoritative object in live mode", () => {
    expect(
      resolveSetupGuideDevCloudOrg(realOrg, SETUP_GUIDE_DEV_SCENARIO.LIVE)
    ).toBe(realOrg);
  });

  it("removes the organization only from the simulated journey", () => {
    expect(
      resolveSetupGuideDevCloudOrg(
        realOrg,
        SETUP_GUIDE_DEV_SCENARIO.NO_ORGANIZATION
      )
    ).toBeNull();
    expect(realOrg.role).toBe("member");
  });

  it.each([
    SETUP_GUIDE_DEV_SCENARIO.MEMBER,
    SETUP_GUIDE_DEV_SCENARIO.ADMIN,
    SETUP_GUIDE_DEV_SCENARIO.OWNER,
  ])("overrides only the presentation role for %s", (scenario) => {
    expect(resolveSetupGuideDevCloudOrg(realOrg, scenario)).toEqual({
      ...realOrg,
      role: scenario,
    });
    expect(resolveSetupGuideDevRole(realOrg.role, scenario)).toBe(scenario);
    expect(realOrg.role).toBe("member");
  });

  it("does not synthesize an organization for role scenarios", () => {
    expect(
      resolveSetupGuideDevCloudOrg(null, SETUP_GUIDE_DEV_SCENARIO.ADMIN)
    ).toBeNull();
  });
});
