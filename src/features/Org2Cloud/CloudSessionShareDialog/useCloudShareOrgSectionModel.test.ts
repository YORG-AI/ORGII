import { describe, expect, it } from "vitest";

import {
  type CreatedCloudShareLink,
  reconcileCreatedLinkAfterRevoke,
} from "./useCloudShareOrgSectionModel";

const CREATED_LINK: CreatedCloudShareLink = {
  shareId: "share-link-1",
  link: "orgii://cloud/session?share=token",
  copied: true,
};

describe("reconcileCreatedLinkAfterRevoke", () => {
  it("clears the one-shot plaintext after its grant is revoked", () => {
    expect(
      reconcileCreatedLinkAfterRevoke(CREATED_LINK, "share-link-1")
    ).toBeNull();
  });

  it("preserves it when a different directed or link share is revoked", () => {
    expect(
      reconcileCreatedLinkAfterRevoke(CREATED_LINK, "share-directed-2")
    ).toBe(CREATED_LINK);
  });

  it("keeps an empty state empty", () => {
    expect(reconcileCreatedLinkAfterRevoke(null, "share-link-1")).toBeNull();
  });
});
