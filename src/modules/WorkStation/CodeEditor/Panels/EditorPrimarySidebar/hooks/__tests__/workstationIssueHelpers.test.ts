import { describe, expect, it } from "vitest";

import type {
  GitHubIssue,
  GitHubIssueLabel,
  GitHubIssueUser,
} from "@src/api/tauri/github";

import {
  filterIssuesByQuery,
  formatIssueStateLabel,
  formatTimeAgo,
  getLabelColorStyle,
  parseGithubIssueNumber,
  sortIssues,
} from "../workstationIssueHelpers";

function createUser(overrides?: Partial<GitHubIssueUser>): GitHubIssueUser {
  return {
    login: "octocat",
    avatar_url: "https://github.com/images/error/octocat_happy.gif",
    ...overrides,
  };
}

function createLabel(overrides?: Partial<GitHubIssueLabel>): GitHubIssueLabel {
  return {
    id: 1,
    name: "bug",
    color: "d73a4a",
    description: "Something isn't working",
    ...overrides,
  };
}

function createIssue(overrides?: Partial<GitHubIssue>): GitHubIssue {
  return {
    number: 1,
    title: "Test issue",
    body: null,
    state: "open",
    state_reason: null,
    html_url: "https://github.com/acme/app/issues/1",
    user: createUser(),
    labels: [],
    assignees: [],
    comments: 0,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    closed_at: null,
    milestone: null,
    ...overrides,
  };
}

// ============================================================
// formatIssueStateLabel
// ============================================================
describe("formatIssueStateLabel", () => {
  it('maps "open" to "Open"', () => {
    expect(formatIssueStateLabel("open")).toBe("Open");
  });

  it('maps "closed" to "Closed"', () => {
    expect(formatIssueStateLabel("closed")).toBe("Closed");
  });

  it("passes through unknown states unchanged", () => {
    expect(formatIssueStateLabel("merged")).toBe("merged");
    expect(formatIssueStateLabel("")).toBe("");
  });
});

