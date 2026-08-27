// @vitest-environment jsdom
import { Fragment, act, createElement } from "react";
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

import { useSourceControlTabConfig } from "../SourceControlTab";

const mocks = vi.hoisted(() => ({
  useRepoGitInitialization: vi.fn(),
}));

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtomValue: () => [],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/contexts/git", () => ({
  useGitStatus: () => ({
    currentGitStatus: { exists: true },
    forceRefresh: vi.fn(),
  }),
}));

vi.mock("@src/hooks/git", () => ({
  useRepoGitInitialization: mocks.useRepoGitInitialization,
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: () => "loading-placeholder",
}));

vi.mock("../../hooks/useGitWorktrees", () => ({
  useGitWorktrees: () => ({
    worktrees: [],
    hasWorktrees: false,
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../hooks/useSourceControlScope", () => ({
  useSourceControlScope: () => ({ scope: { kind: "local" } }),
}));

vi.mock("../../content/MultiRootSourceControlContent", () => ({
  default: () => "multi-root-source-control",
}));

vi.mock("../SourceControlTabPanels", () => ({
  NotGitInitializedContent: () => "not-git-initialized",
  SourceControlTabContent: () => "source-control-content",
  SourceControlWithWorktrees: () => "worktree-source-control",
}));

function Harness() {
  const tab = useSourceControlTabConfig({
    repoPath: "/workspace/repo",
    repoId: "repo-1",
    showFilter: false,
    viewMode: "list-tree",
    sourceControlRef: { current: null },
    actions: [],
    worktrees: [],
    hasWorktrees: false,
    worktreesLoading: false,
  });

  return createElement(Fragment, null, tab.sections?.[0]?.content);
}

describe("SourceControlTab initialization gate", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.useRepoGitInitialization.mockImplementation(
      (_repoPath: string, options: { knownGitStatusExists?: boolean }) => ({
        isGitInitialized: options.knownGitStatusExists ?? null,
        refreshGitInitialization: vi.fn(),
      })
    );
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
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("renders Source Control immediately from the scoped status hint", () => {
    act(() => {
      root.render(createElement(Harness));
    });

    expect(mocks.useRepoGitInitialization).toHaveBeenCalledWith(
      "/workspace/repo",
      { knownGitStatusExists: true }
    );
    expect(container.textContent).toBe("source-control-content");
    expect(container.textContent).not.toContain("loading-placeholder");
  });
});
