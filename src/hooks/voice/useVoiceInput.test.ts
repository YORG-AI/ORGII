// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSmokeRoot } from "@src/test/reactSmokeHarness";

import { type UseVoiceInputResult, useVoiceInput } from "./useVoiceInput";

vi.mock("./requestMicrophoneAccess", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./requestMicrophoneAccess")>();
  return {
    ...actual,
    queryMicrophonePermission: vi.fn().mockResolvedValue("prompt"),
  };
});

class MockSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = "en-US";
  maxAlternatives = 1;
  onresult: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;

  start = vi.fn(() => {
    this.onstart?.();
  });

  stop = vi.fn(() => {
    this.onend?.();
  });

  abort = vi.fn(() => {
    this.onend?.();
  });
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useVoiceInput microphone permission", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as Window & { webkitSpeechRecognition?: unknown })
      .webkitSpeechRecognition;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
  });

  it("requests microphone access on the user gesture before starting recognition", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop }],
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    (
      window as unknown as Window & {
        webkitSpeechRecognition: typeof MockSpeechRecognition;
      }
    ).webkitSpeechRecognition = MockSpeechRecognition;

    let voice: UseVoiceInputResult | undefined;
    const onCommit = vi.fn();
    const onError = vi.fn();
    const root = createSmokeRoot();

    function Probe() {
      const value = useVoiceInput({ onCommit, onError });
      React.useEffect(() => {
        voice = value;
      }, [value]);
      return null;
    }

    await root.render(React.createElement(Probe));
    act(() => {
      voice?.start();
    });
    await flushAsync();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(voice?.isRecording).toBe(true);
  });

  it("surfaces permission-denied when getUserMedia is rejected", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("denied"), { name: "NotAllowedError" })
      );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    (
      window as unknown as Window & {
        webkitSpeechRecognition: typeof MockSpeechRecognition;
      }
    ).webkitSpeechRecognition = MockSpeechRecognition;

    let voice: UseVoiceInputResult | undefined;
    const onError = vi.fn();
    const root = createSmokeRoot();

    function Probe() {
      const value = useVoiceInput({ onCommit: vi.fn(), onError });
      React.useEffect(() => {
        voice = value;
      }, [value]);
      return null;
    }

    await root.render(React.createElement(Probe));
    act(() => {
      voice?.start();
    });
    await flushAsync();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "permission-denied" })
    );
    expect(voice?.isRecording).toBe(false);
  });
});
