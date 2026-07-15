import type { TeamMember } from "@src/components/TeamMemberTable";

import { buildOrgTreeFromMembers, flattenOrgToMembers } from "../orgTree";

describe("Agent Org tree instructions", () => {
  it("round-trips member instructions through the editable flat form", () => {
    const members: TeamMember[] = [
      {
        id: "lead",
        name: "Lead",
        role: "planner",
        agentId: "builtin:sde",
        instructions: "Plan only the assigned scope.",
      },
      {
        id: "worker",
        name: "Worker",
        role: "implementer",
        agentId: "builtin:sde",
        instructions: "Implement only after the plan is accepted.",
        parentId: "lead",
      },
    ];

    const tree = buildOrgTreeFromMembers(members);
    expect(tree[0]?.instructions).toBe("Plan only the assigned scope.");
    expect(tree[0]?.children[0]?.instructions).toBe(
      "Implement only after the plan is accepted."
    );
    expect(flattenOrgToMembers(tree)).toEqual(members);
  });

  it("does not persist whitespace-only member instructions", () => {
    const tree = buildOrgTreeFromMembers([
      {
        id: "worker",
        name: "Worker",
        role: "implementer",
        agentId: "builtin:sde",
        instructions: "   \n  ",
      },
    ]);

    expect(tree[0]?.instructions).toBeUndefined();
  });
});
