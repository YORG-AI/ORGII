import { describe, expect, it } from "vitest";

import {
  humanizeToken,
  isGitHubIssueStatus,
  parseGitHubIssueNumber,
  workItemPriorityLabelKey,
  workItemStatusLabelKey,
} from "../domain/labels";

describe("isGitHubIssueStatus", () => {
  it("recognizes the GitHub issue status vocabulary", () => {
    expect(isGitHubIssueStatus("open")).toBe(true);
    expect(isGitHubIssueStatus("closed")).toBe(true);
  });

  it("rejects local Work Item statuses", () => {
    expect(isGitHubIssueStatus("todo")).toBe(false);
    expect(isGitHubIssueStatus("in_progress")).toBe(false);
    expect(isGitHubIssueStatus("completed")).toBe(false);
    expect(isGitHubIssueStatus("")).toBe(false);
  });
});

describe("parseGitHubIssueNumber", () => {
  it("accepts plain and hash-prefixed issue numbers", () => {
    expect(parseGitHubIssueNumber("61")).toBe(61);
    expect(parseGitHubIssueNumber(" #61 ")).toBe(61);
  });

  it("rejects local Work Item identifiers", () => {
    expect(parseGitHubIssueNumber("AAA-0001")).toBeUndefined();
    expect(parseGitHubIssueNumber(undefined)).toBeUndefined();
  });
});

describe("humanizeToken", () => {
  it("sentence-cases a snake_case enum token", () => {
    expect(humanizeToken("in_progress")).toBe("In progress");
  });

  it("normalizes dashes and mixed casing", () => {
    expect(humanizeToken("IN-REVIEW")).toBe("In review");
  });

  it("capitalizes a single word", () => {
    expect(humanizeToken("high")).toBe("High");
  });

  it("collapses repeated separators and surrounding whitespace", () => {
    expect(humanizeToken("  to__do  ")).toBe("To do");
  });

  it("returns an empty string for empty or whitespace input", () => {
    expect(humanizeToken("")).toBe("");
    expect(humanizeToken("   ")).toBe("");
  });
});

describe("label key builders", () => {
  it("namespaces status keys under teamInbox.workItemStatus", () => {
    expect(workItemStatusLabelKey("in_progress")).toBe(
      "teamInbox.workItemStatus.in_progress"
    );
  });

  it("namespaces priority keys under teamInbox.priority", () => {
    expect(workItemPriorityLabelKey("high")).toBe("teamInbox.priority.high");
  });
});
