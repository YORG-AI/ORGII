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
});
