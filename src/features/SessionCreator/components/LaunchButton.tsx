/**
 * LaunchButton Component
 *
 * Round icon-only start button for launching sessions.
 * Uses the same INPUT_AREA_BUTTONS tokens as InputActions
 * so both submit buttons are visually identical.
 */
import { useAtomValue } from "jotai";
import { ArrowUp, Loader2 } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { INPUT_AREA_BUTTONS } from "@src/config/inputAreaTokens";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { chatAppearanceAtom } from "@src/store/config/configAtom";

// ============================================
// Type Definitions
// ============================================

export interface LaunchButtonProps {
  /** Whether the button is disabled */
  disabled: boolean;
  /** Whether loading state is active */
  loading: boolean;
  /** Click handler */
  onClick: () => void;
  /** Optional visible label for non-icon launch actions */
  label?: string;
}

// ============================================
// Styling (matches InputActions base + active state)
// ============================================

// Hover uses a paint-only `bg-primary-5` swap (see
// INPUT_AREA_BUTTONS.iconButtonActive), which keeps the button in the
// main compositor layer and avoids the hover layer-promotion shake
// that the previous `opacity-80` version triggered. `transition-colors`
// limits the 200ms animation to the bg swap; nothing else animates.
const ICON_BASE_CLASS = `flex ${INPUT_AREA_BUTTONS.iconButtonSizeClass} shrink-0 items-center justify-center rounded-full transition-colors duration-200 focus:outline-none`;
const LABEL_BASE_CLASS =
  "flex h-8 shrink-0 items-center justify-center rounded-full px-3 text-[13px] font-medium transition-colors duration-200 focus:outline-none";

// ============================================
// Component
// ============================================

const LaunchButton: React.FC<LaunchButtonProps> = ({
  disabled,
  loading,
  onClick,
  label,
}) => {
  const { t } = useTranslation();
  const { sendOnEnter } = useAtomValue(chatAppearanceAtom);
  const isActive = loading || !disabled;
  const stateClass = isActive
    ? INPUT_AREA_BUTTONS.iconButtonActive
    : INPUT_AREA_BUTTONS.iconButtonInactive;
  const baseClass = label ? LABEL_BASE_CLASS : ICON_BASE_CLASS;
  const ariaLabel = label ?? t("common:actions.send");

  // `leading-none` + explicit `block` on the SVG kill the baseline gap
  // that `lucide-react` icons inherit from their default inline-block
  // display. Without these, the button's inline formatting context
  // reserves space below the SVG for the imagined text descender, and
  // any tiny re-layout in the surrounding toolbar (hover, focus-ring,
  // tooltip mount) nudges the icon vertically by a sub-pixel amount —
  // visually the ArrowUp "shakes" on hover.
  const button = (
    <button
      type="button"
      className={`${baseClass} ${stateClass} leading-none`}
      style={{ lineHeight: 0 }}
      onClick={disabled ? undefined : onClick}
      disabled={disabled && !loading}
      aria-label={ariaLabel}
      data-testid="chat-send-button"
      data-state={loading ? "working" : "submit"}
    >
      {loading ? (
        <Loader2
          size={INPUT_AREA_BUTTONS.iconSize}
          strokeWidth={2}
          className="block animate-spin text-[#fff]"
        />
      ) : label ? (
        <span className="text-[#fff]">{label}</span>
      ) : (
        <ArrowUp
          size={INPUT_AREA_BUTTONS.iconSize}
          strokeWidth={2}
          className="block text-[#fff]"
        />
      )}
    </button>
  );

  // Only the idle Send state has a keyboard shortcut. The Loading state has
  // no actionable shortcut so we skip the tooltip entirely there.
  if (loading) return button;

  return (
    <Tooltip
      content={
        <KeyboardShortcutTooltipContent
          label={label ?? t("common:actions.send")}
          shortcut={getShortcutKeys("chat_send", {
            chatSendOnEnter: sendOnEnter,
          })}
        />
      }
      position="top-end"
      mouseEnterDelay={200}
      framedPanel
    >
      {button}
    </Tooltip>
  );
};

export default LaunchButton;
