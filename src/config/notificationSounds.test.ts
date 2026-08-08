import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATION_SOUND_PRESET,
  NOTIFICATION_SOUND_PRESETS,
  getNotificationSoundTones,
  normalizeNotificationSoundPreset,
} from "./notificationSounds";

describe("notification sound presets", () => {
  it("provides a distinct, bounded profile for every preset", () => {
    const signatures = new Set<string>();

    for (const preset of NOTIFICATION_SOUND_PRESETS) {
      const tones = getNotificationSoundTones(preset);
      expect(tones.length).toBeGreaterThan(0);
      expect(tones.length).toBeLessThanOrEqual(3);

      for (const tone of tones) {
        expect(tone.frequency).toBeGreaterThanOrEqual(200);
        expect(tone.frequency).toBeLessThanOrEqual(3_000);
        expect(tone.startOffsetSeconds).toBeGreaterThanOrEqual(0);
        expect(tone.durationSeconds).toBeGreaterThan(0);
        expect(
          tone.startOffsetSeconds + tone.durationSeconds
        ).toBeLessThanOrEqual(0.75);
        expect(tone.level).toBeGreaterThan(0);
        expect(tone.level).toBeLessThanOrEqual(0.25);
      }

      signatures.add(JSON.stringify(tones));
    }

    expect(signatures.size).toBe(NOTIFICATION_SOUND_PRESETS.length);
  });

  it("falls back to the classic preset for invalid persisted values", () => {
    expect(DEFAULT_NOTIFICATION_SOUND_PRESET).toBe("classic");
    expect(normalizeNotificationSoundPreset("bell")).toBe("bell");
    expect(normalizeNotificationSoundPreset("digital")).toBe("classic");
    expect(normalizeNotificationSoundPreset("unknown")).toBe("classic");
    expect(normalizeNotificationSoundPreset(null)).toBe("classic");
  });
});
