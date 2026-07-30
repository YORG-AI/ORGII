import { describe, expect, it } from "vitest";

import {
  SESSION_REFERENCE_ORG,
  publishedOrgIdsForSession,
  resolveSessionReferenceOrg,
} from "./resolveSessionReferenceOrg";

const ORG_A = "0aefaa1f-de59-4fbe-a4e5-57cbe6c2bbdd";
const ORG_B = "bfa7b134-2486-45fa-81ad-a369441fafb4";
const SESSION = "agentsession-15d8ed97-888e-451d-9b4e-cd6cba0de4b2";

describe("publishedOrgIdsForSession", () => {
  it("collects orgs from both marker atoms without duplicating", () => {
    expect(
      publishedOrgIdsForSession(
        SESSION,
        { [`${ORG_A}:${SESSION}`]: {} },
        { [`${ORG_A}:${SESSION}`]: true, [`${ORG_B}:${SESSION}`]: true }
      )
    ).toEqual([ORG_A, ORG_B].sort());
  });

  it("ignores markers belonging to other sessions", () => {
    expect(
      publishedOrgIdsForSession(
        SESSION,
        { [`${ORG_A}:some-other-session`]: {} },
        {}
      )
    ).toEqual([]);
  });

  it("splits on the org uuid, not on colons inside a session id", () => {
    // Session ids are opaque; only the org half is known to be colon-free.
    const colonId = "external:weird:id";
    expect(
      publishedOrgIdsForSession(colonId, { [`${ORG_A}:${colonId}`]: {} }, {})
    ).toEqual([ORG_A]);
  });

  it("does not treat a suffix collision as a match", () => {
    expect(
      publishedOrgIdsForSession(
        "session-2",
        { [`${ORG_A}:other-session-2`]: {} },
        {}
      )
    ).toEqual([]);
  });
});

describe("resolveSessionReferenceOrg", () => {
  it("declines when the session was never published", () => {
    expect(
      resolveSessionReferenceOrg({
        publishedOrgIds: [],
        activeCloudOrgId: ORG_A,
      })
    ).toEqual({ kind: SESSION_REFERENCE_ORG.UNPUBLISHED });
  });

  it("prefers the org the user is currently scoped to", () => {
    expect(
      resolveSessionReferenceOrg({
        publishedOrgIds: [ORG_A, ORG_B],
        activeCloudOrgId: ORG_B,
      })
    ).toEqual({ kind: SESSION_REFERENCE_ORG.RESOLVED, orgId: ORG_B });
  });

  it("uses the sole publication target when scope does not decide", () => {
    for (const activeCloudOrgId of [null, "some-unrelated-org"]) {
      expect(
        resolveSessionReferenceOrg({
          publishedOrgIds: [ORG_A],
          activeCloudOrgId,
        })
      ).toEqual({ kind: SESSION_REFERENCE_ORG.RESOLVED, orgId: ORG_A });
    }
  });

  it("asks rather than guesses when several orgs remain", () => {
    // Guessing here would emit a reference that resolves for nobody in the
    // org the user meant, and the paste looks fine either way.
    expect(
      resolveSessionReferenceOrg({
        publishedOrgIds: [ORG_A, ORG_B],
        activeCloudOrgId: null,
      })
    ).toEqual({ kind: SESSION_REFERENCE_ORG.CHOOSE, orgIds: [ORG_A, ORG_B] });
    expect(
      resolveSessionReferenceOrg({
        publishedOrgIds: [ORG_A, ORG_B],
        activeCloudOrgId: "an-org-this-session-is-not-in",
      })
    ).toMatchObject({ kind: SESSION_REFERENCE_ORG.CHOOSE });
  });
});
