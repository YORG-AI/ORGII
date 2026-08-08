import { getNotificationSoundTones } from "@src/config/notificationSounds";
import type { NotificationSoundPreset } from "@src/config/notificationSounds";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("NotificationSound");

export const MAX_ACTIVE_NOTIFICATION_SOUND_PLAYBACKS = 4;

export interface NotificationSoundPlaybackOptions {
  preset: NotificationSoundPreset;
  volume: number;
}

type AudioContextFactory = () => AudioContext;

interface NotificationSoundUnlockTarget {
  addEventListener(
    type: "pointerdown" | "keydown",
    listener: EventListener,
    useCapture?: boolean
  ): void;
  removeEventListener(
    type: "pointerdown" | "keydown",
    listener: EventListener,
    useCapture?: boolean
  ): void;
}

export interface NotificationSoundUnlockOptions {
  target?: NotificationSoundUnlockTarget | null;
  shouldUnlock?: () => boolean;
  unlock?: () => Promise<boolean>;
}

interface ActiveNotificationSoundPlayback {
  context: AudioContext;
  masterGain: GainNode;
  oscillators: OscillatorNode[];
  toneGains: GainNode[];
  remainingOscillators: number;
  cleaned: boolean;
}

function createBrowserAudioContext(): AudioContext {
  const AudioContextConstructor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error("Web Audio API is unavailable");
  }
  return new AudioContextConstructor();
}

export class NotificationSoundPlayer {
  private audioContext: AudioContext | null = null;
  private resumePromise: Promise<void> | null = null;
  private readonly activePlaybacks: ActiveNotificationSoundPlayback[] = [];
  private readonly maxActivePlaybacks: number;

  constructor(
    private readonly audioContextFactory: AudioContextFactory = createBrowserAudioContext,
    maxActivePlaybacks: number = MAX_ACTIVE_NOTIFICATION_SOUND_PLAYBACKS
  ) {
    this.maxActivePlaybacks = Math.max(1, Math.floor(maxActivePlaybacks));
  }

  async play({
    preset,
    volume,
  }: NotificationSoundPlaybackOptions): Promise<boolean> {
    const normalizedVolume = Math.max(0, Math.min(1, volume / 100));
    if (normalizedVolume === 0) return false;

    const context = await this.getRunningAudioContext();
    if (!context) return false;

    while (this.activePlaybacks.length >= this.maxActivePlaybacks) {
      const oldestPlayback = this.activePlaybacks[0];
      if (!oldestPlayback) break;
      this.stopPlayback(oldestPlayback);
    }

    const tones = getNotificationSoundTones(preset);
    const masterGain = context.createGain();
    const playback: ActiveNotificationSoundPlayback = {
      context,
      masterGain,
      oscillators: [],
      toneGains: [],
      remainingOscillators: tones.length,
      cleaned: false,
    };
    this.activePlaybacks.push(playback);

    try {
      const baseTime = context.currentTime;
      masterGain.gain.setValueAtTime(normalizedVolume, baseTime);
      masterGain.connect(context.destination);

      for (const tone of tones) {
        const oscillator = context.createOscillator();
        const toneGain = context.createGain();
        const startAt = baseTime + tone.startOffsetSeconds;
        const stopAt = startAt + tone.durationSeconds;
        const attackDuration = Math.min(
          tone.attackSeconds ?? 0.015,
          tone.durationSeconds / 2
        );

        playback.oscillators.push(oscillator);
        playback.toneGains.push(toneGain);

        oscillator.connect(toneGain);
        toneGain.connect(masterGain);
        oscillator.type = tone.waveform;
        oscillator.frequency.setValueAtTime(tone.frequency, startAt);
        if (tone.endFrequency) {
          oscillator.frequency.exponentialRampToValueAtTime(
            tone.endFrequency,
            stopAt
          );
        }

        toneGain.gain.setValueAtTime(0.0001, startAt);
        toneGain.gain.exponentialRampToValueAtTime(
          tone.level,
          startAt + Math.max(0.001, attackDuration)
        );
        toneGain.gain.exponentialRampToValueAtTime(0.0001, stopAt);

        oscillator.addEventListener(
          "ended",
          () => this.handleOscillatorEnded(playback, oscillator, toneGain),
          { once: true }
        );
        oscillator.start(startAt);
        oscillator.stop(stopAt + 0.01);
      }

      return true;
    } catch (error) {
      this.stopPlayback(playback);
      throw error;
    }
  }

