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

import { getGitCommits } from "@src/api/http/git/commits";
import { resetGitHistoryResourceForTests } from "@src/services/git/gitHistoryResource";

import GitHistoryContent from ".";

vi.mock("@src/api/http/git/commits", () => ({
  getGitCommits: vi.fn(),
}));

vi.mock("@src/ActionSystem", () => ({
  useActionSystem: () => ({ dispatch: vi.fn() }),
}));

vi.mock("@src/hooks/tabHost/useWorkStationTabs", () => ({
  useWorkStationTabs: () => ({
    activeTab: { data: {}, type: "source-control" },
    openTab: vi.fn(),
    updateTabData: vi.fn(),
  }),
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: ({ variant }: { variant: string }) =>
    createElement("div", { "data-placeholder": variant }, variant),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: Array<{ sha: string }>;
    itemContent: (index: number, item: { sha: string }) => unknown;
  }) =>
    createElement(
      "div",
      null,
      ...data.map((item, index) =>
        createElement(
          "div",
          { key: item.sha },
          itemContent(index, item) as never
        )
      )
    ),
}));

vi.mock("./GitHistoryContextMenu", () => ({
  default: () => null,
}));

const getGitCommitsMock = vi.mocked(getGitCommits);
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("GitHistoryContent remount continuity", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    resetGitHistoryResourceForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
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
          sha: "abc1234",
          short_sha: "abc1234",
          summary: "Cached commit",
        },
      ],
      total_count: 1,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("renders cached rows instead of a loading placeholder on re-entry", async () => {
    await act(async () => {
      root.render(
        createElement(GitHistoryContent, {
          repoId: "repo-1",
          repoPath: "/repo",
          viewMode: "list",
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Cached commit");

    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(GitHistoryContent, {
          repoId: "repo-1",
          repoPath: "/repo",
          viewMode: "list",
        })
      );
    });

    expect(container.textContent).toContain("Cached commit");
    expect(container.querySelector('[data-placeholder="loading"]')).toBeNull();
    expect(getGitCommitsMock).toHaveBeenCalledTimes(1);
  });
});
