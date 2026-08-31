import { describe, expect, it } from "vitest";

import {
  SIDEBAR_GUIDE_MILESTONE,
  getNextSidebarGuideMilestone,
} from "../sidebarGuideProgress";

describe("getNextSidebarGuideMilestone", () => {
  it("starts at the session milestone with no completed product facts", () => {
    expect(
      getNextSidebarGuideMilestone({
        session: false,
        organization: false,
        teammate: false,
        team_usage: false,
        product_tour: false,
      })
    ).toBe(SIDEBAR_GUIDE_MILESTONE.SESSION);
  });

  it("finds the first incomplete milestone without changing later facts", () => {
    expect(
      getNextSidebarGuideMilestone({
        session: true,
        organization: false,
        teammate: true,
        team_usage: false,
        product_tour: false,
      })
    ).toBe(SIDEBAR_GUIDE_MILESTONE.ORGANIZATION);
  });

  it("returns no next milestone when every tracked fact exists", () => {
    expect(
      getNextSidebarGuideMilestone({
        session: true,
        organization: true,
        teammate: true,
        team_usage: true,
        product_tour: true,
      })
    ).toBeNull();
  });
});
