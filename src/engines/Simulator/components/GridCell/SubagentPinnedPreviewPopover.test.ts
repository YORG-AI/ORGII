// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { type TodoItem, sessionTodoMapAtom } from "@src/store/ui/todoAtom";

import { SubagentPinnedPreviewPopover } from "./SubagentPinnedPreviewPopover";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
it("mounts plans on demand, supports keyboard dismissal and scrolling, and releases completed plans", async () => {
  const env = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  env.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  const store = createStore();
  const todos: TodoItem[] = Array.from({ length: 50 }, (_, i) => ({
    id: `todo-${i}`,
    content: `Task ${i}`,
    status: "pending" as const,
  }));
  todos[0].status = "completed";
  todos[1].blockedBy = [1];
  todos[2].blockedBy = [2];
  store.set(
    sessionTodoMapAtom,
    new Map([
      [
        "child",
        { todos, isUpdating: false, isVisible: true, lastUpdatedAt: null },
      ],
    ])
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(
          Provider,
          { store },
          createElement(SubagentPinnedPreviewPopover, { sessionId: "child" })
        )
      )
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const trigger = host.querySelector("button")!;
    expect(trigger.textContent).toContain("1/50");
    act(() => trigger.click());
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(panel).not.toBeNull();
    expect(panel.querySelectorAll("li")).toHaveLength(50);
    expect(
      panel.querySelectorAll("li")[1].classList.contains("opacity-50")
    ).toBe(false);
    expect(
      panel.querySelectorAll("li")[2].classList.contains("opacity-50")
    ).toBe(true);
    expect(panel.querySelector("ul")?.tabIndex).toBe(0);
    expect(
      panel.querySelector("ul")?.classList.contains("overflow-y-auto")
    ).toBe(true);
    act(() =>
      panel.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.click());
    act(() => store.set(sessionTodoMapAtom, new Map()));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector("button")).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
    delete env.IS_REACT_ACT_ENVIRONMENT;
    vi.unstubAllGlobals();
  }
});
