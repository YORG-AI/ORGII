import { describe, expect, it } from "vitest";

import {
  CHAT_PANEL_CONTENT_MODE,
  CHAT_PANEL_CREATE_TARGET,
} from "@src/store/ui/chatPanelAtom";

import { resolveSelectedMenuItemIds } from "./menuSelection";

describe("resolveSelectedMenuItemIds", () => {
  it("selects Kanban from the active management tab", () => {
    expect(
      resolveSelectedMenuItemIds({
        activeSessionCreatorDraftId: null,
        activeSessionId: "session-1",
        activeSidebarKey: "workstation",
        activeChatPanelTabType: "work-management",
        chatPanelContentMode: CHAT_PANEL_CONTENT_MODE.SESSION,
        chatPanelCreateTarget: CHAT_PANEL_CREATE_TARGET.AGENT_SESSION,
        chatPanelSelectedProject: null,
        chatPanelSelectedWorkItem: null,
        projectsSelectedMenuItemId: "",
        sessionCreatorDrafts: [],
      }).selectedMenuItemId
    ).toBe("kanban");
  });

  it("selects Runtime from the active runtime tab", () => {
    expect(
      resolveSelectedMenuItemIds({
        activeSessionCreatorDraftId: null,
        activeSessionId: "session-1",
        activeSidebarKey: "workstation",
        activeChatPanelTabType: "runtime",
        chatPanelContentMode: CHAT_PANEL_CONTENT_MODE.SESSION,
        chatPanelCreateTarget: CHAT_PANEL_CREATE_TARGET.AGENT_SESSION,
        chatPanelSelectedProject: null,
        chatPanelSelectedWorkItem: null,
        projectsSelectedMenuItemId: "",
        sessionCreatorDrafts: [],
      }).selectedMenuItemId
    ).toBe("runtime");
  });

  it("selects Team Inbox from the active team inbox tab", () => {
    expect(
      resolveSelectedMenuItemIds({
        activeSessionCreatorDraftId: null,
        activeSessionId: "session-1",
        activeSidebarKey: "workstation",
        activeChatPanelTabType: "team-inbox",
        chatPanelContentMode: CHAT_PANEL_CONTENT_MODE.SESSION,
        chatPanelCreateTarget: CHAT_PANEL_CREATE_TARGET.AGENT_SESSION,
        chatPanelSelectedProject: null,
        chatPanelSelectedWorkItem: null,
        projectsSelectedMenuItemId: "",
        sessionCreatorDrafts: [],
      }).selectedMenuItemId
    ).toBe("team-inbox");
  });

  it("keeps Team Inbox selected from the Work Items sidebar", () => {
    expect(
      resolveSelectedMenuItemIds({
        activeSessionCreatorDraftId: null,
        activeSessionId: "session-1",
        activeSidebarKey: "projects",
        activeChatPanelTabType: "team-inbox",
        chatPanelContentMode: CHAT_PANEL_CONTENT_MODE.SESSION,
        chatPanelCreateTarget: CHAT_PANEL_CREATE_TARGET.AGENT_SESSION,
        chatPanelSelectedProject: null,
        chatPanelSelectedWorkItem: null,
        projectsSelectedMenuItemId: "project-1",
        sessionCreatorDrafts: [],
      }).selectedMenuItemId
    ).toBe("team-inbox");
  });
});
