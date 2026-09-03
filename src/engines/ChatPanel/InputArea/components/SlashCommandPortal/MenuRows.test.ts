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

import { SlashItemRow } from "./MenuRows";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("SlashItemRow", () => {
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

  it("toggles a pin without inserting the skill", () => {
    const onClick = vi.fn();
    const onTogglePin = vi.fn();

    act(() => {
      root.render(
        createElement(SlashItemRow, {
          item: {
            name: "review-code",
            category: "skill",
            source: "Workspace Skills",
            description: "Review code",
            acceptsArgs: false,
          },
          isActive: true,
          isPinned: false,
          onMouseEnter: vi.fn(),
          onClick,
          onTogglePin,
        })
      );
    });

    const pinButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="slash-command-pin"]'
    );
    expect(pinButton?.getAttribute("aria-pressed")).toBe("false");
    expect(pinButton?.classList.contains("button")).toBe(true);
    expect(pinButton?.className).toContain("enabled:hover:bg-fill-3");
    expect(pinButton?.className).not.toContain("shadow-sidebar-pill");

    act(() => {
      pinButton?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
    });

    expect(onTogglePin).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
  });
});
