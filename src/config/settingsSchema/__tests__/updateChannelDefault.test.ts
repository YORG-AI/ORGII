import {
  getSettingsDefaults,
  validateSettings,
} from "@src/config/settingsSchema";

describe("update channel setting", () => {
  it("defaults to auto and preserves an explicit channel", () => {
    expect(getSettingsDefaults()["general.updateChannel"]).toBe("auto");
    expect(validateSettings({})["general.updateChannel"]).toBe("auto");
    expect(
      validateSettings({ "general.updateChannel": "beta" })[
        "general.updateChannel"
      ]
    ).toBe("beta");
    expect(
      validateSettings({ "general.updateChannel": "stable" })[
        "general.updateChannel"
      ]
    ).toBe("stable");
  });

  it("replaces unknown channel values with the default", () => {
    expect(
      validateSettings({ "general.updateChannel": "nightly" })[
        "general.updateChannel"
      ]
    ).toBe("auto");
  });
});
