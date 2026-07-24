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

import type { GitHubStarResult } from "@src/api/tauri/githubStar";

import { ORGII_GITHUB_URL } from "./constants";
import {
  type GitHubStarController,
  type GitHubStarControllerDependencies,
  useGitHubStarController,
} from "./useGitHubStarController";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useGitHubStarController", () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: GitHubStarController;
  let dependencies: GitHubStarControllerDependencies;
  let checkMock: ReturnType<typeof vi.fn>;
  let starMock: ReturnType<typeof vi.fn>;
  let openExternalMock: ReturnType<typeof vi.fn>;
  let onConfirmedStarred: ReturnType<typeof vi.fn>;
  let onController: (value: GitHubStarController) => void;

  function Harness() {
    const currentController = useGitHubStarController({
      source: "reminder",
      onConfirmedStarred,
      dependencies,
    });

    useEffect(() => {
      onController(currentController);
    }, [currentController]);

    return createElement("span", null, currentController.state.status);
  }

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    checkMock = vi.fn().mockResolvedValue({ status: "not_starred" });
    starMock = vi.fn().mockResolvedValue({ status: "starred" });
    openExternalMock = vi.fn().mockResolvedValue(undefined);
    onConfirmedStarred = vi.fn();
    onController = (value) => {
      controller = value;
    };
    dependencies = {
      check: checkMock as () => Promise<GitHubStarResult>,
      star: starMock as () => Promise<GitHubStarResult>,
      openExternal: openExternalMock as (url: string) => Promise<void>,
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("moves from loading to not-starred and confirms only backend success", async () => {
    const star = deferred<GitHubStarResult>();
    starMock.mockReturnValueOnce(star.promise);

    act(() => root.render(createElement(Harness)));
    expect(container.textContent).toBe("loading");
    await flush();
    expect(container.textContent).toBe("not-starred");

    let action!: Promise<void>;
    act(() => {
      action = controller.confirmStar();
    });
    expect(container.textContent).toBe("starring");
    expect(onConfirmedStarred).not.toHaveBeenCalled();

    star.resolve({ status: "starred" });
    await act(async () => action);
    expect(container.textContent).toBe("starred");
    expect(onConfirmedStarred).toHaveBeenCalledTimes(1);
  });

  it("opening the fallback does not count as success", async () => {
    starMock.mockResolvedValueOnce({
      status: "unavailable",
      reason: "gh_missing",
    });
    act(() => root.render(createElement(Harness)));
    await flush();

    await act(async () => controller.confirmStar());

    expect(openExternalMock).toHaveBeenCalledWith(ORGII_GITHUB_URL);
    expect(controller.state.status).toBe("web-fallback");
    expect(onConfirmedStarred).not.toHaveBeenCalled();
  });

  it("rechecks on focus only after this controller opened a fallback", async () => {
    act(() => root.render(createElement(Harness)));
    await flush();

    act(() => window.dispatchEvent(new Event("focus")));
    expect(checkMock).toHaveBeenCalledTimes(1);

    await act(async () => controller.openFallback());
    checkMock.mockResolvedValueOnce({ status: "starred" });
    act(() => window.dispatchEvent(new Event("focus")));
    await flush();

    expect(checkMock).toHaveBeenCalledTimes(2);
    expect(controller.state.status).toBe("starred");
    expect(onConfirmedStarred).toHaveBeenCalledTimes(1);
  });

  it("removes its action-driven focus listener on unmount", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    act(() => root.render(createElement(Harness)));
    await flush();
    await act(async () => controller.openFallback());

    const focusHandler = addSpy.mock.calls.find(
      ([type]) => type === "focus"
    )?.[1];
    expect(focusHandler).toBeDefined();

    act(() => root.unmount());
    expect(removeSpy).toHaveBeenCalledWith("focus", focusHandler);
    root = createRoot(container);
  });
});
