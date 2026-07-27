import { describe, expect, it } from "vitest";

import { isAgentOrgMemberEmpty } from "./memberActivity";

const EMPTY_MEMBER_ACTIVITY = {
  activeTaskCount: 0,
  pendingTaskCount: 0,
  inProgressTaskCount: 0,
  completedTaskCount: 0,
  inboxActivityCount: 0,
  unreadInboxCount: 0,
};

describe("isAgentOrgMemberEmpty", () => {
  it("treats a worker with no task or inbox state as empty", () => {
    expect(isAgentOrgMemberEmpty(EMPTY_MEMBER_ACTIVITY)).toBe(true);
  });

  it("keeps an old unread message switchable outside the recent activity window", () => {
    expect(
      isAgentOrgMemberEmpty({
        ...EMPTY_MEMBER_ACTIVITY,
        inboxActivityCount: 0,
        unreadInboxCount: 1,
      })
    ).toBe(false);
  });

  it("keeps recent inbox activity and task history switchable", () => {
    expect(
      isAgentOrgMemberEmpty({
        ...EMPTY_MEMBER_ACTIVITY,
        inboxActivityCount: 1,
      })
    ).toBe(false);
    expect(
      isAgentOrgMemberEmpty({
        ...EMPTY_MEMBER_ACTIVITY,
        completedTaskCount: 1,
      })
    ).toBe(false);
  });
});
