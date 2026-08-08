import { describe, expect, it } from "vitest";

import {
  formatWorkItemShortId,
  getWorkItemSourceIntegration,
} from "./workItemIdentity";

describe("formatWorkItemShortId", () => {
  it("uses GitHub issue notation for GitHub-backed work items", () => {
    expect(formatWorkItemShortId("210", "open")).toBe("#210");
    expect(formatWorkItemShortId("#210", "closed")).toBe("#210");
  });

  it("adds a three-character repository prefix when available", () => {
    expect(formatWorkItemShortId("210", "open", "ORGII issues")).toBe(
      "ORG #210"
    );
    expect(formatWorkItemShortId("#210", "closed", "owner/repository")).toBe(
      "REP #210"
    );
  });

  it("leaves native project identifiers unchanged", () => {
    expect(formatWorkItemShortId("ORG-0210", "planned")).toBe("ORG-0210");
  });

  it("resolves GitHub and Linear work-item source icons", () => {
    expect(getWorkItemSourceIntegration("open")).toBe("github");
    expect(getWorkItemSourceIntegration("in_progress", "linear")).toBe(
      "linear"
    );
    expect(getWorkItemSourceIntegration("planned")).toBeNull();
  });
});
