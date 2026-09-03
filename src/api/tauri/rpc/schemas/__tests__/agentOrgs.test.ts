import { describe, expect, it } from "vitest";

import { OrgDefinitionSchema } from "../agentOrgs";

const validDefinition = {
  id: "team-1",
  name: "Delivery",
  role: "Coordinator",
  agentId: "builtin:sde",
  planApprovalPolicy: "coordinator",
  members: [
    {
      memberId: "alice",
      name: "Alice",
      role: "Builder",
      agentId: "builtin:sde",
    },
    {
      memberId: "bob",
      name: "Bob",
      role: "Reviewer",
      agentId: "builtin:sde",
    },
  ],
  additionalTaskGraphWriterMemberIds: ["alice"],
  memberCommunicationLinks: [{ memberAId: "alice", memberBId: "bob" }],
};

describe("Agent Org trusted settings wire schema", () => {
  it("accepts the complete flat capability payload", () => {
    expect(OrgDefinitionSchema.parse(validDefinition)).toEqual(validDefinition);
  });

  it("rejects recursive hierarchy payloads", () => {
    expect(() =>
      OrgDefinitionSchema.parse({
        ...validDefinition,
        hierarchyMode: "strict",
      })
    ).toThrow();
    expect(() =>
      OrgDefinitionSchema.parse({
        ...validDefinition,
        members: [
          {
            ...validDefinition.members[0],
            children: [validDefinition.members[1]],
          },
        ],
      })
    ).toThrow();
  });

  it.each(["additionalTaskGraphWriterMemberIds", "memberCommunicationLinks"])(
    "rejects a payload missing %s",
    (field) => {
      const payload = { ...validDefinition } as Record<string, unknown>;
      delete payload[field];
      expect(() => OrgDefinitionSchema.parse(payload)).toThrow();
    }
  );
});
