import {
  getSettingsDefaults,
  validateSettings,
} from "@src/config/settingsSchema";

describe("automatic update setting", () => {
  it("defaults to enabled and preserves an explicit opt-out", () => {
    expect(getSettingsDefaults()["general.autoUpdateEnabled"]).toBe(true);
    expect(validateSettings({})["general.autoUpdateEnabled"]).toBe(true);
    expect(
      validateSettings({ "general.autoUpdateEnabled": false })[
        "general.autoUpdateEnabled"
      ]
    ).toBe(false);
  });
});
