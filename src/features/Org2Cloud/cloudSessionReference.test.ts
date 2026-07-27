import { describe, expect, it } from "vitest";

import {
  buildCloudSessionReference,
  parseCloudSessionReference,
} from "./cloudSessionReference";
import { isCloudShareDeepLink } from "./org2CloudOrgManagement";

const REFERENCE_SOURCE = {
  orgId: "11111111-1111-1111-1111-111111111111",
  ownerUserId: "22222222-2222-2222-2222-222222222222",
  sourceSessionId: "codexapp-rollout:2026/07/23?thread=abc",
};

describe("cloud session text references", () => {
  it("builds a versioned, URL-encoded reference and round-trips it", () => {
    const reference = buildCloudSessionReference(REFERENCE_SOURCE);

    expect(reference).toBe(
      "orgii://cloud/session/ref?v=1&org=11111111-1111-1111-1111-111111111111&owner=22222222-2222-2222-2222-222222222222&session=codexapp-rollout%3A2026%2F07%2F23%3Fthread%3Dabc"
    );
    expect(parseCloudSessionReference(reference)).toEqual({
      version: 1,
      ...REFERENCE_SOURCE,
    });
  });

  it("stays distinct from capability-bearing session share links", () => {
    const reference = buildCloudSessionReference(REFERENCE_SOURCE);

    expect(isCloudShareDeepLink(reference)).toBe(false);
    expect(
      parseCloudSessionReference("orgii://cloud/session?share=secret")
    ).toBeNull();
  });

  it("rejects missing, duplicate, malformed, and unsupported fields", () => {
    const base =
      "orgii://cloud/session/ref?v=1&org=o&owner=u&session=session-1";

    expect(parseCloudSessionReference(`${base}&session=session-2`)).toBeNull();
    expect(
      parseCloudSessionReference(
        "orgii://cloud/session/ref?v=2&org=o&owner=u&session=s"
      )
    ).toBeNull();
    expect(
      parseCloudSessionReference("orgii://cloud/session/ref?v=1&org=o&owner=u")
    ).toBeNull();
    expect(parseCloudSessionReference(`${base}#fragment`)).toBeNull();
    expect(parseCloudSessionReference("not a reference")).toBeNull();
  });

  it("refuses to build incomplete identity tuples", () => {
    expect(() =>
      buildCloudSessionReference({ ...REFERENCE_SOURCE, ownerUserId: " " })
    ).toThrow("ownerUserId");
  });
});
