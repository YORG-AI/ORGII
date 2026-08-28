import { type ReactNode, createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./TabContent/UnifiedChatPanelTabContent", () => ({
  UnifiedChatPanelTabContent: ({ chatColumn }: { chatColumn: ReactNode }) =>
    createElement("div", { "data-unified-content": "true" }, chatColumn),
}));

const { ChatPanelShell } = await import("./ChatPanelShell");

function render(focusedWorkstationRail?: ReactNode): string {
  return renderToStaticMarkup(
    createElement(ChatPanelShell, {
      activeTab: null,
      borderClasses: "",
      chatColumn: createElement("main", { "data-chat-column": "true" }),
      chatPanelOpacityStyle: {},
      chatWidth: 1200,
      chatWidthStyleValue: "100%",
      embedded: true,
      focusedWorkstationRail,
      headerSection: createElement("header", {
        "data-chat-header": "true",
      }),
      isDragging: false,
      isLeftPosition: false,
      isTerminalTabActive: false,
      onResizeMouseDown: () => undefined,
      panelRef: createRef<HTMLDivElement>(),
      resizeTooltipLabel: "Hide Workstation",
      resizeTooltipShortcut: "Alt+Cmd+B",
      sessionModals: null,
      showResizeHandle: false,
      terminalTabs: [],
      useExternalWidth: true,
    })
  );
}

describe("ChatPanelShell focused workstation layout", () => {
  it("keeps chat content flexible to the left of the fixed workstation rail", () => {
    const markup = render(
      createElement("aside", { "data-focused-workstation-rail": "true" })
    );

    expect(markup).toContain("@container/focusedchat");

    const contentIndex = markup.indexOf('data-unified-content="true"');
    const railIndex = markup.indexOf('data-focused-workstation-rail="true"');

    expect(markup).not.toContain('aria-hidden="true"');
    expect(contentIndex).toBeGreaterThanOrEqual(0);
    expect(railIndex).toBeGreaterThan(contentIndex);
  });

  it("renders the chat body without a trailing column when controls are absent", () => {
    const markup = render();

    expect(markup).not.toContain('aria-hidden="true"');
    expect(markup).toContain('data-unified-content="true"');
  });
});
