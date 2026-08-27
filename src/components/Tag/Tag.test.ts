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

import Tag from ".";

vi.mock("@src/util/ui/theme/themeUtils", () => ({
  useCurrentTheme: () => ({ theme: "light", isDark: false }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("Tag", () => {
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

  it("dismisses an uncontrolled closable tag without activating its body", () => {
    const onClose = vi.fn();
    const onClick = vi.fn();

    act(() => {
      root.render(
        createElement(Tag, { closable: true, onClose, onClick }, "Closable")
      );
    });

    const close = container.querySelector<HTMLElement>('[aria-label="Close"]');
    expect(close).not.toBeNull();

    act(() => close?.click());

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
    expect(container.querySelector(".tag")).toBeNull();
  });

  it("lets the close affordance dismiss a tag with the keyboard", () => {
    const onClose = vi.fn();

    act(() => {
      root.render(createElement(Tag, { closable: true, onClose }));
    });

    const close = container.querySelector<HTMLElement>('[aria-label="Close"]');
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    });

    act(() => close?.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(container.querySelector(".tag")).toBeNull();
  });

  it("toggles an uncontrolled checkable tag by click and keyboard activation", () => {
    const onCheck = vi.fn();

    act(() => {
      root.render(
        createElement(
          Tag,
          { checkable: true, defaultChecked: false, onCheck },
          "Filter"
        )
      );
    });

    const body = container.querySelector<HTMLElement>('[role="button"]');
    expect(body?.tabIndex).toBe(0);

    act(() => body?.click());
    expect(onCheck).toHaveBeenLastCalledWith(true);
    expect(container.querySelector(".tag")?.classList).toContain("tag-checked");

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: " ",
    });
    act(() => body?.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(onCheck).toHaveBeenLastCalledWith(false);
    expect(container.querySelector(".tag")?.classList).not.toContain(
      "tag-checked"
    );
  });

  it("reports a controlled checkable state change without changing its appearance", () => {
    const onCheck = vi.fn();

    act(() => {
      root.render(
        createElement(
          Tag,
          { checkable: true, checked: true, onCheck },
          "Controlled filter"
        )
      );
    });

    const body = container.querySelector<HTMLElement>('[role="button"]');
    act(() => body?.click());

    expect(onCheck).toHaveBeenCalledWith(false);
    expect(container.querySelector(".tag")?.classList).toContain("tag-checked");
  });

  it("renders custom-color variants with caller styling, icon, and shape props", () => {
    act(() => {
      root.render(
        createElement(
          Tag,
          {
            color: "#123456",
            size: "large",
            bordered: true,
            pill: true,
            icon: createElement("span", { "data-testid": "tag-icon" }, "*"),
            style: { opacity: 0.6 },
          },
          "Custom"
        )
      );
    });

    const tag = container.querySelector<HTMLElement>(".tag");
    expect(tag?.classList).toContain("tag-size-large");
    expect(tag?.classList).toContain("tag-bordered");
    expect(tag?.classList).toContain("tag-pill");
    expect(tag?.style.opacity).toBe("0.6");
    expect(tag?.style.borderColor).toBe("transparent");
    expect(tag?.style.color).toBe("rgb(18, 52, 86)");
    expect(
      container.querySelector('[data-testid="tag-icon"]')?.textContent
    ).toBe("*");
  });
});
