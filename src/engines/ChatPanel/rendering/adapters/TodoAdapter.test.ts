import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";
import { sessionTodoMapAtom } from "@src/store/ui/todoAtom";

import { TodoAdapter } from "./TodoAdapter";

vi.mock("../../blocks/TodoBlock", async () => {
  const React = await import("react");
  return {
    default: ({ todos }: { todos: Array<{ content: string }> }) =>
      React.createElement(
        "div",
        { "data-testid": "todo-labels" },
        todos.map((todo) => todo.content).join("|")
      ),
  };
});

vi.mock("@src/engines/SessionCore/rendering/registry", () => ({
  statusToLifecycle: () => "success",
  useLifecycleLabels: () => ({ success: "Updated to-do" }),
}));

describe("TodoAdapter", () => {
  it("backfills an empty event title from the reconstructed session todo state", () => {
    const store = createStore();
    store.set(
      sessionTodoMapAtom,
      new Map([
        [
          "session-1",
          {
            todos: [
              {
                id: "0",
                content: "Review repository structure",
                status: "completed" as const,
              },
            ],
            isUpdating: false,
            lastUpdatedAt: null,
            isVisible: true,
          },
        ],
      ])
    );

    const props: UniversalEventProps = {
      eventId: "todo-update",
      eventType: "manage_todo",
      functionName: "manage_todo",
      sessionId: "session-1",
      args: { action: "update", index: 0, status: "completed" },
      result: {
        todos: [{ id: "0", content: "", status: "completed" }],
      },
      status: "success",
      variant: "chat",
      context: "chat",
    };

    const markup = renderToStaticMarkup(
      createElement(Provider, { store }, createElement(TodoAdapter, props))
    );

    expect(markup).toContain("Review repository structure");
  });
});
