// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";

vi.mock("../ChatPanelTerminalContent", () => ({
  ChatPanelTerminalContent: ({
    tabId,
    visible,
  }: {
    tabId: string;
    visible: boolean;
  }) =>
    createElement("div", {
      "data-testid": "terminal",
      "data-tab-id": tabId,
      "data-visible": String(visible),
    }),
}));

const { CHAT_TERMINAL_KEEP_ALIVE, UnifiedChatPanelTabContent } =
  await import("./UnifiedChatPanelTabContent");

function terminalTab(id: string): ChatPanelTab {
  return {
    id,
    type: "terminal",
    title: id,
    terminalSessionId: `chatpanel-${id}`,
  } as unknown as ChatPanelTab;
}

describe("UnifiedChatPanelTabContent terminal keep-alive", () => {
  let container: HTMLDivElement;
  let root: Root;
  const tabs = [terminalTab("t1"), terminalTab("t2"), terminalTab("t3")];

  const mountedTerminalIds = () =>
    [...container.querySelectorAll('[data-testid="terminal"]')]
      .map((node) => node.getAttribute("data-tab-id"))
      .sort();

  const render = async (activeIndex: number) => {
    await act(async () => {
      root.render(
        createElement(UnifiedChatPanelTabContent, {
          activeTab: tabs[activeIndex],
          chatColumn: null,
          hasTabBar: true,
          isTerminalTabActive: true,
          terminalTabs: tabs,
        })
      );
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("mounts only the active terminal at first, then keeps the previous one warm and unmounts it after the grace window", async () => {
    await render(0);
    expect(mountedTerminalIds()).toEqual(["t1"]);

    await render(1);
    expect(mountedTerminalIds()).toEqual(["t1", "t2"]);
    expect(
      container
        .querySelector('[data-tab-id="t1"]')
        ?.closest("div[style]")
        ?.getAttribute("style")
    ).toContain("display: none");

    await act(async () => {
      vi.advanceTimersByTime(CHAT_TERMINAL_KEEP_ALIVE.graceMs);
    });
    expect(mountedTerminalIds()).toEqual(["t2"]);
  });

  it("never keeps more than maxWarm terminals mounted", async () => {
    await render(0);
    await render(1);
    await render(2);
    expect(mountedTerminalIds().length).toBe(CHAT_TERMINAL_KEEP_ALIVE.maxWarm);
    expect(mountedTerminalIds()).toEqual(["t2", "t3"]);
  });
});
