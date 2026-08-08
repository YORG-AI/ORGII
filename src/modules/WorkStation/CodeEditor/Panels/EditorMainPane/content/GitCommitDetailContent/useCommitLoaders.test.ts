// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { getGitCommitDiff, getGitFileContent } from "@src/api/http/git/diff";
import type { CommitDiffResult } from "@src/api/http/git/types";
import { resetGitCommitDetailResourceForTests } from "@src/services/git/gitCommitDetailResource";

import { useCommitDiffLoader } from "./useCommitDiffLoader";
import { useCommitFileDiffLoader } from "./useCommitFileDiffLoader";

vi.mock("@src/api/http/git/diff", () => ({
  getGitCommitDiff: vi.fn(),
  getGitFileContent: vi.fn(),
}));

const getGitCommitDiffMock = vi.mocked(getGitCommitDiff);
const getGitFileContentMock = vi.mocked(getGitFileContent);

function commitDiff(sha: string, summary = `Commit ${sha}`): CommitDiffResult {
  return {
    author: {
      date: "2026-07-31",
      email: "a@example.com",
      name: "Ada",
    },
    body: "",
    commit_sha: sha,
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
    parent_sha: `${sha}-parent`,
    parent_shas: [`${sha}-parent`],
    selected_parent_index: 0,
    short_sha: sha.slice(0, 7),
    stats: { deletions: 1, files_changed: 1, insertions: 1 },
    summary,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

interface LoaderSnapshot {
  commit: ReturnType<typeof useCommitDiffLoader>;
  file: ReturnType<typeof useCommitFileDiffLoader>;
}

function Probe({
  commitSha,
  onValue,
}: {
  commitSha: string;
  onValue: (value: LoaderSnapshot) => void;
}) {
  const commit = useCommitDiffLoader({
    commitSha,
    isRepoReady: true,
    repoId: "repo-1",
    repoPath: "/repo",
  });
  const file = useCommitFileDiffLoader({
    commitDiff: commit.commitDiff,
    commitSha,
    isRepoReady: true,
    repoId: "repo-1",
    repoPath: "/repo",
    selectedFilePath: commit.selectedFilePath,
  });
  onValue({ commit, file });
  return null;
}

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("commit detail loaders", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    resetGitCommitDetailResourceForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    getGitCommitDiffMock.mockResolvedValue(commitDiff("commit-a"));
    getGitFileContentMock.mockImplementation(async ({ ref }) => ({
      content: ref?.endsWith("-parent") ? "before" : "after",
      encoding: "utf-8",
      exists: true,
      file_path: "src/a.ts",
      ref: ref ?? "HEAD",
      size: 6,
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("hydrates the first remount render without commit or file loading states", async () => {
    let latest!: LoaderSnapshot;
    await act(async () => {
      root.render(
        createElement(Probe, {
          commitSha: "commit-a",
          onValue: (value) => {
            latest = value;
          },
        })
      );
      await flushAsyncWork();
    });
    expect(latest.commit.commitLoadState).toBe("ready");
    expect(latest.file.fileLoadState).toBe("ready");

    act(() => root.unmount());
    root = createRoot(container);
    const remountStates: LoaderSnapshot[] = [];
    await act(async () => {
      root.render(
        createElement(Probe, {
          commitSha: "commit-a",
          onValue: (value) => {
            remountStates.push(value);
          },
        })
      );
      await flushAsyncWork();
    });

    expect(remountStates[0]?.commit.commitLoadState).toBe("ready");
    expect(remountStates[0]?.file.fileLoadState).toBe("ready");
    expect(getGitCommitDiffMock).toHaveBeenCalledTimes(1);
    expect(getGitFileContentMock).toHaveBeenCalledTimes(2);
  });

  it("keeps successful commit content visible during an explicit reload", async () => {
    let latest!: LoaderSnapshot;
    await act(async () => {
      root.render(
        createElement(Probe, {
          commitSha: "commit-a",
          onValue: (value) => {
            latest = value;
          },
        })
      );
      await flushAsyncWork();
    });

    const replacement = deferred<CommitDiffResult | undefined>();
    getGitCommitDiffMock.mockReturnValueOnce(replacement.promise);
    act(() => latest.commit.reloadCommit());

    expect(latest.commit.commitLoadState).toBe("ready");
    expect(latest.commit.commitDiff?.summary).toBe("Commit commit-a");

    replacement.resolve(commitDiff("commit-a", "Updated"));
    await act(flushAsyncWork);
    expect(latest.commit.commitLoadState).toBe("ready");
    expect(latest.commit.commitDiff?.summary).toBe("Updated");
  });

  it("ignores a late commit response after switching scopes", async () => {
    const oldRequest = deferred<CommitDiffResult | undefined>();
    getGitCommitDiffMock.mockImplementation(({ commit_sha }) =>
      commit_sha === "commit-old"
        ? oldRequest.promise
        : Promise.resolve(commitDiff("commit-new"))
    );
    let latest!: LoaderSnapshot;

    await act(async () => {
      root.render(
        createElement(Probe, {
          commitSha: "commit-old",
          onValue: (value) => {
            latest = value;
          },
        })
      );
      await Promise.resolve();
    });
    await act(async () => {
      root.render(
        createElement(Probe, {
          commitSha: "commit-new",
          onValue: (value) => {
            latest = value;
          },
        })
      );
      await flushAsyncWork();
    });
    expect(latest.commit.commitDiff?.commit_sha).toBe("commit-new");

    oldRequest.resolve(commitDiff("commit-old"));
    await act(flushAsyncWork);
    expect(latest.commit.commitDiff?.commit_sha).toBe("commit-new");
  });
});
