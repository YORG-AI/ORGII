import {
  getSettingsDefaults,
  validateSettings,
} from "@src/config/settingsSchema";

describe("chat panel position setting", () => {
  it("has one canonical setting shared by both station layouts", () => {
    const defaults = getSettingsDefaults();

    expect(defaults["general.chatPanelPosition"]).toBe("left");
    expect(defaults).not.toHaveProperty("general.workStationChatPosition");
    expect(defaults).not.toHaveProperty("general.sessionChatPosition");
  });

  it("preserves an explicit canonical position", () => {
    expect(
      validateSettings({
        "general.chatPanelPosition": "right",
        "general.workStationChatPosition": "left",
        "general.sessionChatPosition": "left",
      })["general.chatPanelPosition"]
    ).toBe("right");
  });

  it("migrates My Station first when legacy positions disagree", () => {
    expect(
      validateSettings({
        "general.workStationChatPosition": "right",
        "general.sessionChatPosition": "left",
      })["general.chatPanelPosition"]
    ).toBe("right");
  });

  it("falls back to the legacy Agent Station position when needed", () => {
    expect(
      validateSettings({
        "general.workStationChatPosition": "invalid",
        "general.sessionChatPosition": "right",
      })["general.chatPanelPosition"]
    ).toBe("right");
  });
});