  async unlock(): Promise<boolean> {
    return (await this.getRunningAudioContext()) !== null;
  }

  dispose(): void {
    for (const playback of [...this.activePlaybacks]) {
      this.stopPlayback(playback);
    }
    const context = this.audioContext;
    if (context && context.state !== "closed") {
      void context.close();
    }
    this.resumePromise = null;
    this.audioContext = null;
  }

  private async getRunningAudioContext(): Promise<AudioContext | null> {
    if (!this.audioContext || this.audioContext.state === "closed") {
      for (const playback of [...this.activePlaybacks]) {
        this.stopPlayback(playback);
      }
      this.audioContext = this.audioContextFactory();
      this.resumePromise = null;
    }

    const context = this.audioContext;
    if (context.state === "suspended") {
      if (!this.resumePromise) {
        this.resumePromise = context.resume().finally(() => {
          if (this.audioContext === context) {
            this.resumePromise = null;
          }
        });
      }
      await this.resumePromise;
    }

    return context.state === "running" ? context : null;
  }

  private handleOscillatorEnded(
    playback: ActiveNotificationSoundPlayback,
    oscillator: OscillatorNode,
    toneGain: GainNode
  ): void {
    if (playback.cleaned) return;
    this.safeDisconnect(oscillator);
    this.safeDisconnect(toneGain);
    playback.remainingOscillators -= 1;
    if (playback.remainingOscillators <= 0) {
      this.cleanupPlayback(playback);
    }
  }

  private stopPlayback(playback: ActiveNotificationSoundPlayback): void {
    if (playback.cleaned) return;
    for (const oscillator of playback.oscillators) {
      try {
        oscillator.stop(playback.context.currentTime);
      } catch {
        // The oscillator may already have ended; cleanup below is authoritative.
      }
    }
    this.cleanupPlayback(playback);
  }

  private cleanupPlayback(playback: ActiveNotificationSoundPlayback): void {
    if (playback.cleaned) return;
    playback.cleaned = true;
    for (const oscillator of playback.oscillators) {
      this.safeDisconnect(oscillator);
    }
    for (const toneGain of playback.toneGains) {
      this.safeDisconnect(toneGain);
    }
    this.safeDisconnect(playback.masterGain);

    const index = this.activePlaybacks.indexOf(playback);
    if (index >= 0) {
      this.activePlaybacks.splice(index, 1);
    }
  }

  private safeDisconnect(node: AudioNode): void {
    try {
      node.disconnect();
    } catch {
      // Disconnect is intentionally idempotent across end/eviction/error paths.
    }
  }
}

const notificationSoundPlayer = new NotificationSoundPlayer();

/**
 * Unlock Web Audio from a trusted user gesture so later background
 * notifications can reuse the running context without autoplay rejection.
 */
export function registerNotificationSoundUnlock({
  target,
  shouldUnlock = () => true,
  unlock = () => notificationSoundPlayer.unlock(),
}: NotificationSoundUnlockOptions = {}): () => void {
  const eventTarget =
    target === undefined
      ? typeof window === "undefined"
        ? null
        : window
      : target;
  if (!eventTarget) return () => undefined;

  let cleaned = false;
  let unlockInFlight = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    eventTarget.removeEventListener("pointerdown", handleUnlock, true);
    eventTarget.removeEventListener("keydown", handleUnlock, true);
  };
  const handleUnlock: EventListener = () => {
    if (cleaned || unlockInFlight || !shouldUnlock()) return;
    unlockInFlight = true;
    void unlock()
      .then((unlocked) => {
        if (unlocked) cleanup();
      })
      .catch(() => {
        // Keep the listeners armed so a later trusted gesture can retry.
      })
      .finally(() => {
        unlockInFlight = false;
      });
  };

  eventTarget.addEventListener("pointerdown", handleUnlock, true);
  eventTarget.addEventListener("keydown", handleUnlock, true);
  return cleanup;
}

export async function playNotificationSound(
  options: NotificationSoundPlaybackOptions
): Promise<boolean> {
  try {
    return await notificationSoundPlayer.play(options);
  } catch (error) {
    log.error("[NotificationSound] Playback failed:", error);
    return false;
  }
}

export async function unlockNotificationSound(): Promise<boolean> {
  try {
    return await notificationSoundPlayer.unlock();
  } catch (error) {
    log.error("[NotificationSound] Unlock failed:", error);
    return false;
  }
}
