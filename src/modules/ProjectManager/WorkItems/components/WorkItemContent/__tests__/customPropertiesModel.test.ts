import { describe, expect, it } from "vitest";

import {
  activeMemberEntriesToPeople,
  resolvePropertyMembers,
} from "../customPropertiesModel";

describe("custom property member resolution", () => {
  it("uses only the exact project member snapshot for project-backed items", () => {
    const staleFallback = [{ id: "builtin:sde", name: "SDE Agent" }];

    expect(
      resolvePropertyMembers(
        "project-a",
        "org-a:project-a",
        null,
        staleFallback
      )
    ).toEqual([]);
    expect(
      resolvePropertyMembers(
        "project-a",
        "org-a:project-a",
        { scopeKey: "org-b:project-b", members: staleFallback },
        staleFallback
      )
    ).toEqual([]);
    expect(
      resolvePropertyMembers(
        "project-a",
        "org-a:project-a",
        {
          scopeKey: "org-a:project-a",
          members: [{ id: "member-1", name: "Member One" }],
        },
        staleFallback
      )
    ).toEqual([{ id: "member-1", name: "Member One" }]);
  });

  it("keeps active backend members and supports projectless fallbacks", () => {
    expect(
      activeMemberEntriesToPeople([
        { id: "member-1", name: "Active", active: true },
        { id: "member-2", name: "Inactive", active: false },
      ])
    ).toEqual([
      { id: "member-1", name: "Active", email: undefined, avatar: undefined },
    ]);

    const orgMembers = [{ id: "member-org", name: "Org Member" }];
    expect(resolvePropertyMembers(null, "org:org-a", null, orgMembers)).toBe(
      orgMembers
    );
  });
});
