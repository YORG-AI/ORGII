// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
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

import type { GitFile } from "@src/types/git/types";

import { useGitDiffLoader } from "./useGitDiffLoader";

const mocks = vi.hoisted(() => ({ loadWorkingTreeDiff: vi.fn() }));

vi.mock("@src/services/git/workingTreeDiffResource", () => ({
  loadWorkingTreeDiff: mocks.loadWorkingTreeDiff,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function gitFile(id: string): GitFile {
  return {
    id,
    path: `/repo/${id}.ts`,
    status: "modified",
    additions: 1,
    deletions: 1,
    staged: false,
  };
}

describe("useGitDiffLoader", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("ignores an obsolete request after the selected file changes", async () => {
    const first = deferred<{
      oldContent: string;
      newContent: string;
      additions: number;
      deletions: number;
      binary: boolean;
    } | null>();
    const second = deferred<{
      oldContent: string;
      newContent: string;
      additions: number;
      deletions: number;
      binary: boolean;
    } | null>();
    mocks.loadWorkingTreeDiff
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    let latest: ReturnType<typeof useGitDiffLoader> | null = null;
    const Harness = ({ file }: { file: GitFile }) => {
      const value = useGitDiffLoader({ gitFile: file, repoPath: "/repo" });
      useEffect(() => {
        latest = value;
      }, [value]);
      return null;
    };

    act(() => root.render(createElement(Harness, { file: gitFile("a") })));
    expect(latest!.selfFetching).toBe(true);

    act(() => root.render(createElement(Harness, { file: gitFile("b") })));
    await act(async () => {
      first.resolve({
        oldContent: "old a",
        newContent: "new a",
        additions: 1,
        deletions: 1,
        binary: false,
      });
      await first.promise;
    });
    expect(latest!.effectiveGitFile?.path).toBe("/repo/b.ts");
    expect(latest!.effectiveGitFile?.oldContent).toBeUndefined();
    expect(latest!.selfFetching).toBe(true);

    await act(async () => {
      second.resolve({
        oldContent: "old b",
        newContent: "new b",
        additions: 2,
        deletions: 3,
        binary: false,
      });
      await second.promise;
    });
    expect(latest!.effectiveGitFile).toMatchObject({
      path: "/repo/b.ts",
      oldContent: "old b",
      newContent: "new b",
      additions: 2,
      deletions: 3,
    });
    expect(latest!.selfFetching).toBe(false);
  });
});
