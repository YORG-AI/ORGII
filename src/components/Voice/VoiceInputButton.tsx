/**
 * VoiceInputButton — microphone toggle that sits to the left of the Send
 * button in the composer toolbar.
 *
 * Idle: subtle round icon button matching the other toolbar controls
 * (matches the + button visual weight). Clicking starts dictation; the
 * recording UI is owned by `VoiceRecordingBar` which replaces the entire
 * toolbar row while capture is active.
 */
import React, { memo, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

import { PILL_CONTROL_HOVER_CLASS } from "@src/components/CompoundPill/config";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { INPUT_AREA_BUTTONS } from "@src/config/inputAreaTokens";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { HugeiconsIcon, Mic01Icon } from "@src/icons";

interface VoiceInputButtonProps {
  onPressStart: () => void;
  onPressEnd: () => void;
  /**
   * If false the control still renders, but pressing it is a no-op and the
   * tooltip explains the unavailable recognizer state.
   */
  disabled?: boolean;
  /** Filled treatment for compact contextual composers. */
  appearance?: "default" | "solid";
}

const VoiceInputButton: React.FC<VoiceInputButtonProps> = memo(
  ({ onPressStart, onPressEnd, disabled = false, appearance = "default" }) => {
    const { t } = useTranslation();
    const activePointerIdRef = useRef<number | null>(null);
    const isPressingRef = useRef(false);

    const startPress = useCallback(() => {
      if (disabled || isPressingRef.current) return;
      isPressingRef.current = true;
      onPressStart();
    }, [disabled, onPressStart]);

    const endPress = useCallback(() => {
      if (!isPressingRef.current) return;
      isPressingRef.current = false;
      activePointerIdRef.current = null;
      onPressEnd();
    }, [onPressEnd]);

    const handlePointerDown = useCallback(
      (event: React.PointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        activePointerIdRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        startPress();
      },
      [startPress]
    );

    const handlePointerUp = useCallback(
      (event: React.PointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        if (activePointerIdRef.current === event.pointerId) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        endPress();
      },
      [endPress]
    );

    const handlePointerCancel = useCallback(
      (event: React.PointerEvent<HTMLButtonElement>) => {
        if (activePointerIdRef.current === event.pointerId) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        endPress();
      },
      [endPress]
    );

    const buttonNode = (
      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={handlePointerCancel}
        onKeyDown={(event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            startPress();
          }
        }}
        onKeyUp={(event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            endPress();
          }
        }}
        className={[
          "flex items-center justify-center rounded-full transition-colors duration-200 focus:outline-none",
          INPUT_AREA_BUTTONS.iconButtonSizeClass,
          appearance === "solid"
            ? "bg-text-1 text-bg-1 hover:bg-text-2"
            : disabled
              ? // Disabled buttons must not paint the interactive idle/hover
                // surface — restore the plain transparent treatment.
                "text-text-1"
              : `text-text-1 ${PILL_CONTROL_HOVER_CLASS}`,
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
          "leading-none",
        ].join(" ")}
        style={{ lineHeight: 0 }}
        data-testid="composer-voice-input-button"
        aria-label={t("common:tooltips.startVoiceInput")}
        aria-disabled={disabled}
      >
        <HugeiconsIcon
          icon={Mic01Icon}
          data-icon="mic"
          size={INPUT_AREA_BUTTONS.iconSize}
          strokeWidth={1.75}
          className="block"
        />
      </button>
    );

    return (
      <Tooltip
        content={
          <KeyboardShortcutTooltipContent
            label={t("common:tooltips.startVoiceInput")}
            shortcut={getShortcutKeys("voice_input")}
          />
        }
        position="top"
        mouseEnterDelay={200}
        framedPanel
      >
        {buttonNode}
      </Tooltip>
    );
  }
);

VoiceInputButton.displayName = "VoiceInputButton";

export default VoiceInputButton;
