// @vitest-environment jsdom
import { type ComponentType, act, createElement } from "react";
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

import PrHoverCard, { type PrHoverCardData } from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// React 19's createElement overload requires a required `children` prop inside
// the props object even when children are supplied as the third argument.
const RenderablePrHoverCard = PrHoverCard as ComponentType<{
  pr: PrHoverCardData;
  mouseEnterDelay: number;
}>;

describe("PrHoverCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document
      .querySelectorAll('[data-hover-card="true"]')
      .forEach((element) => element.remove());
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  });

  it("shows additions and deletions as a change-scope row", () => {
    act(() => {
      root.render(
        createElement(
          RenderablePrHoverCard,
          {
            pr: {
              number: 42,
              title: "Show change scope",
              state: "open",
              additions: 128,
              deletions: 17,
            },
            mouseEnterDelay: 0,
          },
          createElement("button", { type: "button" }, "PR #42")
        )
      );
    });

    act(() => {
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    const stats = document.querySelector(
      '[data-testid="pr-hover-card-diff-stats"]'
    );
    expect(stats?.textContent).toContain("Changes");
    expect(stats?.textContent).toContain("+128");
    expect(stats?.textContent).toContain("-17");
  });

  it("omits the row when GitHub did not provide diff stats", () => {
    act(() => {
      root.render(
        createElement(
          RenderablePrHoverCard,
          {
            pr: {
              number: 43,
              title: "No metadata",
              state: "open",
            },
            mouseEnterDelay: 0,
          },
          createElement("button", { type: "button" }, "PR #43")
        )
      );
    });

    act(() => {
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    expect(
      document.querySelector('[data-testid="pr-hover-card-diff-stats"]')
    ).toBeNull();
  });
});
