import { describe, expect, it } from "vitest";

import { DEFAULT_NOTIFICATION_SOUND_PRESET } from "@src/config/notificationSounds";
import {
  generateJsoncContent,
  getSettingsDefaults,
  validateSettings,
} from "@src/config/settingsSchema";

describe("notification settings schema", () => {
  it("provides the default customizable quiet-hours policy", () => {
    const defaults = getSettingsDefaults();
    expect(defaults["notifications.quietHours.enabled"]).toBe(false);
    expect(defaults["notifications.quietHours.start"]).toBe("23:00");
    expect(defaults["notifications.quietHours.end"]).toBe("08:00");
    expect(defaults["notifications.quietHours.allowCritical"]).toBe(true);
    expect(defaults["notifications.backgroundCompletionSummary"]).toBe(true);
    expect(defaults["notifications.soundPreset"]).toBe(
      DEFAULT_NOTIFICATION_SOUND_PRESET
    );
  });

  it("rejects invalid times and sound presets", () => {
    const settings = validateSettings({
      "notifications.quietHours.start": "25:90",
      "notifications.quietHours.end": "07:30",
      "notifications.soundPreset": "digital",
    });

    expect(settings["notifications.quietHours.start"]).toBe("23:00");
    expect(settings["notifications.quietHours.end"]).toBe("07:30");
    expect(settings["notifications.soundPreset"]).toBe(
      DEFAULT_NOTIFICATION_SOUND_PRESET
    );
  });

  it("does not load or regenerate the removed conversation-mute setting", () => {
    const settings = validateSettings({
      "notifications.mutedSessionIds": ["session-a"],
      "notifications.enabled": false,
    });
    expect(settings).not.toHaveProperty("notifications.mutedSessionIds");
    expect(getSettingsDefaults()).not.toHaveProperty(
      "notifications.mutedSessionIds"
    );
    expect(settings["notifications.enabled"]).toBe(false);
    expect(generateJsoncContent(settings)).not.toContain("mutedSessionIds");
  });

  it("accepts a supported notification sound preset", () => {
    const settings = validateSettings({
      "notifications.soundPreset": "bell",
    });

    expect(settings["notifications.soundPreset"]).toBe("bell");
  });
});
