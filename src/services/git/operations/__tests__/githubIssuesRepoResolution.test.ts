import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchIssue, fetchIssueTimeline } from "../githubIssues";

const mocks = vi.hoisted(() => ({
  getIssueLocal: vi.fn(),
  listIssueTimelineLocal: vi.fn(),
}));

vi.mock("@src/api/tauri/github", () => mocks);

describe("issue repo resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIssueLocal.mockResolvedValue({ number: 108 });
    mocks.listIssueTimelineLocal.mockResolvedValue([]);
  });

  it("accepts an already-resolved owner/repo", async () => {
    // Hosts keyed by repository (the Inbox, Work Items) pass the bare full
    // name. Rejecting it surfaced as "not_authenticated", which pointed every
    // investigation at the credential store instead of at repo resolution.
    await expect(fetchIssue("org2AI/ORG2", 108)).resolves.toEqual({
      data: { number: 108 },
    });
    expect(mocks.getIssueLocal).toHaveBeenCalledWith("org2AI/ORG2", 108);

    await expect(
      fetchIssueTimeline({ remoteUrl: "org2AI/ORG2", issueNumber: 108 })
    ).resolves.toEqual({ data: [] });
  });

  it("still parses real remote URLs", async () => {
    await fetchIssue("git@github.com:org2AI/ORG2.git", 108);
    expect(mocks.getIssueLocal).toHaveBeenCalledWith("org2AI/ORG2", 108);

    await fetchIssue("https://github.com/org2AI/ORG2.git", 108);
    expect(mocks.getIssueLocal).toHaveBeenCalledWith("org2AI/ORG2", 108);
  });

  it("reports an unresolvable repository as such, not as an auth failure", async () => {
    await expect(fetchIssue("local-mirror", 108)).resolves.toEqual({
      error: "github_repo_unresolved",
    });
    expect(mocks.getIssueLocal).not.toHaveBeenCalled();
  });
});
