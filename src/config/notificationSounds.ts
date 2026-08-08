export const NOTIFICATION_SOUND_PRESETS = [
  "classic",
  "gentle",
  "ascending",
  "bell",
] as const;

export type NotificationSoundPreset =
  (typeof NOTIFICATION_SOUND_PRESETS)[number];

export const DEFAULT_NOTIFICATION_SOUND_PRESET: NotificationSoundPreset =
  "classic";

export interface NotificationSoundTone {
  waveform: OscillatorType;
  frequency: number;
  endFrequency?: number;
  startOffsetSeconds: number;
  durationSeconds: number;
  level: number;
  attackSeconds?: number;
}

const NOTIFICATION_SOUND_PROFILES = {
  classic: [
    {
      waveform: "sine",
      frequency: 659.25,
      startOffsetSeconds: 0,
      durationSeconds: 0.24,
      level: 0.23,
    },
    {
      waveform: "sine",
      frequency: 987.77,
      startOffsetSeconds: 0.14,
      durationSeconds: 0.34,
      level: 0.2,
    },
  ],
  gentle: [
    {
      waveform: "sine",
      frequency: 523.25,
      startOffsetSeconds: 0,
      durationSeconds: 0.55,
      level: 0.13,
    },
    {
      waveform: "sine",
      frequency: 659.25,
      startOffsetSeconds: 0,
      durationSeconds: 0.58,
      level: 0.1,
    },
  ],
  ascending: [
    {
      waveform: "triangle",
      frequency: 523.25,
      startOffsetSeconds: 0,
      durationSeconds: 0.18,
      level: 0.16,
    },
    {
      waveform: "triangle",
      frequency: 659.25,
      startOffsetSeconds: 0.12,
      durationSeconds: 0.2,
      level: 0.17,
    },
    {
      waveform: "triangle",
      frequency: 783.99,
      startOffsetSeconds: 0.24,
      durationSeconds: 0.28,
      level: 0.18,
    },
  ],
  bell: [
    {
      waveform: "sine",
      frequency: 783.99,
      startOffsetSeconds: 0,
      durationSeconds: 0.68,
      level: 0.16,
      attackSeconds: 0.008,
    },
    {
      waveform: "sine",
      frequency: 1567.98,
      startOffsetSeconds: 0,
      durationSeconds: 0.54,
      level: 0.065,
      attackSeconds: 0.006,
    },
    {
      waveform: "sine",
      frequency: 2349.32,
      startOffsetSeconds: 0,
      durationSeconds: 0.38,
      level: 0.035,
      attackSeconds: 0.004,
    },
  ],
} as const satisfies Record<
  NotificationSoundPreset,
  readonly NotificationSoundTone[]
>;

export function isNotificationSoundPreset(
  value: unknown
): value is NotificationSoundPreset {
  return (
    typeof value === "string" &&
    (NOTIFICATION_SOUND_PRESETS as readonly string[]).includes(value)
  );
}

export function normalizeNotificationSoundPreset(
  value: unknown
): NotificationSoundPreset {
  return isNotificationSoundPreset(value)
    ? value
    : DEFAULT_NOTIFICATION_SOUND_PRESET;
}

export function getNotificationSoundTones(
  preset: NotificationSoundPreset
): readonly NotificationSoundTone[] {
  return (
    NOTIFICATION_SOUND_PROFILES[preset] ??
    NOTIFICATION_SOUND_PROFILES[DEFAULT_NOTIFICATION_SOUND_PRESET]
  );
}
