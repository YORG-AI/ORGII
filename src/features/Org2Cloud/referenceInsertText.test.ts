import { describe, expect, it } from "vitest";

import { buildCloudSessionReference } from "./cloudSessionReference";
import { referenceInsertText } from "./referenceInsertText";

const REFERENCE = buildCloudSessionReference({
  orgId: "0aefaa1f-de59-4fbe-a4e5-57cbe6c2bbdd",
  ownerUserId: "6c6a39b1-4ca5-4c48-89b4-74d1565c258d",
  sourceSessionId: "codexapp-rollout-2026-07-27T13-57-08",
});

describe("referenceInsertText", () => {
  it("inserts the bare reference", () => {
    expect(referenceInsertText(REFERENCE)).toBe(REFERENCE);
  });

  it("never wraps it in a markdown link", () => {
    // GitHub strips the anchor from a non-http scheme and renders only the
    // label, which would delete the id from the issue and put the session
    // title in front of anyone who can see the repo.
    const inserted = referenceInsertText(REFERENCE);
    expect(inserted.startsWith("[")).toBe(false);
    expect(inserted).not.toContain("](");
  });
});
