import { describe, expect, it } from "vitest";

import { buildUserProfileWire } from "./AdeContextCollector";

describe("buildUserProfileWire", () => {
  it("uses the one persisted user profile", () => {
    const profile = buildUserProfileWire({
      "general.profileTechSavvy": "expert",
      "general.profileJobRoles": ["Data Scientist"],
      "general.profileFamiliarTechStacks": ["Python", "SQL"],
      "general.profileDescription": "Prefers statistical detail.",
    });

    expect(profile).toEqual({
      techSavvy: "expert",
      jobRoles: ["Data Scientist"],
      familiarTechStacks: ["Python", "SQL"],
      description: "Prefers statistical detail.",
    });
  });

  it("ignores retired profile presets", () => {
    const profile = buildUserProfileWire({
      "general.profileTechSavvy": "beginner",
      "general.activeProfileId": "another-profile",
      "general.profilePresets": [
        {
          id: "another-profile",
          techSavvy: "expert",
          jobRoles: ["Data Scientist"],
          familiarTechStacks: ["Python"],
          description: "This must not replace the canonical profile.",
        },
      ],
    });

    expect(profile).toEqual({ techSavvy: "beginner" });
  });
});
