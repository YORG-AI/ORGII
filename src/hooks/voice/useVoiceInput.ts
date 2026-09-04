/**
 * useVoiceInput — push-to-talk dictation hook backed by the Web Speech API.
 *
 * Voice input: user clicks the mic (or hits ⌃M) to start, sees a
 * waveform UI while speaking, then stops to accept (transcription is committed
 * to the caller) or cancels to discard. The hook is composer-agnostic — it
 * yields plain transcript strings; wiring into a contenteditable / ComposerInput host
 * lives in the consumer.
 *
 * Transcription runs entirely in the Chromium webview via `webkitSpeechRecognition`
 * (no Tauri / backend dependency). Network access is still required because
 * Chromium streams audio to Google's recognition endpoint.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { createLogger } from "@src/hooks/logger";

import {
  type SpeechRecognitionErrorEvent,
  type SpeechRecognitionEvent,
  type SpeechRecognitionLike,
  getSpeechRecognitionCtor,
} from "./speechRecognitionTypes";

function isTauriProduction(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.origin.startsWith("tauri://");
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

const logger = createLogger("VoiceInput");

/**
 * Diagnostic probe: log what `webkitSpeechRecognition` actually resolves
 * to in this webview, exactly once per page load. Helps distinguish:
 *
 *  - undefined            — WKWebView doesn't ship the API (expected)
 *  - native `function`    — Apple shipped it; calling start() will hit
 *                           SFSpeechRecognizer / TCC
 *  - polyfill / proxy     — something else in the bundle injected it
 *
 * Read the "ctor probe" line in `~/.orgii/logs/frontend.log` after the
 * first mount.
 */
let probeLogged = false;
let devModeDialogOpen = false;

async function showVoiceInputDevModeDialog(): Promise<void> {
  if (devModeDialogOpen) return;
  devModeDialogOpen = true;
  try {
    const { message } = await import("@tauri-apps/plugin-dialog");
    await message(
      "Voice transcription is unavailable when running with npm run tauri:dev. This preview will show the recording UI, but dictation only works in the packaged desktop app.",
      {
        title: "Voice transcription unavailable",
        kind: "warning",
      }
    );
  } catch {
    window.alert(
      "Voice transcription is unavailable when running with npm run tauri:dev. This preview will show the recording UI, but dictation only works in the packaged desktop app."
    );
  } finally {
    devModeDialogOpen = false;
  }
}

function probeSpeechRecognitionOnce(): void {
  if (probeLogged) return;
  probeLogged = true;
  try {
    const ctor = getSpeechRecognitionCtor();
    if (!ctor) {
      logger.info("ctor probe: undefined (Web Speech API not present)");
      return;
    }
    const win = window as unknown as Record<string, unknown>;
    const source =
      typeof ctor === "function" ? Function.prototype.toString.call(ctor) : "";
    logger.info("ctor probe:", {
      hasStandard: typeof win.SpeechRecognition,
      hasWebkit: typeof win.webkitSpeechRecognition,
      name: (ctor as { name?: string }).name,
      isNative: source.includes("[native code]"),
      sourcePreview: source.slice(0, 120),
    });
  } catch (err) {
    logger.warn("ctor probe failed:", err);
  }
}

export type VoiceInputErrorCode =
  | "unsupported"
  | "permission-denied"
  | "no-speech"
  | "audio-capture"
  | "network"
  | "aborted"
  | "unknown";

export interface VoiceInputError {
  code: VoiceInputErrorCode;
  message: string;
}

export interface UseVoiceInputOptions {
  /** BCP-47 language tag (e.g. "en-US"); defaults to browser language. */
  lang?: string;
  /** Called when the user accepts the transcript (stop button). */
  onCommit: (transcript: string) => void;
  /** Called when the user cancels (X button) or recognition errors. */
  onCancel?: () => void;
  /** Called on any recognition error. */
  onError?: (error: VoiceInputError) => void;
}

export interface UseVoiceInputResult {
  /** True while microphone is capturing audio. */
  isRecording: boolean;
  /** True if the Web Speech API is available in this browser. */
  isSupported: boolean;
  /** Live partial transcript while speaking (resets when recording stops). */
  liveTranscript: string;
  /** Elapsed recording time in seconds. */
  elapsedSeconds: number;
  /** Begin a new recording session. No-op if already recording or unsupported. */
  start: () => void;
  /** Stop recording and commit the final transcript via `onCommit`. */
  stop: () => void;
  /** Stop recording and discard the transcript. */
  cancel: () => void;
  /** Toggle: start if idle, stop (commit) if recording. */
  toggle: () => void;
}

function mapErrorCode(raw: string): VoiceInputErrorCode {
  switch (raw) {
    case "not-allowed":
    case "service-not-allowed":
      return "permission-denied";
    case "no-speech":
      return "no-speech";
    case "audio-capture":
      return "audio-capture";
    case "network":
      return "network";
    case "aborted":
      return "aborted";
    default:
      return "unknown";
  }
}

