import { describe, expect, it } from "vitest";

import {
  resolveCreationActivityKey,
  resolveWorkItemContentSectionPolicy,
} from "../presentation";

describe("resolveWorkItemContentSectionPolicy", () => {
  it("keeps the existing tabs and linked-session table by default", () => {
    expect(resolveWorkItemContentSectionPolicy("default", true)).toEqual({
      showTabbedLowerSection: true,
      showLinkedSessionsTable: true,
      showInlineOutput: false,
    });
  });

  it("keeps the linked-session table in Overview without the tab strip", () => {
    expect(resolveWorkItemContentSectionPolicy("thread", true)).toEqual({
      showTabbedLowerSection: false,
      showLinkedSessionsTable: true,
      showInlineOutput: true,
    });
  });

  it("does not render an empty output block before proof of work exists", () => {
    expect(
      resolveWorkItemContentSectionPolicy("thread", false).showInlineOutput
    ).toBe(false);
  });
});

describe("resolveCreationActivityKey", () => {
  it("uses created wording locally and reserves opened wording for GitHub issues", () => {
    expect(resolveCreationActivityKey(false)).toBe(
      "workItems.activity.createdWorkItem"
    );
    expect(resolveCreationActivityKey(true)).toBe(
      "common:git.issues.activity.opened"
    );
  });
});
