import { readDir } from "@tauri-apps/plugin-fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getGitCommits } from "@src/api/http/git";

import {
  getDirectoryViewResourceStats,
  loadDirectoryEntries,
  loadDirectoryMetadata,
  resetDirectoryViewResourceForTests,
} from "./directoryViewResource";

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: vi.fn(),
}));

vi.mock("@src/api/http/git", () => ({
  getGitCommits: vi.fn(),
}));

const readDirMock = vi.mocked(readDir);
const getGitCommitsMock = vi.mocked(getGitCommits);

afterEach(() => {
  resetDirectoryViewResourceForTests();
  vi.clearAllMocks();
});

describe("directoryViewResource", () => {
  it("reuses directory and metadata snapshots across remounts", async () => {
    readDirMock.mockResolvedValue([
      {
        isDirectory: false,
        isFile: true,
        isSymlink: false,
        name: "a.ts",
      },
    ]);
    getGitCommitsMock.mockResolvedValue({
      commits: [
        {
          author: {
            date: "2026-07-31",
            email: "a@example.com",
            name: "Ada",
          },
          body: "",
          committer: {
            date: "2026-07-31",
            email: "a@example.com",
            name: "Ada",
          },
          parent_shas: [],
          sha: "abc",
          short_sha: "abc",
          summary: "Latest",
        },
      ],
      total_count: 1,
    });
    const request = {
      directoryPath: "/repo/src",
      repoPath: "/repo",
    };

    const entries = await loadDirectoryEntries(request);
    await loadDirectoryMetadata(request, entries);
    await loadDirectoryEntries(request);
    await loadDirectoryMetadata(request, entries);

    expect(readDirMock).toHaveBeenCalledTimes(1);
    expect(getGitCommitsMock).toHaveBeenCalledTimes(1);
  });

  it("bounds supplemental git metadata concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    getGitCommitsMock.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { commits: [], total_count: 0 };
    });
    const entries = Array.from({ length: 20 }, (_, index) => ({
      name: `${index}.ts`,
      path: `/repo/src/${index}.ts`,
      type: "file" as const,
    }));

    await loadDirectoryMetadata(
      { directoryPath: "/repo/src", repoPath: "/repo" },
      entries
    );

    expect(getGitCommitsMock).toHaveBeenCalledTimes(20);
    expect(maxActive).toBeLessThanOrEqual(6);
  });

  it("bounds directory scopes and isolates identical paths by repository", async () => {
    readDirMock.mockResolvedValue([]);

    for (let index = 0; index < 11; index += 1) {
      await loadDirectoryEntries({
        directoryPath: `/repo-${index}/src`,
        repoPath: `/repo-${index}`,
      });
    }

    expect(getDirectoryViewResourceStats().entries.entries).toBe(10);
    expect(readDirMock).toHaveBeenCalledTimes(11);
  });
});
