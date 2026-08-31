// @vitest-environment jsdom
import React, { act } from "react";
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

import ScopeInfoLine from "../ScopeInfoLine";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("ScopeInfoLine", () => {
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
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("uses canonical select controls and resets scope when category changes", async () => {
    const onScopeChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(ScopeInfoLine, {
          scope: { category: "repo", repoIds: [] },
          onScopeChange,
          repos: [{ id: "repo-1", name: "Repository one" }],
        })
      );
    });

    const controls =
      container.querySelectorAll<HTMLElement>('[role="combobox"]');
    expect(controls).toHaveLength(2);
    expect(controls[0].getAttribute("aria-label")).toBe("scope.selectCategory");
    expect(controls[1].getAttribute("aria-label")).toBe("scope.selectScope");

    await act(async () => {
      controls[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve())
      );
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    const sessionOption = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="option"]')
    ).find((option) =>
      option.textContent?.includes("scope.categories.session")
    );
    expect(sessionOption).toBeDefined();
    expect(sessionOption?.getAttribute("aria-selected")).toBe("false");

    act(() => {
      sessionOption?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onScopeChange).toHaveBeenCalledWith({
      category: "session",
      repoIds: undefined,
      sessionIds: [],
      sessionRepoFilter: "all",
      projectIds: undefined,
      workItemIds: undefined,
      workItemProjectFilter: undefined,
    });
  });
});
