import { describe, expect, it } from "vitest";

import { resolveWorkItemContentSectionPolicy } from "../presentation";

describe("resolveWorkItemContentSectionPolicy", () => {
  it("keeps the existing tabs and linked-session table by default", () => {
    expect(resolveWorkItemContentSectionPolicy("default", true)).toEqual({
      showTabbedLowerSection: true,
      showLinkedSessionsTable: true,
      showInlineWorkflow: false,
      showInlineOutput: false,
      showInlineHistory: false,
    });
  });

  it("turns Team Inbox into one inline thread without the legacy table", () => {
    expect(resolveWorkItemContentSectionPolicy("thread", true)).toEqual({
      showTabbedLowerSection: false,
      showLinkedSessionsTable: false,
      showInlineWorkflow: true,
      showInlineOutput: true,
      showInlineHistory: true,
    });
  });

  it("does not render an empty output block before proof of work exists", () => {
    expect(
      resolveWorkItemContentSectionPolicy("thread", false).showInlineOutput
    ).toBe(false);
  });
});
