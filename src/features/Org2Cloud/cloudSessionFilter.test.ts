import { describe, expect, it } from "vitest";

import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import {
  buildCloudSessionMemberFilterOptions,
  filterCloudSessionRows,
} from "./cloudSessionFilter";

function row(
  id: string,
  ownerUserId: string,
  directlySharedWithMe?: boolean
): RemoteTeammateSessionMetadata {
  return {
    id,
    orgId: "org-1",
    ownerMemberId: ownerUserId,
    ownerUserId,
    ownerDisplayName: ownerUserId,
    ownerIdentityKind: "human",
    sourceSessionId: id,
    title: id,
    eventsEpoch: 1,
    eventsFrozenSeq: 0,
    eventsCount: 1,
    eventsTailHash: "hash",
    directlySharedWithMe,
  };
}

const ROWS = [row("a", "user-a"), row("b", "user-b", true)];

describe("filterCloudSessionRows", () => {
  it("keeps all rows in the default filter", () => {
    expect(filterCloudSessionRows(ROWS, { kind: "all" })).toEqual(ROWS);
  });

  it("keeps only explicit directed grants for Shared with me", () => {
    expect(
      filterCloudSessionRows(ROWS, { kind: "directlySharedWithMe" }).map(
        (item) => item.id
      )
    ).toEqual(["b"]);
  });

  it("does not guess that a missing server projection is directed", () => {
    expect(
      filterCloudSessionRows([row("a", "user-a")], {
        kind: "directlySharedWithMe",
      })
    ).toEqual([]);
  });

  it("filters by owner independently of direct grants", () => {
    expect(
      filterCloudSessionRows(ROWS, {
        kind: "member",
        ownerUserId: "user-a",
      }).map((item) => item.id)
    ).toEqual(["a"]);
  });
});

describe("buildCloudSessionMemberFilterOptions", () => {
  it("renders active roster members even before they own a listed session", () => {
    expect(
      buildCloudSessionMemberFilterOptions(
        [],
        [
          { userId: "owner", displayName: "Owner", status: "active" },
          { userId: "member", displayName: "Member", status: "active" },
        ]
      )
    ).toEqual([
      { userId: "owner", displayName: "Owner" },
      { userId: "member", displayName: "Member" },
    ]);
  });

  it("uses listed rows as a loading fallback without reviving removed members", () => {
    const rows = [
      { ...row("removed-row", "removed"), ownerDisplayName: "Removed" },
      { ...row("legacy-row", "legacy"), ownerDisplayName: "Legacy" },
    ];
    expect(
      buildCloudSessionMemberFilterOptions(rows, [
        { userId: "removed", displayName: "Removed", status: "removed" },
      ])
    ).toEqual([{ userId: "legacy", displayName: "Legacy" }]);
  });
});
