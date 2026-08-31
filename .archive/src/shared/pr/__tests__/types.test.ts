import { describe, expect, it } from "vitest";

import { toNormalizedPullRequest } from "../types";

describe("toNormalizedPullRequest", () => {
  it("maps a full GitHub PR JSON object", () => {
    expect(
      toNormalizedPullRequest({
        html_url: "https://github.com/acme/app/pull/7",
        state: "open",
        merged: false,
        number: 7,
        title: "Add feature",
        additions: 120,
        deletions: 4,
        changed_files: 3,
      })
    ).toEqual({
      url: "https://github.com/acme/app/pull/7",
      status: "open",
      number: 7,
      title: "Add feature",
      additions: 120,
      deletions: 4,
      changedFiles: 3,
    });
  });

  it("lets merged override the raw state", () => {
    expect(
      toNormalizedPullRequest({ state: "closed", merged: true }).status
    ).toBe("merged");
  });

  it("falls back to provided url/number when JSON omits them", () => {
    const pr = toNormalizedPullRequest(
      {},
      { url: "https://github.com/acme/app/pull/9", number: 9 }
    );
    expect(pr.url).toBe("https://github.com/acme/app/pull/9");
    expect(pr.number).toBe(9);
    // empty state defaults to "open"
    expect(pr.status).toBe("open");
  });

  it("leaves optional numeric fields undefined when absent", () => {
    const pr = toNormalizedPullRequest({
      html_url: "https://x/y/pull/1",
      state: "open",
    });
    expect(pr.additions).toBeUndefined();
    expect(pr.deletions).toBeUndefined();
    expect(pr.changedFiles).toBeUndefined();
    expect(pr.title).toBeUndefined();
  });

  it("ignores non-string / non-number fields defensively", () => {
    const pr = toNormalizedPullRequest({
      html_url: 42,
      number: "not-a-number",
      title: null,
    });
    expect(pr.url).toBe("");
    expect(pr.number).toBeUndefined();
    expect(pr.title).toBeUndefined();
  });
});
