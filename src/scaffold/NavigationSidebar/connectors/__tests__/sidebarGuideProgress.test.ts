import { describe, expect, it } from "vitest";

import {
  SIDEBAR_GUIDE_MILESTONE,
  getSidebarGuideProgress,
} from "../sidebarGuideProgress";

describe("getSidebarGuideProgress", () => {
  it("starts at the session milestone with no completed product facts", () => {
    expect(
      getSidebarGuideProgress({ session: false, team: false, work: false })
    ).toEqual({
      completedCount: 0,
      totalCount: 3,
      percent: 0,
      nextMilestone: SIDEBAR_GUIDE_MILESTONE.SESSION,
    });
  });

  it("finds the first incomplete milestone without changing later facts", () => {
    expect(
      getSidebarGuideProgress({ session: true, team: false, work: true })
    ).toEqual({
      completedCount: 2,
      totalCount: 3,
      percent: 67,
      nextMilestone: SIDEBAR_GUIDE_MILESTONE.TEAM,
    });
  });

  it("reaches one hundred percent only when every tracked fact exists", () => {
    expect(
      getSidebarGuideProgress({ session: true, team: true, work: true })
    ).toEqual({
      completedCount: 3,
      totalCount: 3,
      percent: 100,
      nextMilestone: null,
    });
  });
});
