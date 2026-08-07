import { describe, expect, it, vi } from "vitest";

import {
  CHAT_PANEL_CREATE_TARGET,
  CHAT_PANEL_SURFACE_KIND,
} from "@src/store/ui/chatPanelAtom";

import { openNewChatFromSidebar } from "./sessionEntryActions";

describe("openNewChatFromSidebar", () => {
  it("activates a new ChatPanel tab after resetting the session draft", () => {
    const calls: string[] = [];
    const navigateChatPanel = vi.fn(() => calls.push("navigate"));
    const setChatPanelCreateTarget = vi.fn(() => calls.push("target"));
    const goToNewSession = vi.fn(() => calls.push("session"));
    const openNewChatTab = vi.fn(() => calls.push("tab"));

    openNewChatFromSidebar({
      goToNewSession,
      navigateChatPanel,
      openNewChatTab,
      setChatPanelCreateTarget,
    });

    expect(navigateChatPanel).toHaveBeenCalledWith({
      kind: CHAT_PANEL_SURFACE_KIND.SESSION,
    });
    expect(setChatPanelCreateTarget).toHaveBeenCalledWith(
      CHAT_PANEL_CREATE_TARGET.AGENT_SESSION
    );
    expect(goToNewSession).toHaveBeenCalledOnce();
    expect(openNewChatTab).toHaveBeenCalledOnce();
    expect(calls).toEqual(["navigate", "target", "session", "tab"]);
  });
});
