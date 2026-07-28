import { describe, expect, it } from "vitest";

import { COLLAB_ADD_ORG_MENU_ITEM_ID } from "@src/scaffold/NavigationSidebar/connectors/sidebarConnectorUtils";
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

  it("selects Add Org by default on the projects sidebar for the collab org create target", () => {
    expect(
      resolveSelectedMenuItemIds({
        activeSessionCreatorDraftId: null,
        activeSessionId: "session-1",
        activeSidebarKey: "projects",
        activeChatPanelTabType: null,
        chatPanelContentMode: CHAT_PANEL_CONTENT_MODE.NON_SESSION,
        chatPanelCreateTarget: CHAT_PANEL_CREATE_TARGET.COLLAB_ORG,
        chatPanelSelectedProject: null,
        chatPanelSelectedWorkItem: null,
        projectsSelectedMenuItemId: "",
        sessionCreatorDrafts: [],
      }).selectedMenuItemId
    ).toBe(COLLAB_ADD_ORG_MENU_ITEM_ID);
  });
});
