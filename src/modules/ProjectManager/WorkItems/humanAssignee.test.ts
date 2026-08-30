import { describe, expect, it } from "vitest";

import { resolveHumanAssigneeWrite } from "./humanAssignee";

describe("resolveHumanAssigneeWrite", () => {
  it("preserves and canonicalizes human roster assignments", () => {
    expect(resolveHumanAssigneeWrite("member-1", "human")).toEqual({
      assignee: "member-1",
      assigneeType: "human",
    });
    expect(resolveHumanAssigneeWrite(" member-2 ", "member")).toEqual({
      assignee: "member-2",
      assigneeType: "human",
    });
  });

  it.each(["agent", "org", "agent_org", undefined])(
    "rejects the non-human assignment type %s",
    (assigneeType) => {
      expect(resolveHumanAssigneeWrite("executor-1", assigneeType)).toEqual({});
    }
  );
});
