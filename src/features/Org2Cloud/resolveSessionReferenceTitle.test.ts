import { describe, expect, it } from "vitest";

import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import { resolveSessionReferenceTitle } from "./resolveSessionReferenceTitle";

const reference = {
  version: 1 as const,
  orgId: "0aefaa1f-de59-4fbe-a4e5-57cbe6c2bbdd",
  ownerUserId: "394af2b7-bccd-4561-9fe0-df19d26538bd",
  sourceSessionId: "agentsession-15d8ed97",
};

function row(
  overrides: Partial<RemoteTeammateSessionMetadata> = {}
): RemoteTeammateSessionMetadata {
  return {
    id: "row",
    orgId: reference.orgId,
    ownerUserId: reference.ownerUserId,
    sourceSessionId: reference.sourceSessionId,
    title: "Supabase perf work",
    ...overrides,
  } as RemoteTeammateSessionMetadata;
}

describe("resolveSessionReferenceTitle", () => {
  it("uses the org listing the viewer already holds", () => {
    expect(resolveSessionReferenceTitle({ reference, orgRows: [row()] })).toBe(
      "Supabase perf work"
    );
  });

  it("prefers a local session's own name over the listing", () => {
    expect(
      resolveSessionReferenceTitle({
        reference,
        orgRows: [row()],
        localTitle: "My renamed session",
      })
    ).toBe("My renamed session");
  });

  it("falls back to null when the viewer has no listing for that org", () => {
    // This is the non-member case: nothing is fetched, so nothing is known,
    // and the chip shows its generic wording instead.
    expect(
      resolveSessionReferenceTitle({ reference, orgRows: undefined })
    ).toBeNull();
    expect(resolveSessionReferenceTitle({ reference, orgRows: [] })).toBeNull();
  });

  it("requires both session and owner to match", () => {
    expect(
      resolveSessionReferenceTitle({
        reference,
        orgRows: [row({ sourceSessionId: "another-session" })],
      })
    ).toBeNull();
    expect(
      resolveSessionReferenceTitle({
        reference,
        orgRows: [row({ ownerUserId: "someone-else" })],
      })
    ).toBeNull();
  });

  it("ignores blank titles on either side", () => {
    expect(
      resolveSessionReferenceTitle({
        reference,
        orgRows: [row({ title: "   " })],
        localTitle: "  ",
      })
    ).toBeNull();
  });
});
