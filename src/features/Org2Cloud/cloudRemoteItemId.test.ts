import { describe, expect, it } from "vitest";

import {
  buildCloudRemoteItemId,
  includeRevealedCloudRow,
  parseCloudRemoteItemId,
} from "./cloudRemoteItemId";

describe("cloudRemoteItemId", () => {
  it("round-trips row ids that contain session-id colons", () => {
    const itemId = buildCloudRemoteItemId(
      "org-1",
      "org-1:user-1:agentsession:child"
    );
    expect(parseCloudRemoteItemId(itemId)).toEqual({
      orgId: "org-1",
      rowId: "org-1:user-1:agentsession:child",
    });
  });

  it("rejects non-cloud and missing-org identities", () => {
    expect(parseCloudRemoteItemId("agentsession-1")).toBeNull();
    expect(parseCloudRemoteItemId("cloudremote-|row-1")).toBeNull();
  });

  it("temporarily reveals only an unhidden row from the active org", () => {
    const visible = [{ id: "row-a" }];
    const unhidden = [...visible, { id: "row-b" }];

    expect(
      includeRevealedCloudRow(
        visible,
        unhidden,
        "org-1",
        buildCloudRemoteItemId("org-1", "row-b")
      )
    ).toEqual(unhidden);
    expect(
      includeRevealedCloudRow(
        visible,
        unhidden,
        "org-2",
        buildCloudRemoteItemId("org-1", "row-b")
      )
    ).toEqual(visible);
    expect(
      includeRevealedCloudRow(
        visible,
        visible,
        "org-1",
        buildCloudRemoteItemId("org-1", "row-b")
      )
    ).toEqual(visible);
  });
});
