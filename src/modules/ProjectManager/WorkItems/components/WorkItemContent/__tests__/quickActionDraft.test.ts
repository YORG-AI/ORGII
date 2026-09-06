import { describe, expect, it } from "vitest";

import { buildQuickActionUpsertRequest } from "../quickActionDraft";

describe("Quick Action draft serialization", () => {
  it("preserves prompt whitespace and splits only the target-kind prefix", () => {
    const prompt = "  Investigate CI\nand preserve this spacing.  ";
    expect(
      buildQuickActionUpsertRequest({
        id: "qa-1",
        orgId: "org-1",
        name: "  Fix CI  ",
        description: "Existing description",
        target: "agent:builtin:sde",
        prompt,
        createdBy: "member-1",
      })
    ).toEqual({
      id: "qa-1",
      orgId: "org-1",
      name: "Fix CI",
      description: "Existing description",
      targetKind: "agent",
      targetId: "builtin:sde",
      prompt,
      createdBy: "member-1",
    });
  });

  it("rejects blank prompts and malformed targets", () => {
    const base = {
      orgId: "org-1",
      name: "Fix CI",
      prompt: "do it",
      createdBy: "member-1",
    };
    expect(buildQuickActionUpsertRequest({ ...base, target: null })).toBeNull();
    expect(
      buildQuickActionUpsertRequest({ ...base, target: "agent:" })
    ).toBeNull();
    expect(
      buildQuickActionUpsertRequest({
        ...base,
        target: "agent:builtin:sde",
        prompt: "   ",
      })
    ).toBeNull();
  });
});
