import {
  getSettingsDefaults,
  validateSettings,
} from "@src/config/settingsSchema";

describe("automatic update policy", () => {
  it("does not expose or honor the retired automatic-update opt-out", () => {
    expect(getSettingsDefaults()).not.toHaveProperty(
      "general.autoUpdateEnabled"
    );
    expect(
      validateSettings({ "general.autoUpdateEnabled": false })
    ).not.toHaveProperty("general.autoUpdateEnabled");
  });
});
