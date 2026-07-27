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

import RepoScopePicker from ".";

const mocks = vi.hoisted(() => ({
  loadRepos: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/scaffold/GlobalSpotlight/hooks/data/useSharedRepoList", () => ({
  default: () => ({
    repos: [
      {
        id: "repo-1",
        name: "orca",
        repo_url: "https://github.com/stablyai/orca.git",
      },
    ],
    repoLoading: false,
    loadRepos: mocks.loadRepos,
  }),
}));

vi.mock("../../repoScopeResolver", () => ({
  getShareableScopeKeyVersion: () => 0,
  peekShareableScopeKey: () => undefined,
  primeShareableScopeKey: vi.fn(),
  subscribeShareableScopeKeys: () => {
    mocks.subscribe();
    return mocks.unsubscribe;
  },
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("RepoScopePicker", () => {
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

  it("renders repository name, separator, and remote URL on one line", async () => {
    await act(async () => {
      root.render(
        createElement(RepoScopePicker, {
          selectedKeys: [],
          onChange: vi.fn(),
        })
      );
    });

    const row = container.querySelector<HTMLButtonElement>("button");
    const content = row?.firstElementChild;
    expect(
      container.querySelector('[data-testid="repo-scope-picker"]')?.classList
    ).toContain("w-full");
    expect(content?.classList).toContain("items-center");
    expect(content?.classList).not.toContain("flex-col");
    expect(content?.textContent).toBe("orca·github.com/stablyai/orca");
    expect(
      content?.querySelector('[title="github.com/stablyai/orca"]')
    ).not.toBeNull();
  });

  it("disables an already-selected repository in add-only mode", async () => {
    await act(async () => {
      root.render(
        createElement(RepoScopePicker, {
          selectedKeys: ["github.com/stablyai/orca"],
          onChange: vi.fn(),
          addOnly: true,
        })
      );
    });

    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(
      true
    );
  });

  it("releases its repository-key subscription when it unmounts", async () => {
    await act(async () => {
      root.render(
        createElement(RepoScopePicker, {
          selectedKeys: [],
          onChange: vi.fn(),
        })
      );
    });
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });
});
