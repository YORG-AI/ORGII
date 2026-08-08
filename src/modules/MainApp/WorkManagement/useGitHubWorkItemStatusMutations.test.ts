import { describe, expect, it } from "vitest";

import type { GitHubIssue, OpenPRItem } from "@src/api/tauri/github";

import {
  replaceIssueInRepoState,
  replacePrInRepoState,
} from "./useGitHubWorkItemStatusMutations";
import {
  EMPTY_REPO_ISSUES,
  EMPTY_REPO_PRS,
} from "./useGitHubWorkItemsLoadLifecycle";

function issue(number: number, state: "open" | "closed"): GitHubIssue {
  return { number, state } as GitHubIssue;
}

function pullRequest(number: number, state: string): OpenPRItem {
  return { number, state } as OpenPRItem;
}

describe("GitHub work-item status replacement", () => {
  it("moves the canonical issue response between state lists", () => {
    const original = issue(42, "open");
    const updated = issue(42, "closed");
    const next = replaceIssueInRepoState(
      { ...EMPTY_REPO_ISSUES, openIssues: [original] },
      updated
    );

    expect(next.openIssues).toEqual([]);
    expect(next.closedIssues).toEqual([updated]);
  });

  it("preserves row order when issue fields change without a state move", () => {
    const first = issue(41, "open");
    const original = issue(42, "open");
    const updated = { ...original, title: "Updated title" };
    const next = replaceIssueInRepoState(
      { ...EMPTY_REPO_ISSUES, openIssues: [first, original] },
      updated
    );

    expect(next.openIssues).toEqual([first, updated]);
  });

  it("moves the canonical PR response between state lists", () => {
    const original = pullRequest(61, "closed");
    const updated = pullRequest(61, "open");
    const next = replacePrInRepoState(
      { ...EMPTY_REPO_PRS, closedPrs: [original] },
      updated
    );

    expect(next.openPrs).toEqual([updated]);
    expect(next.closedPrs).toEqual([]);
  });
});