export function useVoiceInput(
  options: UseVoiceInputOptions
): UseVoiceInputResult {
  const { lang, onCommit, onCancel, onError } = options;

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef<string>("");
  // When cancel() is called we still receive an `onend` event from the
  // recognizer; this flag tells the end handler whether to commit or discard.
  const shouldCommitRef = useRef<boolean>(true);
  const startTimeRef = useRef<number>(0);
  const tickIntervalRef = useRef<number | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const [isSupported] = useState<boolean>(() => {
    probeSpeechRecognitionOnce();
    // Tauri dev shows a preview UI even without a native recognizer.
    if (isTauriRuntime() && !isTauriProduction()) {
      return true;
    }
    return getSpeechRecognitionCtor() != null;
  });

  const clearTimer = useCallback(() => {
    if (tickIntervalRef.current != null) {
      window.clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    }
  }, []);

  const teardown = useCallback(() => {
    clearTimer();
    setIsRecording(false);
    setElapsedSeconds(0);
    setLiveTranscript("");
    transcriptRef.current = "";
    if (recognitionRef.current) {
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      recognitionRef.current.onend = null;
      recognitionRef.current.onstart = null;
      recognitionRef.current = null;
    }
  }, [clearTimer]);

  const start = useCallback(() => {
    if (isRecording) return;

    if (isTauriRuntime() && !isTauriProduction()) {
      startTimeRef.current = Date.now();
      setIsRecording(true);
      setElapsedSeconds(0);
      tickIntervalRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setElapsedSeconds(elapsed);
      }, 250);
      void showVoiceInputDevModeDialog();
      return;
    }

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      const err: VoiceInputError = {
        code: "unsupported",
        message: "Speech recognition is not available in this environment.",
      };
      logger.warn(err.message);
      onError?.(err);
      return;
    }

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    const detectedLang =
      typeof navigator !== "undefined" ? navigator.language : undefined;
    recognition.lang = lang ?? detectedLang ?? "en-US";

    transcriptRef.current = "";
    shouldCommitRef.current = true;
    setLiveTranscript("");

    recognition.onstart = () => {
      startTimeRef.current = Date.now();
      setIsRecording(true);
      setElapsedSeconds(0);
      tickIntervalRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setElapsedSeconds(elapsed);
      }, 250);
      logger.debug("recognition started", { lang: recognition.lang });
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalText = transcriptRef.current;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const alt = result[0];
        if (!alt) continue;
        if (result.isFinal) {
          finalText += alt.transcript;
        } else {
          interim += alt.transcript;
        }
      }
      transcriptRef.current = finalText;
      setLiveTranscript((finalText + interim).trim());
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      const code = mapErrorCode(event.error);
      logger.warn("recognition error", event.error, event.message);
      shouldCommitRef.current = false;
      onError?.({ code, message: event.message || event.error });
    };

    recognition.onend = () => {
      const final = transcriptRef.current.trim();
      const commit = shouldCommitRef.current;
      logger.debug("recognition ended", { commit, length: final.length });
      teardown();
      if (commit && final.length > 0) {
        onCommit(final);
      } else if (!commit) {
        onCancel?.();
      }
    };

    recognitionRef.current = recognition;
    // Diagnostic breadcrumb written BEFORE the native call so it persists
    // to ~/.orgii/logs/frontend.log even if start() SIGABRTs the process.
    // If you see "about to call start()" with no following "started" or
    // error line, the kill came from outside the JS layer (TCC, signal,
    // process crash). Pair with `~/Library/Logs/DiagnosticReports/` to
    // identify the framework.
    logger.warn("about to call recognition.start()", {
      lang: recognition.lang,
      continuous: recognition.continuous,
      interimResults: recognition.interimResults,
    });
    try {
      recognition.start();
      logger.warn("recognition.start() returned synchronously");
    } catch (err) {
      const name =
        err && typeof err === "object" && "name" in err
          ? String((err as { name: unknown }).name)
          : "";
      const message = err instanceof Error ? err.message : String(err);
      logger.error("failed to start recognition", { name, message, err });
      onError?.({
        code: "unknown",
        message,
      });
      teardown();
    }
  }, [isRecording, lang, onCancel, onCommit, onError, teardown]);

  const stop = useCallback(() => {
    if (!recognitionRef.current) {
      if (isRecording) teardown();
      return;
    }
    shouldCommitRef.current = true;
    try {
      recognitionRef.current.stop();
    } catch (err) {
      logger.warn("stop failed", err);
      teardown();
    }
  }, [isRecording, teardown]);

  const cancel = useCallback(() => {
    if (!recognitionRef.current) {
      if (isRecording) {
        teardown();
        onCancel?.();
      }
      return;
    }
    shouldCommitRef.current = false;
    try {
      recognitionRef.current.abort();
    } catch (err) {
      logger.warn("abort failed", err);
      teardown();
      onCancel?.();
    }
  }, [isRecording, onCancel, teardown]);

  const toggle = useCallback(() => {
    if (isRecording) {
      stop();
    } else {
      start();
    }
  }, [isRecording, start, stop]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        shouldCommitRef.current = false;
        try {
          recognitionRef.current.abort();
        } catch {
          // recognizer may already be torn down
        }
      }
      clearTimer();
    };
  }, [clearTimer]);

  return {
    isRecording,
    isSupported,
    liveTranscript,
    elapsedSeconds,
    start,
    stop,
    cancel,
    toggle,
  };
}
