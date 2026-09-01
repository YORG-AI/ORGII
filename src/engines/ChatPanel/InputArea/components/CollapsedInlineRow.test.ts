// @vitest-environment jsdom
import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ScrollNavState } from "../../ChatHistory";
import CollapsedInlineRow, { type InlineSection } from "./CollapsedInlineRow";

vi.mock("@src/components/Tooltip", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

const idleSurfaceClasses = [
  "bg-bg-2!",
  "enabled:hover:bg-surface-hover!",
] as const;

function expectIdleSurface(element: Element | null) {
  expect(element).not.toBeNull();
  for (const className of idleSurfaceClasses) {
    expect(element?.classList.contains(className)).toBe(true);
  }
}

describe("CollapsedInlineRow", () => {
  it("uses the shared surfaces for every composer action pill", () => {
    const sections: InlineSection[] = [
      {
        key: "idle",
        icon: null,
        count: 1,
        active: false,
        onExpand: vi.fn(),
        testId: "idle-section-pill",
      },
      {
        key: "active",
        icon: null,
        count: 2,
        active: true,
        onExpand: vi.fn(),
        testId: "active-section-pill",
      },
    ];
    const scrollNav: ScrollNavState = {
      showAddToConversation: true,
      addToConversationLabel: "Add to conversation",
      addToConversationTooltipLabel: "Add to conversation",
      cancelAddToConversationLabel: "Cancel add to conversation",
      onAddToConversation: vi.fn(),
      onCancelAddToConversation: vi.fn(),
      showFollowAgent: true,
      followAgentLabel: "Follow agent",
      followAgentTooltipLabel: "Follow agent",
      followAgentShortcut: "",
      onFollowAgent: vi.fn(),
      showScrollToBottom: false,
      onScrollToBottom: vi.fn(),
    };
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      createElement(CollapsedInlineRow, {
        sections,
        scrollNav,
        canvasPreview: { label: "Canvas", onOpen: vi.fn() },
      })
    );

    expectIdleSurface(
      container.querySelector('[data-testid="idle-section-pill"]')
    );
    expectIdleSurface(
      container.querySelector(
        '[data-testid="browser-add-to-conversation-pill"]'
      )
    );
    expectIdleSurface(
      container.querySelector(
        '[data-testid="browser-cancel-add-to-conversation-pill"]'
      )
    );
    expectIdleSurface(container.querySelector('[aria-label="Canvas"]'));
    expectIdleSurface(container.querySelector('[aria-label="Follow agent"]'));

    const active = container.querySelector(
      '[data-testid="active-section-pill"]'
    );
    expect(active?.classList.contains("bg-surface-hover!")).toBe(true);
    expect(active?.classList.contains("border-primary-6!")).toBe(true);
    expect(active?.classList.contains("text-primary-6!")).toBe(true);
  });
});
