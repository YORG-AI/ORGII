import { describe, expect, it } from "vitest";

import { DEFAULT_NOTIFICATION_SOUND_PRESET } from "@src/config/notificationSounds";
import {
  getSettingsDefaults,
  validateSettings,
} from "@src/config/settingsSchema";
import { MAX_MUTED_NOTIFICATION_SESSION_IDS } from "@src/config/settingsSchema/registry/notifications";

describe("notification settings schema", () => {
  it("provides the default customizable quiet-hours policy", () => {
    const defaults = getSettingsDefaults();
    expect(defaults["notifications.quietHours.enabled"]).toBe(false);
    expect(defaults["notifications.quietHours.start"]).toBe("23:00");
    expect(defaults["notifications.quietHours.end"]).toBe("08:00");
    expect(defaults["notifications.quietHours.allowCritical"]).toBe(true);
    expect(defaults["notifications.backgroundCompletionSummary"]).toBe(true);
    expect(defaults["notifications.mutedSessionIds"]).toEqual([]);
    expect(defaults["notifications.soundPreset"]).toBe(
      DEFAULT_NOTIFICATION_SOUND_PRESET
    );
  });

  it("rejects invalid times and an unbounded muted-session list", () => {
    const mutedSessionIds = Array.from(
      { length: MAX_MUTED_NOTIFICATION_SESSION_IDS + 1 },
      (_, index) => `session-${index}`
    );
    const settings = validateSettings({
      "notifications.quietHours.start": "25:90",
      "notifications.quietHours.end": "07:30",
      "notifications.soundPreset": "digital",
      "notifications.mutedSessionIds": mutedSessionIds,
    });

    expect(settings["notifications.quietHours.start"]).toBe("23:00");
    expect(settings["notifications.quietHours.end"]).toBe("07:30");
    expect(settings["notifications.soundPreset"]).toBe(
      DEFAULT_NOTIFICATION_SOUND_PRESET
    );
    expect(settings["notifications.mutedSessionIds"]).toEqual([]);
  });

  it("accepts a supported notification sound preset", () => {
    const settings = validateSettings({
      "notifications.soundPreset": "bell",
    });

    expect(settings["notifications.soundPreset"]).toBe("bell");
  });
});
