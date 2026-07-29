import { describe, expect, it } from "vitest";

import {
  CLOUD_REFERENCE_REFUSAL,
  cloudReferenceRowId,
  decideCloudReferenceAdmission,
} from "./openCloudSessionReference";

const ORG = "0830d453-1111-4222-8333-444455556666";

describe("decideCloudReferenceAdmission", () => {
  it("refuses while signed out, before any org lookup", () => {
    expect(
      decideCloudReferenceAdmission({
        orgId: ORG,
        signedIn: false,
        orgs: [{ orgId: ORG }],
      })
    ).toEqual({
      admitted: false,
      refusal: CLOUD_REFERENCE_REFUSAL.SIGNED_OUT,
    });
  });

  it("admits a member of the referenced org", () => {
    expect(
      decideCloudReferenceAdmission({
        orgId: ORG,
        signedIn: true,
        orgs: [{ orgId: "other" }, { orgId: ORG }],
      })
    ).toEqual({ admitted: true });
  });

  it("refuses a signed-in viewer outside the referenced org", () => {
    expect(
      decideCloudReferenceAdmission({
        orgId: ORG,
        signedIn: true,
        orgs: [{ orgId: "other" }],
      })
    ).toEqual({
      admitted: false,
      refusal: CLOUD_REFERENCE_REFUSAL.NOT_MEMBER,
    });
  });

  it("defers to the server when the roster has not loaded yet", () => {
    expect(
      decideCloudReferenceAdmission({ orgId: ORG, signedIn: true, orgs: [] })
    ).toEqual({ admitted: true });
  });
});

describe("cloudReferenceRowId", () => {
  it("matches the Team Sessions row identity tuple", () => {
    expect(
      cloudReferenceRowId({
        orgId: ORG,
        ownerUserId: "owner-1",
        sourceSessionId: "session-1",
      })
    ).toBe(`${ORG}:owner-1:session-1`);
  });
});
