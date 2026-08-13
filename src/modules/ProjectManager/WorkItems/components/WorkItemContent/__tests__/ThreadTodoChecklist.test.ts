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

import ThreadTodoChecklist from "../ThreadTodoChecklist";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("ThreadTodoChecklist", () => {
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

  it("uses the canonical icon-only header action for adding a To-Do", () => {
    act(() => {
      root.render(
        createElement(ThreadTodoChecklist, {
          todos: [],
          onChange: vi.fn(),
        })
      );
    });

    const addButton = container.querySelector<HTMLButtonElement>(
      "[data-testid='work-item-thread-todo-add']"
    );

    expect(addButton?.textContent).toBe("");
    expect(addButton?.getAttribute("aria-label")).toBe("common:actions.add");
    expect(addButton?.title).toBe("common:actions.add");
    expect(addButton?.className).toContain("text-text-3");
    expect(addButton?.className).toContain("hover:bg-fill-2");
    expect(addButton?.querySelector(".lucide-plus")).not.toBeNull();
  });

  it("uses flat square tertiary ghost actions in the inline composer", () => {
    act(() => {
      root.render(
        createElement(ThreadTodoChecklist, {
          todos: [],
          onChange: vi.fn(),
        })
      );
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-testid='work-item-thread-todo-add']"
        )
        ?.click();
    });

    const commitButton = container.querySelector<HTMLButtonElement>(
      "[data-testid='work-item-thread-todo-commit']"
    );
    const cancelButton = container.querySelector<HTMLButtonElement>(
      "[data-testid='work-item-thread-todo-cancel']"
    );
    const inputWrapper = container
      .querySelector("[data-testid='work-item-thread-todo-input']")
      ?.closest(".input-wrapper");
    const composer = container.querySelector(
      "[data-testid='work-item-thread-todo-input']"
    )?.parentElement?.parentElement?.parentElement;

    for (const button of [commitButton, cancelButton]) {
      expect(button?.className).toContain("border-0");
      expect(button?.className).toContain("bg-transparent");
      expect(button?.style.borderRadius).toBe("8px");
    }
    expect(composer?.className).not.toContain("bg-fill-1");
    expect(composer?.className).toContain("py-2");
    expect(inputWrapper?.className).toContain("input-field-ghost");
    expect(commitButton?.querySelector(".lucide-plus")).not.toBeNull();
    expect(cancelButton?.querySelector(".lucide-x")).not.toBeNull();
  });
});
