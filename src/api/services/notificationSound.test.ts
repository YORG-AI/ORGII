import { describe, expect, it, vi } from "vitest";

import {
  NotificationSoundPlayer,
  registerNotificationSoundUnlock,
} from "./notificationSound";

class FakeAudioParam {
  readonly events: Array<{ kind: string; value: number; at: number }> = [];

  setValueAtTime(value: number, at: number): this {
    this.events.push({ kind: "set", value, at });
    return this;
  }

  exponentialRampToValueAtTime(value: number, at: number): this {
    this.events.push({ kind: "exponential", value, at });
    return this;
  }
}

class FakeAudioNode {
  disconnectCalls = 0;

  connect(): this {
    return this;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}

class FakeOscillatorNode extends FakeAudioNode {
  readonly frequency = new FakeAudioParam();
  type: OscillatorType = "sine";
  readonly starts: number[] = [];
  readonly stops: number[] = [];
  private endedListener: (() => void) | null = null;

  addEventListener(type: string, listener: () => void): void {
    if (type === "ended") this.endedListener = listener;
  }

  start(at: number): void {
    this.starts.push(at);
  }

  stop(at: number): void {
    this.stops.push(at);
  }

  emitEnded(): void {
    this.endedListener?.();
  }
}

class FakeAudioContext {
  state: AudioContextState;
  currentTime = 10;
  resumeCalls = 0;
  closeCalls = 0;
  resumeError: Error | null = null;
  stateAfterResume: AudioContextState = "running";
  readonly destination = new FakeAudioNode();
  readonly oscillators: FakeOscillatorNode[] = [];
  readonly gains: FakeGainNode[] = [];

  constructor(state: AudioContextState = "running") {
    this.state = state;
  }

  createOscillator(): OscillatorNode {
    const oscillator = new FakeOscillatorNode();
    this.oscillators.push(oscillator);
    return oscillator as unknown as OscillatorNode;
  }

  createGain(): GainNode {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    await Promise.resolve();
    if (this.resumeError) throw this.resumeError;
    this.state = this.stateAfterResume;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = "closed";
  }
}

class FakeUnlockTarget {
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: "pointerdown" | "keydown"): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type } as Event);
    }
  }

  listenerCount(type: "pointerdown" | "keydown"): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("NotificationSoundPlayer", () => {
  it("single-flights AudioContext resume across concurrent playback", async () => {
    const context = new FakeAudioContext("suspended");
    const player = new NotificationSoundPlayer(
      () => context as unknown as AudioContext
    );

    await Promise.all([
      player.play({ preset: "classic", volume: 70 }),
      player.play({ preset: "gentle", volume: 70 }),
    ]);

    expect(context.resumeCalls).toBe(1);
    expect(context.oscillators).toHaveLength(4);
  });

  it("reports rejected or still-suspended unlock attempts", async () => {
    const context = new FakeAudioContext("suspended");
    const player = new NotificationSoundPlayer(
      () => context as unknown as AudioContext
    );

    context.stateAfterResume = "suspended";
    await expect(player.unlock()).resolves.toBe(false);

    context.resumeError = new Error("autoplay denied");
    await expect(player.unlock()).rejects.toThrow("autoplay denied");
  });

  it("schedules the selected profile and cleans it after every tone ends", async () => {
    const context = new FakeAudioContext();
    const player = new NotificationSoundPlayer(
      () => context as unknown as AudioContext
    );

    await expect(player.play({ preset: "bell", volume: 50 })).resolves.toBe(
      true
    );
    expect(context.oscillators).toHaveLength(3);
    expect(context.oscillators.map((oscillator) => oscillator.type)).toEqual([
      "sine",
      "sine",
      "sine",
    ]);
    expect(context.gains[0]?.gain.events[0]).toEqual({
      kind: "set",
      value: 0.5,
      at: 10,
    });

    for (const oscillator of context.oscillators) {
      oscillator.emitEnded();
    }

    expect(context.gains.every((gain) => gain.disconnectCalls > 0)).toBe(true);
  });

  it("evicts the oldest playback when the active bound is reached", async () => {
    const context = new FakeAudioContext();
    const player = new NotificationSoundPlayer(
      () => context as unknown as AudioContext,
      1
    );

    await player.play({ preset: "classic", volume: 70 });
    const firstPlaybackOscillators = [...context.oscillators];
    await player.play({ preset: "ascending", volume: 70 });

    expect(
      firstPlaybackOscillators.every(
        (oscillator) => oscillator.stops.length === 2
      )
    ).toBe(true);
    expect(
      firstPlaybackOscillators.every(
        (oscillator) => oscillator.disconnectCalls > 0
      )
    ).toBe(true);
  });

  it("does not create audio nodes when volume is zero", async () => {
    const context = new FakeAudioContext();
    const player = new NotificationSoundPlayer(
      () => context as unknown as AudioContext
    );

    await expect(player.play({ preset: "ascending", volume: 0 })).resolves.toBe(
      false
    );
    expect(context.oscillators).toHaveLength(0);
  });
});

describe("registerNotificationSoundUnlock", () => {
  it("waits until sound is enabled and retries after autoplay rejection", async () => {
    const target = new FakeUnlockTarget();
    let soundEnabled = false;
    const unlock = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("autoplay denied"))
      .mockResolvedValue(true);
    const unregister = registerNotificationSoundUnlock({
      target,
      shouldUnlock: () => soundEnabled,
      unlock,
    });

    target.emit("pointerdown");
    await flushPromises();
    expect(unlock).not.toHaveBeenCalled();

    soundEnabled = true;
    target.emit("pointerdown");
    await flushPromises();
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(target.listenerCount("pointerdown")).toBe(1);

    target.emit("keydown");
    await flushPromises();
    expect(unlock).toHaveBeenCalledTimes(2);
    expect(target.listenerCount("pointerdown")).toBe(0);
    expect(target.listenerCount("keydown")).toBe(0);

    unregister();
  });
});
