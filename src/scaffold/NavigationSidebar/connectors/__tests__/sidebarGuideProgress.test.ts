import { describe, expect, it } from "vitest";

import {
  SIDEBAR_GUIDE_MILESTONE,
  getSidebarGuideProgress,
} from "../sidebarGuideProgress";

describe("getSidebarGuideProgress", () => {
  it("starts at the session milestone with no completed product facts", () => {
    expect(
      getSidebarGuideProgress({
        session: false,
        organization: false,
        teammate: false,
        team_usage: false,
        product_tour: false,
      })
    ).toEqual({
      completedCount: 0,
      totalCount: 5,
      percent: 0,
      nextMilestone: SIDEBAR_GUIDE_MILESTONE.SESSION,
    });
  });

  it("finds the first incomplete milestone without changing later facts", () => {
    expect(
      getSidebarGuideProgress({
        session: true,
        organization: false,
        teammate: true,
        team_usage: false,
        product_tour: false,
      })
    ).toEqual({
      completedCount: 2,
      totalCount: 5,
      percent: 40,
      nextMilestone: SIDEBAR_GUIDE_MILESTONE.ORGANIZATION,
    });
  });

  it("reaches one hundred percent only when every tracked fact exists", () => {
    expect(
      getSidebarGuideProgress({
        session: true,
        organization: true,
        teammate: true,
        team_usage: true,
        product_tour: true,
      })
    ).toEqual({
      completedCount: 5,
      totalCount: 5,
      percent: 100,
      nextMilestone: null,
    });
  });
});
