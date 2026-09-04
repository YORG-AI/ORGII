import { describe, expect, it } from "vitest";

import { ACTION_ID } from "@src/ActionSystem";

import { buildChatPanelSettingsActions } from "../spotlightActionDefinitions.settings";

function buildPositionAction(position: "left" | "right") {
  return buildChatPanelSettingsActions({
    chatPanelPosition: position,
    chatTurnPaginationEnabled: false,
    modelPickerStyle: "spotlight",
    workstationSidebarPosition: "left",
  }).filter((action) => action.id.startsWith("set-chat-panel-"));
}

describe("chat panel Spotlight settings actions", () => {
  it("offers one shared move action when the panel is on the left", () => {
    expect(buildPositionAction("left")).toMatchObject([
      {
        id: "set-chat-panel-right",
        actionId: ACTION_ID.CHAT_PANEL_SET_RIGHT,
      },
    ]);
  });

  it("offers one shared move action when the panel is on the right", () => {
    expect(buildPositionAction("right")).toMatchObject([
      {
        id: "set-chat-panel-left",
        actionId: ACTION_ID.CHAT_PANEL_SET_LEFT,
      },
    ]);
  });
});
