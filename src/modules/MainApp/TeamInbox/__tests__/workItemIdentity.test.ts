import { describe, expect, it } from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

import { resolveWorkItemMemberIdentities } from "../domain/workItemIdentity";

const BASE_WORK_ITEM: WorkItem = {
  session_id: "AAA-0001",
  user_id: "member-creator",
  name: "Inbox item",
  status: "planned",
  spec: "Body",
  star: false,
  target_date: null,
  created_time: "2026-07-29T00:00:00.000Z",
  updated_time: "2026-07-29T00:00:00.000Z",
};

describe("resolveWorkItemMemberIdentities", () => {
  it("uses the active roster name for every member-backed Person reference", () => {
    const workItem: WorkItem = {
      ...BASE_WORK_ITEM,
      assignee: { id: "member-assignee", name: "member-assignee" },
      createdBy: { id: "member-creator", name: "member-creator" },
      lead: [{ id: "member-reviewer", name: "member-reviewer" }],
      members: [{ id: "member-assignee", name: "stale alias" }],
    };

    const resolved = resolveWorkItemMemberIdentities(workItem, [
      { id: "member-assignee", name: "ahanafish", color: "#123456" },
      { id: "member-creator", name: "1106510024" },
      { id: "member-reviewer", name: "Reviewer" },
    ]);

    expect(resolved.assignee).toMatchObject({
      id: "member-assignee",
      name: "ahanafish",
      color: "#123456",
    });
    expect(resolved.createdBy?.name).toBe("1106510024");
    expect(resolved.lead?.[0]?.name).toBe("Reviewer");
    expect(resolved.members?.[0]?.name).toBe("ahanafish");
  });

  it("keeps unknown and non-member assignees intact", () => {
    const unknown = resolveWorkItemMemberIdentities(
      {
        ...BASE_WORK_ITEM,
        assignee: { id: "removed-member", name: "Visible fallback" },
      },
      [{ id: "member-1", name: "Ada" }]
    );
    const agent = resolveWorkItemMemberIdentities(
      {
        ...BASE_WORK_ITEM,
        assignee: { id: "member-1", name: "SDE Agent" },
        assigneeType: "agent",
      },
      [{ id: "member-1", name: "Ada" }]
    );

    expect(unknown.assignee?.name).toBe("Visible fallback");
    expect(agent.assignee?.name).toBe("SDE Agent");
  });
});
