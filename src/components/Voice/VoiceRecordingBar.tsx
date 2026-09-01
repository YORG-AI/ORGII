/**
 * VoiceRecordingBar — the in-composer dictation UI that takes over the toolbar
 * row while the microphone is capturing audio.
 *
 * Layout (matches the Cursor reference):
 *   [+ button]  · · · · · · · · · · ‖|‖|‖|‖|‖  0:01  ✕  ✓
 *               ^---- dotted baseline ---^^^^ live waveform
 *
 * Audio level visualization is decorative — we don't tap the raw audio stream
 * from `MediaRecorder`. The bars cycle through deterministic-pseudo-random
 * heights with a staggered CSS animation, which is exactly what the reference
 * UI does and avoids the cost of an AudioContext just for cosmetics.
 */
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { INPUT_AREA_BUTTONS } from "@src/config/inputAreaTokens";
import { Add01Icon, Cancel01Icon, HugeiconsIcon, Tick01Icon } from "@src/icons";

import "./VoiceRecordingBar.scss";

interface VoiceRecordingBarProps {
  elapsedSeconds: number;
  onCancel: () => void;
  onAccept: () => void;
  /** Optional + click handler so the row keeps feature parity with the idle toolbar. */
  onAddContent?: () => void;
}

function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

const WAVEFORM_BAR_COUNT = 22;
// Stable per-bar height/delay seeds so the animation looks "live" without
// re-randomising on every render and triggering layout thrash.
const WAVEFORM_SEEDS: Array<{ peak: number; delay: number }> = Array.from(
  { length: WAVEFORM_BAR_COUNT },
  (_, i) => {
    const t = (i + 1) / WAVEFORM_BAR_COUNT;
    const peak = 0.35 + Math.sin(i * 1.7) * 0.25 + t * 0.4;
    return {
      peak: Math.max(0.2, Math.min(1, peak)),
      delay: (i % 6) * 80,
    };
  }
);

const VoiceRecordingBar: React.FC<VoiceRecordingBarProps> = memo(
  ({ elapsedSeconds, onCancel, onAccept, onAddContent }) => {
    const { t } = useTranslation();

    const bars = useMemo(
      () =>
        WAVEFORM_SEEDS.map((seed, idx) => (
          <span
            key={idx}
            className="composer-voice-waveform__bar"
            style={
              {
                "--peak": seed.peak,
                animationDelay: `${seed.delay}ms`,
              } as React.CSSProperties
            }
          />
        )),
      []
    );

    return (
      <div
        className="flex h-9 min-h-9 w-full items-center gap-1 px-1 text-text-2"
        data-testid="composer-voice-recording-bar"
        role="region"
        aria-label={t("common:tooltips.startVoiceInput")}
      >
        <button
          type="button"
          onClick={onAddContent}
          disabled={!onAddContent}
          className={[
            "flex items-center justify-center rounded-full bg-fill-1 text-text-1 transition-colors duration-200 hover:bg-fill-2 focus:outline-none",
            INPUT_AREA_BUTTONS.iconButtonSizeClass,
            onAddContent ? "cursor-pointer" : "cursor-default opacity-60",
            "leading-none",
          ].join(" ")}
          style={{ lineHeight: 0 }}
          aria-hidden={!onAddContent}
          aria-label={t("common:actions.add")}
          tabIndex={onAddContent ? 0 : -1}
        >
          <HugeiconsIcon
            icon={Add01Icon}
            data-icon="plus"
            size={INPUT_AREA_BUTTONS.iconSize}
            strokeWidth={1.75}
          />
        </button>

        <div className="composer-voice-waveform">
          <div className="composer-voice-waveform__baseline" aria-hidden />
          <div className="composer-voice-waveform__bars" aria-hidden>
            {bars}
          </div>
        </div>

        <span
          className="font-variant-numeric-tabular min-w-10 shrink-0 text-right text-[12px] text-text-2"
          data-testid="composer-voice-elapsed"
        >
          {formatElapsed(elapsedSeconds)}
        </span>

        <button
          type="button"
          onClick={onCancel}
          className={`${INPUT_AREA_BUTTONS.iconButtonBase} cursor-pointer leading-none`}
          style={{ lineHeight: 0 }}
          data-testid="composer-voice-cancel"
          aria-label={t("common:tooltips.cancelRecording")}
        >
          <HugeiconsIcon
            icon={Cancel01Icon}
            data-icon="x"
            size={INPUT_AREA_BUTTONS.iconSize}
            strokeWidth={1.75}
          />
        </button>

        <button
          type="button"
          onClick={onAccept}
          className={`${INPUT_AREA_BUTTONS.iconButtonBase} cursor-pointer bg-fill-3 leading-none`}
          style={{ lineHeight: 0 }}
          data-testid="composer-voice-accept"
          aria-label={t("common:tooltips.stopAndTranscribe")}
        >
          <HugeiconsIcon
            icon={Tick01Icon}
            data-icon="check"
            size={INPUT_AREA_BUTTONS.iconSize}
            strokeWidth={1.75}
          />
        </button>
      </div>
    );
  }
);

VoiceRecordingBar.displayName = "VoiceRecordingBar";

export default VoiceRecordingBar;
