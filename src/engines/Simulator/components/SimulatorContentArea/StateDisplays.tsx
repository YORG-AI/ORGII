/**
 * StateDisplays Component
 *
 * Extracted state display components for the simulator:
 * - IdleState: Shows when no event is active (Gemini style)
 * - BootingState: Shows during initial system loading (Gemini style)
 */
import { Loader2, Power } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";

import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { CODEMIRROR_STYLE_NONCE } from "@src/features/CodeMirror/config/nonce";

/** Idle state display - shown when no event is active (Gemini style) */
export const IdleState = memo(() => {
  const { t } = useTranslation("sessions");
  const waveColors = [
    "border-primary-1", // Inner wave - lightest
    "border-primary-2", // Middle wave
    "border-primary-3", // Outer wave - subtlest
  ];

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 p-8">
      <div className="relative">
        {/* Pulse animation rings */}
        <div className="absolute inset-0 flex items-center justify-center">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className={`absolute h-20 w-20 animate-ping rounded-full border ${waveColors[index]}`}
              style={{
                animationDelay: `${index * 0.5}s`,
                animationDuration: "2.5s",
              }}
            />
          ))}
        </div>
        {/* Center icon */}
        <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-6/20 to-primary-5/20 shadow-lg shadow-primary-6/10">
          <Power size={36} className="text-primary-6" />
        </div>
      </div>
      <div className="text-center">
        <p className="text-[15px] font-semibold text-text-1">
          {t("simulator.idle.title")}
        </p>
        <p className="mt-1 text-[13px] text-text-3">
          {t("simulator.idle.subtitle")}
        </p>
      </div>
    </div>
  );
});
IdleState.displayName = "IdleState";

/** Booting state display - shown during initial system loading (Gemini style) */
export const BootingState = memo(() => {
  const { t } = useTranslation("sessions");
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-8">
      {/* Animated background overlay - fades from dark to transparent */}
      <div
        className="absolute inset-0 z-0"
        style={{
          animation: "bootBgFade 3s ease-out forwards",
        }}
      />

      {/* Icon */}
      <div
        className="relative z-10"
        style={{
          animation: "bootContentFadeIn 1.5s ease-out 0.3s both",
        }}
      >
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-success-6/20 to-primary-6/20 shadow-lg shadow-success-6/10">
          <Loader2 className="animate-spin" size={SPINNER_TOKENS.default} />
        </div>
      </div>

      {/* Content */}
      <div
        className="relative z-10 text-center"
        style={{
          animation: "bootContentFadeIn 1.5s ease-out 0.5s both",
        }}
      >
        <p className="text-[17px] font-semibold text-text-1">
          {t("simulator.booting.title")}
        </p>
        <p className="mt-2 text-[13px] text-text-3">
          {t("simulator.booting.subtitle")}
        </p>
      </div>

      {/* Progress bar container */}
      <div
        className="relative z-10 w-72"
        style={{
          animation: "bootContentFadeIn 1.5s ease-out 1s both",
        }}
      >
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-fill-2">
          {/* Animated progress bar - linear loading */}
          <div
            className="h-full rounded-full bg-gradient-to-r from-success-6 to-primary-6"
            style={{
              animation: "bootProgress 2s linear infinite",
            }}
          />
        </div>
      </div>

      {/* Inline keyframes for animations (always enabled) */}
      <style nonce={CODEMIRROR_STYLE_NONCE}>
        {`
        @keyframes bootProgress {
          0% { width: 0%; }
          100% { width: 100%; }
        }
        @keyframes bootBgFade {
          0% { background-color: var(--color-bg-1); }
          100% { background-color: transparent; }
        }
        @keyframes bootContentFadeIn {
          0% { opacity: 0; transform: translateY(10px); }
          100% { opacity: 1; transform: translateY(0); }
        }
      `}
      </style>
    </div>
  );
});
BootingState.displayName = "BootingState";
