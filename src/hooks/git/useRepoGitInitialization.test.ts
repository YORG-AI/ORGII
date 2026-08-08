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

import {
  type RepoGitInitializationState,
  useRepoGitInitialization,
} from "./useRepoGitInitialization";

const mocks = vi.hoisted(() => ({
  checkIsGitRepo: vi.fn(),
}));

vi.mock("@src/api/tauri/repo", () => ({
  repoApi: {
    checkIsGitRepo: mocks.checkIsGitRepo,
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function initializationLabel(
  value: RepoGitInitializationState
): "loading" | "ready" | "uninitialized" {
  return value === null ? "loading" : value ? "ready" : "uninitialized";
}

function Harness({
  knownGitStatusExists,
  repoPath,
}: {
  knownGitStatusExists?: boolean;
  repoPath: string | null;
}) {
  const { isGitInitialized } = useRepoGitInitialization(repoPath, {
    knownGitStatusExists,
  });

  return createElement("div", {
    "data-initialization-state": initializationLabel(isGitInitialized),
  });
}

describe("useRepoGitInitialization", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
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
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps a known initialized repo visible while the remount check is pending", async () => {
    const check = deferred<boolean>();
    mocks.checkIsGitRepo.mockReturnValue(check.promise);

    act(() => {
      root.render(
        createElement(Harness, {
          repoPath: "/workspace/repo",
          knownGitStatusExists: true,
        })
      );
    });

    expect(
      container.firstElementChild?.getAttribute("data-initialization-state")
    ).toBe("ready");

    await act(async () => {
      check.resolve(true);
      await check.promise;
    });

    expect(
      container.firstElementChild?.getAttribute("data-initialization-state")
    ).toBe("ready");
  });

  it("shows loading when neither the status owner nor the check has a result", () => {
    mocks.checkIsGitRepo.mockReturnValue(new Promise<boolean>(() => {}));

    act(() => {
      root.render(
        createElement(Harness, {
          repoPath: "/workspace/first-load",
        })
      );
    });

    expect(
      container.firstElementChild?.getAttribute("data-initialization-state")
    ).toBe("loading");
  });

  it("prefers a newer scoped Git status over the fallback check result", async () => {
    mocks.checkIsGitRepo.mockResolvedValue(true);

    await act(async () => {
      root.render(
        createElement(Harness, {
          repoPath: "/workspace/repo",
        })
      );
    });

    expect(
      container.firstElementChild?.getAttribute("data-initialization-state")
    ).toBe("ready");

    act(() => {
      root.render(
        createElement(Harness, {
          repoPath: "/workspace/repo",
          knownGitStatusExists: false,
        })
      );
    });

    expect(
      container.firstElementChild?.getAttribute("data-initialization-state")
    ).toBe("uninitialized");
  });

  it("does not expose the previous repo result after a scope switch", async () => {
    const firstCheck = deferred<boolean>();
    const secondCheck = deferred<boolean>();
    mocks.checkIsGitRepo
      .mockReturnValueOnce(firstCheck.promise)
      .mockReturnValueOnce(secondCheck.promise);

    act(() => {
      root.render(
        createElement(Harness, {
          repoPath: "/workspace/first",
          knownGitStatusExists: true,
        })
      );
    });

    act(() => {
      root.render(
        createElement(Harness, {
          repoPath: "/workspace/second",
        })
      );
    });

    expect(
      container.firstElementChild?.getAttribute("data-initialization-state")
    ).toBe("loading");

    await act(async () => {
      firstCheck.resolve(false);
      await firstCheck.promise;
    });

    expect(
      container.firstElementChild?.getAttribute("data-initialization-state")
    ).toBe("loading");

    await act(async () => {
      secondCheck.resolve(false);
      await secondCheck.promise;
    });

    expect(
      container.firstElementChild?.getAttribute("data-initialization-state")
    ).toBe("uninitialized");
  });
});
