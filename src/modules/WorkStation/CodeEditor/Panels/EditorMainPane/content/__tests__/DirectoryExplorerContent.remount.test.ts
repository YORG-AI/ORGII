// @vitest-environment jsdom
import { readDir } from "@tauri-apps/plugin-fs";
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

import { getGitCommits } from "@src/api/http/git";
import { resetDirectoryViewResourceForTests } from "@src/services/git/directoryViewResource";

import DirectoryExplorerContent from "../DirectoryExplorerContent";

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: vi.fn(),
}));

vi.mock("@src/api/http/git", () => ({
  getGitCommits: vi.fn(),
}));

vi.mock("@src/components/FileTypeIcon", () => ({
  default: () => null,
}));

vi.mock("@src/engines/ChatPanel/blocks/primitives", () => ({
  ComposerStackListRow: ({ primary }: { primary: string }) =>
    createElement("span", null, primary),
}));

vi.mock("@src/modules/WorkStation/shared", () => ({
  FileHeader: ({ filePath }: { filePath: string }) =>
    createElement("header", null, filePath),
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: ({ variant }: { variant: string }) =>
    createElement("div", { "data-placeholder": variant }, variant),
}));

vi.mock("@src/store/workstation/tabs", () => ({
  createDirectoryTab: vi.fn(),
  openTab: vi.fn(),
  workstationLayoutAtom: {},
}));

vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => ({ set: vi.fn() }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: mocks.t,
  }),
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: Array<{ path: string; type: string }>;
    itemContent: (
      index: number,
      item: { path: string; type: string }
    ) => unknown;
  }) =>
    createElement(
      "div",
      null,
      ...data.map((item, index) =>
        createElement(
          "div",
          { key: `${item.type}:${item.path}` },
          itemContent(index, item) as never
        )
      )
    ),
}));

const readDirMock = vi.mocked(readDir);
const getGitCommitsMock = vi.mocked(getGitCommits);
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("DirectoryExplorerContent remount continuity", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    resetDirectoryViewResourceForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    readDirMock.mockResolvedValue([
      {
        isDirectory: false,
        isFile: true,
        isSymlink: false,
        name: "a.ts",
      },
    ]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("shows entries before metadata settles and keeps them on re-entry", async () => {
    const metadata = deferred<Awaited<ReturnType<typeof getGitCommits>>>();
    getGitCommitsMock.mockReturnValue(metadata.promise);

    await act(async () => {
      root.render(
        createElement(DirectoryExplorerContent, {
          directoryPath: "/repo/src",
          onFileSelect: vi.fn(),
          repoPath: "/repo",
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("a.ts");
    expect(container.querySelector('[data-placeholder="loading"]')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(DirectoryExplorerContent, {
          directoryPath: "/repo/src",
          onFileSelect: vi.fn(),
          repoPath: "/repo",
        })
      );
    });

    expect(container.textContent).toContain("a.ts");
    expect(container.querySelector('[data-placeholder="loading"]')).toBeNull();
    expect(readDirMock).toHaveBeenCalledTimes(1);
    expect(getGitCommitsMock).toHaveBeenCalledTimes(1);

    metadata.resolve({ commits: [], total_count: 0 });
    await act(async () => {
      await metadata.promise;
      await Promise.resolve();
    });
  });
});
