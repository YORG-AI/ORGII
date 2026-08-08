import { afterEach, describe, expect, it, vi } from "vitest";

import { getGitCommitDiff, getGitFileContent } from "@src/api/http/git/diff";
import type { CommitDiffResult } from "@src/api/http/git/types";

import {
  getGitCommitDetailResourceStats,
  loadCommitDiff,
  loadCommitFileDiff,
  resetGitCommitDetailResourceForTests,
  setCachedCommitSelection,
} from "./gitCommitDetailResource";

vi.mock("@src/api/http/git/diff", () => ({
  getGitCommitDiff: vi.fn(),
  getGitFileContent: vi.fn(),
}));

const getGitCommitDiffMock = vi.mocked(getGitCommitDiff);
const getGitFileContentMock = vi.mocked(getGitFileContent);

const commitDiff = {
  author: {
    date: "2026-07-31",
    email: "a@example.com",
    name: "Ada",
  },
  body: "",
  commit_sha: "commit",
  committer: {
    date: "2026-07-31",
    email: "a@example.com",
    name: "Ada",
  },
  files: [
    {
      binary: false,
      deletions: 1,
      file_path: "src/a.ts",
      hunks: [],
      insertions: 1,
      new_content: "after",
      old_content: "before",
      old_path: null,
      status: "modified",
    },
  ],
  parent_mode: "first-parent",
  parent_sha: "parent",
  parent_shas: ["parent"],
  selected_parent_index: 0,
  short_sha: "commit",
  stats: { deletions: 1, files_changed: 1, insertions: 1 },
  summary: "Commit",
} satisfies CommitDiffResult;

afterEach(() => {
  resetGitCommitDetailResourceForTests();
  vi.clearAllMocks();
});

describe("gitCommitDetailResource", () => {
  it("reuses immutable commit and file bodies across remounts", async () => {
    getGitCommitDiffMock.mockResolvedValue(commitDiff);
    getGitFileContentMock.mockImplementation(async ({ ref }) => ({
      content: ref === "parent" ? "before" : "after",
      encoding: "utf-8",
      exists: true,
      file_path: "src/a.ts",
      ref: ref ?? "HEAD",
      size: 6,
    }));
    const commitRequest = {
      commitSha: "commit",
      repoId: "repo-1",
      repoPath: "/repo",
    };
    const fileRequest = {
      ...commitRequest,
      filePath: "src/a.ts",
      fileStatus: "modified",
      parentSha: "parent",
    };

    await loadCommitDiff(commitRequest);
    await loadCommitDiff(commitRequest);
    await loadCommitFileDiff(fileRequest);
    await loadCommitFileDiff(fileRequest);

    expect(getGitCommitDiffMock).toHaveBeenCalledTimes(1);
    expect(getGitFileContentMock).toHaveBeenCalledTimes(2);
  });

  it("does not retain an oversized file body", async () => {
    getGitFileContentMock.mockResolvedValue({
      content: "x".repeat(2_200_000),
      encoding: "utf-8",
      exists: true,
      file_path: "src/a.ts",
      ref: "commit",
      size: 2_200_000,
    });
    const request = {
      commitSha: "commit",
      filePath: "src/a.ts",
      fileStatus: "modified",
      parentSha: "parent",
      repoId: "repo-1",
      repoPath: "/repo",
    };

    await loadCommitFileDiff(request);
    await loadCommitFileDiff(request);

    expect(getGitFileContentMock).toHaveBeenCalledTimes(4);
    expect(getGitCommitDetailResourceStats().files.entries).toBe(0);
  });

  it("bounds selected-file state by commit scope", () => {
    for (let index = 0; index < 9; index += 1) {
      setCachedCommitSelection(
        {
          commitSha: `commit-${index}`,
          repoId: "repo-1",
          repoPath: "/repo",
        },
        `src/${index}.ts`
      );
    }

    expect(getGitCommitDetailResourceStats().selections).toBe(8);
  });
});
