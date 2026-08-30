// @vitest-environment jsdom
import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import FloatingScrollNav from ".";

vi.mock("@src/components/Tooltip", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

describe("FloatingScrollNav", () => {
  it("uses the shared idle surface for every navigation control", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      createElement(FloatingScrollNav, {
        showScrollToBottom: true,
        onScrollToBottom: vi.fn(),
        markAllAsRead: { label: "Mark all as read", onClick: vi.fn() },
        catchUp: { label: "Catch up", onClick: vi.fn() },
        followAgent: { label: "Follow agent", onClick: vi.fn() },
      })
    );

    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button.classList.contains("!bg-bg-2")).toBe(true);
      expect(button.classList.contains("enabled:hover:!bg-surface-hover")).toBe(
        true
      );
    }
  });
});
