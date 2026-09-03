import { describe, expect, it } from "vitest";

import { validateSettings } from "@src/config/settingsSchema";

describe("single user profile settings", () => {
  it("ignores retired profile-selection settings", () => {
    const settings = validateSettings({
      "general.activeProfileId": "another-profile",
      "general.profilePresets": [
        { id: "another-profile", description: "A second profile" },
      ],
    });

    expect(settings).not.toHaveProperty("general.activeProfileId");
    expect(settings).not.toHaveProperty("general.profilePresets");
  });
});
