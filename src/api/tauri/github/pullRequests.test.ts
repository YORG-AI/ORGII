import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  mergePRLocal,
  removePRReviewersLocal,
  requestPRReviewersLocal,
  setPRAutoMergeLocal,
  updatePRDraftStateLocal,
} from "./pullRequests";

const mocks = vi.hoisted(() => ({
  invokeWithAuth: vi.fn(),
}));

vi.mock("./client", () => ({
  invokeWithAuth: mocks.invokeWithAuth,
}));

describe("pull request action IPC payloads", () => {
  beforeEach(() => {
    mocks.invokeWithAuth.mockReset().mockResolvedValue({});
  });

  it("sends the merge method and expected head SHA", async () => {
    await mergePRLocal("org/repo", 42, "squash", "head-sha");

    expect(mocks.invokeWithAuth).toHaveBeenCalledWith("github_merge_pr", {
      repoFullName: "org/repo",
      prNumber: 42,
      method: "squash",
      expectedHeadSha: "head-sha",
    });
  });

  it("sends a complete auto-merge toggle payload", async () => {
    await setPRAutoMergeLocal("org/repo", 42, true, "rebase", "head-sha");

    expect(mocks.invokeWithAuth).toHaveBeenCalledWith(
      "github_set_pr_auto_merge",
      {
        repoFullName: "org/repo",
        prNumber: 42,
        enabled: true,
        method: "rebase",
        expectedHeadSha: "head-sha",
      }
    );
  });

  it("uses distinct commands for adding and removing requested reviewers", async () => {
    await requestPRReviewersLocal("org/repo", 42, ["reviewer"]);
    await removePRReviewersLocal("org/repo", 42, ["reviewer"]);

    expect(mocks.invokeWithAuth).toHaveBeenNthCalledWith(
      1,
      "github_request_pr_reviewers",
      { repoFullName: "org/repo", prNumber: 42, reviewers: ["reviewer"] }
    );
    expect(mocks.invokeWithAuth).toHaveBeenNthCalledWith(
      2,
      "github_remove_pr_reviewers",
      { repoFullName: "org/repo", prNumber: 42, reviewers: ["reviewer"] }
    );
  });

  it("sends explicit draft and ready-for-review states", async () => {
    await updatePRDraftStateLocal("org/repo", 42, true);
    await updatePRDraftStateLocal("org/repo", 42, false);

    expect(mocks.invokeWithAuth).toHaveBeenNthCalledWith(
      1,
      "github_update_pr_draft_state",
      { repoFullName: "org/repo", prNumber: 42, draft: true }
    );
    expect(mocks.invokeWithAuth).toHaveBeenNthCalledWith(
      2,
      "github_update_pr_draft_state",
      { repoFullName: "org/repo", prNumber: 42, draft: false }
    );
  });
});
