import { describe, expect, it } from "vitest";

import { buildCloudSessionReference } from "./cloudSessionReference";
import { referenceInsertText } from "./referenceInsertText";

const TEAM_REFERENCE = buildCloudSessionReference({
  orgId: "0aefaa1f-de59-4fbe-a4e5-57cbe6c2bbdd",
  ownerUserId: "6c6a39b1-4ca5-4c48-89b4-74d1565c258d",
  sourceSessionId: "codexapp-rollout-2026-07-27T13-57-08",
});

describe("referenceInsertText", () => {
  it("wraps the reference in a titled markdown link", () => {
    expect(referenceInsertText(TEAM_REFERENCE, "查看未提交变动")).toBe(
      `[查看未提交变动](${TEAM_REFERENCE})`
    );
  });

  it("falls back to the bare reference without a title", () => {
    expect(referenceInsertText(TEAM_REFERENCE)).toBe(TEAM_REFERENCE);
    expect(referenceInsertText(TEAM_REFERENCE, "   ")).toBe(TEAM_REFERENCE);
  });

  it("strips brackets that would break the link syntax", () => {
    expect(referenceInsertText(TEAM_REFERENCE, "fix [urgent] thing")).toBe(
      `[fix urgent thing](${TEAM_REFERENCE})`
    );
  });
});
