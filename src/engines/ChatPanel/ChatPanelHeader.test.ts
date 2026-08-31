// @vitest-environment jsdom
import type { TFunction } from "i18next";
import { type ReactNode, createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./components/SessionHeaderActionsMenu", () => ({
  SessionHeaderActionsMenu: () =>
    createElement("button", { "data-session-actions": "true" }),
}));
vi.mock("@src/scaffold/NavigationSidebar/CollapsedSidebarButton", () => ({
  CollapsedSidebarButton: () =>
    createElement("button", { "data-collapsed-sidebar": "true" }),
}));
vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  // The real tooltip portals into document.body, which the static renderer
  // rejects; the controls under test are its children.
  ToolbarTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./header/ChatPanelCollapsedTabHeading", () => ({
  ChatPanelCollapsedTabHeading: () =>
    createElement("span", { "data-collapsed-heading": "true" }),
}));

const { getCollapsedSidebarChromeOffset } =
  await import("@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset");
const { ChatPanelHeader } = await import("./ChatPanelHeader");

const noop = () => undefined;

interface RenderOptions {
  tabRowCollapsed: boolean;
  sessionHeaderContent?: ReactNode;
  shouldOffsetHeaderForCollapsedSidebar?: boolean;
}

function render({
  tabRowCollapsed,
  sessionHeaderContent = createElement("span", { "data-session-name": "true" }),
  shouldOffsetHeaderForCollapsedSidebar = false,
}: RenderOptions): string {
  return renderToStaticMarkup(
    createElement(ChatPanelHeader, {
      activeSessionExists: true,
      chatPanelPosition: "left",
      copyEventJsonLabel: "idle" as const,
      currentSessionId: "session-a",
      displayMode: "full" as const,
      eventsLength: 3,
      handleChatFocusToggle: noop,
      handleCompactDisplayModeToggle: noop,
      handleCopyEventJson: noop,
      handleMoveToWorkstation: noop,
      handleOpenExportSessionJson: noop,
      handleOpenLinkWorkItem: noop,
      handleOpenCloudShareSettings: noop,
      handleOpenSearch: noop,
      handlePaginationToggle: noop,
      handleReloadFromMenu: noop,
      handleTokenUsageVisibleToggle: noop,
      handleTurnMetadataVisibleToggle: noop,
      headerActionsDropdownRef: createRef<HTMLDivElement>(),
      headerActionsPosition: { left: 0, width: 240, maxHeight: 480 },
      headerActionsTriggerRef: createRef<HTMLButtonElement>(),
      isChatFocus: true,
      isHeaderActionsOpen: false,
      isHeaderActionsPositioned: false,
      paginationEnabled: false,
      tokenUsageVisible: false,
      turnMetadataVisible: false,
      shouldOffsetHeaderForCollapsedSidebar,
      stationAvailable: true,
      showHeader: true,
      showSessionContent: true,
      showCloudShareSettings: false,
      t: ((key: string) => key) as unknown as TFunction<
        ["sessions", "common", "projects", "navigation"]
      >,
      toggleHeaderActionsMenu: noop,
      visibleRegionNotice: null,
      showTuiModeToggle: false,
      tuiMode: false,
      handleTuiModeToggle: noop,
      tabStrip: createElement("nav", { "data-tab-strip": "true" }),
      tabStripPlus: createElement("button", { "data-plus-menu": "true" }),
      tabRowCollapsed,
      sessionHeaderContent,
    })
  );
}

describe("ChatPanelHeader tab row collapse", () => {
  it("keeps both rows while the tab strip is worth showing", () => {
    const markup = render({ tabRowCollapsed: false });

    expect(markup).toContain('data-testid="chat-panel-header"');
    expect(markup).toContain('data-tab-strip="true"');
    expect(markup).toContain('data-testid="chat-panel-published-header"');
    expect(markup).toContain("border-b border-border-2");
    expect(markup).not.toContain(
      'data-testid="chat-panel-collapsed-tab-controls"'
    );
    expect(markup).toContain('style="height:80px"');
  });

  it("drops the tab row and rehomes its controls onto the 40px row", () => {
    const markup = render({ tabRowCollapsed: true });

    expect(markup).not.toContain('data-testid="chat-panel-header"');
    expect(markup).not.toContain('data-tab-strip="true"');
    expect(markup).toContain('data-testid="chat-panel-published-header"');
    expect(markup).toContain('data-testid="chat-panel-collapsed-tab-controls"');
    // + / restore / close all survive the fold.
    expect(markup).toContain('data-plus-menu="true"');
    expect(markup).toContain('data-icon="layout-align-right"');
    expect(markup).toContain('data-icon="panel-right"');
    // Swapped, never cross-faded — overlapping the two near-identical
    // outlines is what made the icon shake on hover.
    expect(markup).toContain("group-hover:hidden");
    expect(markup).toContain("hidden group-hover:block");
    expect(markup).not.toContain("transition-opacity");
    // Close is deliberately not offered in the folded row.
    expect(markup).not.toContain('data-icon="x"');
    expect(markup).toContain('style="height:44px"');
    // The maximized pane's only chrome — no rule under it.
    expect(markup).not.toContain("border-b border-border-2");
    // The window-edge gap the folded 44px row used to hold (its pt-2).
    expect(markup).toContain('data-testid="chat-panel-collapsed-header"');
    expect(markup).toContain("padding-top:8px");
  });

  it("names a surface that publishes no header content of its own", () => {
    const unpublished = render({
      tabRowCollapsed: true,
      sessionHeaderContent: null,
    });

    expect(unpublished).toContain('data-collapsed-heading="true"');
    expect(render({ tabRowCollapsed: true })).not.toContain(
      'data-collapsed-heading="true"'
    );
  });

  it("moves the collapsed-sidebar button and its platform inset onto the row that leads the pane", () => {
    const collapsed = render({
      tabRowCollapsed: true,
      shouldOffsetHeaderForCollapsedSidebar: true,
    });

    // The 40px row is now the pane's top edge, so it owns the reservation for
    // the host window controls (macOS traffic lights) the tab row used to hold.
    expect(collapsed).toContain('data-collapsed-sidebar="true"');
    // The published row is z-40 and spans the button's reserved left inset.
    // Keep the visible button above that transparent drag surface so it owns
    // the pointer hit instead of starting a window drag.
    expect(collapsed).toMatch(
      /class="z-50"[^>]*data-testid="chat-panel-collapsed-sidebar-chrome"/
    );
    expect(collapsed).toContain(
      `padding-left:${getCollapsedSidebarChromeOffset()}px`
    );
    expect(collapsed).not.toContain("pl-[15px]");

    // With the sidebar expanded it owns that reservation, so the row keeps the
    // shared published-header inset.
    const withSidebar = render({ tabRowCollapsed: true });
    expect(withSidebar).not.toContain("padding-left:");
    expect(withSidebar).toContain("pl-[15px]");
  });
});