// ============================================================
// filterIssuesByQuery
// ============================================================
describe("filterIssuesByQuery", () => {
  const issues = [
    createIssue({
      number: 1,
      title: "Fix login bug",
      labels: [],
      user: createUser({ login: "alice" }),
    }),
    createIssue({
      number: 2,
      title: "Add dark mode",
      labels: [createLabel({ name: "enhancement" })],
      user: createUser({ login: "bob" }),
    }),
    createIssue({
      number: 3,
      title: "Performance regression",
      labels: [createLabel({ name: "performance" })],
      user: createUser({ login: "carol" }),
    }),
  ];

  it("returns all issues for an empty query", () => {
    expect(filterIssuesByQuery(issues, "")).toHaveLength(3);
    expect(filterIssuesByQuery(issues, "   ")).toHaveLength(3);
  });

  it("matches by title", () => {
    const result = filterIssuesByQuery(issues, "dark");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(2);
  });

  it("matches by issue number with or without a hash", () => {
    expect(
      filterIssuesByQuery(issues, "2").map((issue) => issue.number)
    ).toEqual([2]);
    expect(
      filterIssuesByQuery(issues, "#3").map((issue) => issue.number)
    ).toEqual([3]);
  });

  it("matches by label name", () => {
    const result = filterIssuesByQuery(issues, "performance");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(3);
  });

  it("matches by user login", () => {
    const result = filterIssuesByQuery(issues, "alice");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it("is case-insensitive", () => {
    expect(filterIssuesByQuery(issues, "FIX")).toHaveLength(1);
    expect(filterIssuesByQuery(issues, "ENHANCEMENT")).toHaveLength(1);
    expect(filterIssuesByQuery(issues, "CAROL")).toHaveLength(1);
  });

  it("returns empty array when nothing matches", () => {
    expect(filterIssuesByQuery(issues, "zzznomatch")).toHaveLength(0);
  });
});

// ============================================================
// sortIssues
// ============================================================
describe("sortIssues", () => {
  const issues = [
    createIssue({
      number: 5,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-10T00:00:00Z",
    }),
    createIssue({
      number: 1,
      created_at: "2024-03-01T00:00:00Z",
      updated_at: "2024-03-05T00:00:00Z",
    }),
    createIssue({
      number: 3,
      created_at: "2024-02-01T00:00:00Z",
      updated_at: "2024-02-15T00:00:00Z",
    }),
  ];

  it("sorts by number descending", () => {
    const sorted = sortIssues(issues, "number");
    expect(sorted.map((i) => i.number)).toEqual([5, 3, 1]);
  });

  it("sorts by updated descending", () => {
    const sorted = sortIssues(issues, "updated");
    expect(sorted.map((i) => i.number)).toEqual([1, 3, 5]);
  });

  it("sorts by created descending", () => {
    const sorted = sortIssues(issues, "created");
    expect(sorted.map((i) => i.number)).toEqual([1, 3, 5]);
  });

  it("does not mutate the original array", () => {
    const original = [...issues];
    sortIssues(issues, "number");
    expect(issues).toEqual(original);
  });
});

// ============================================================
// getLabelColorStyle
// ============================================================
describe("getLabelColorStyle", () => {
  it("returns white text for dark colors", () => {
    // #d73a4a is a dark red
    const style = getLabelColorStyle("d73a4a");
    expect(style.backgroundColor).toBe("#d73a4a");
    expect(style.color).toBe("#ffffff");
  });

  it("returns black text for light colors", () => {
    // #e4e669 is a light yellow
    const style = getLabelColorStyle("e4e669");
    expect(style.backgroundColor).toBe("#e4e669");
    expect(style.color).toBe("#000000");
  });

  it("returns black text for pure white", () => {
    const style = getLabelColorStyle("ffffff");
    expect(style.color).toBe("#000000");
  });

  it("returns white text for pure black", () => {
    const style = getLabelColorStyle("000000");
    expect(style.color).toBe("#ffffff");
  });
});

// ============================================================
// formatTimeAgo
// ============================================================
describe("formatTimeAgo", () => {
  function daysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
  }

  function monthsAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n * 30);
    return d.toISOString();
  }

  it('returns "today" for the current date', () => {
    expect(formatTimeAgo(new Date().toISOString())).toBe("today");
  });

  it('returns "yesterday" for 1 day ago', () => {
    expect(formatTimeAgo(daysAgo(1))).toBe("yesterday");
  });

  it("returns N days ago for 2-29 days", () => {
    expect(formatTimeAgo(daysAgo(5))).toBe("5d ago");
    expect(formatTimeAgo(daysAgo(29))).toBe("29d ago");
  });

  it("returns N months ago for 1-11 months", () => {
    expect(formatTimeAgo(monthsAgo(2))).toBe("2mo ago");
    expect(formatTimeAgo(monthsAgo(11))).toBe("11mo ago");
  });

  it("returns N years ago for 12+ months", () => {
    expect(formatTimeAgo(monthsAgo(13))).toBe("1y ago");
    expect(formatTimeAgo(monthsAgo(25))).toBe("2y ago");
  });
});

// ============================================================
// parseGithubIssueNumber
// ============================================================
describe("parseGithubIssueNumber", () => {
  it("parses a valid GitHub issue URL", () => {
    expect(
      parseGithubIssueNumber("https://github.com/acme/app/issues/42")
    ).toBe(42);
  });

  it("parses issue number 1", () => {
    expect(parseGithubIssueNumber("https://github.com/org/repo/issues/1")).toBe(
      1
    );
  });

  it("returns null for a non-issue URL", () => {
    expect(
      parseGithubIssueNumber("https://github.com/acme/app/pull/42")
    ).toBeNull();
  });

  it("returns null for a plain string", () => {
    expect(parseGithubIssueNumber("not-a-url")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseGithubIssueNumber("")).toBeNull();
  });
});
