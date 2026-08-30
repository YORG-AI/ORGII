/**
 * LaunchButton Component
 *
 * Round icon-only start button for launching sessions.
 * Uses the same INPUT_AREA_BUTTONS tokens as InputActions
 * so both submit buttons are visually identical.
 */
import { useAtomValue } from "jotai";
import React from "react";
import { useTranslation } from "react-i18next";

import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { INPUT_AREA_BUTTONS } from "@src/config/inputAreaTokens";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { ArrowUp02Icon, HugeiconsIcon, Loading03Icon } from "@src/icons";
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
  /** Accessible action name when the icon-only button performs a custom submit. */
  ariaLabel?: string;
  /** Optional stable selector for host-specific submit actions. */
  dataTestId?: string;
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

// ============================================
// Component
// ============================================

const LaunchButton: React.FC<LaunchButtonProps> = ({
  disabled,
  loading,
  onClick,
  ariaLabel: customAriaLabel,
  dataTestId = "chat-send-button",
}) => {
  const { t } = useTranslation();
  const { sendOnEnter } = useAtomValue(chatAppearanceAtom);
  const isActive = loading || !disabled;
  const stateClass = isActive
    ? INPUT_AREA_BUTTONS.iconButtonActive
    : INPUT_AREA_BUTTONS.iconButtonInactive;
  const ariaLabel = customAriaLabel ?? t("common:actions.send");

  // `leading-none` + explicit `block` on the SVG kill the baseline gap
  // that icon SVGs inherit from their default inline-block
  // display. Without these, the button's inline formatting context
  // reserves space below the SVG for the imagined text descender, and
  // any tiny re-layout in the surrounding toolbar (hover, focus-ring,
  // tooltip mount) nudges the icon vertically by a sub-pixel amount —
  // visually the ArrowUp "shakes" on hover.
  const button = (
    <button
      type="button"
      className={`${ICON_BASE_CLASS} ${stateClass} leading-none`}
      style={{ lineHeight: 0 }}
      onClick={disabled ? undefined : onClick}
      disabled={disabled && !loading}
      aria-label={ariaLabel}
      data-testid={dataTestId}
      data-state={loading ? "working" : "submit"}
    >
      {loading ? (
        <HugeiconsIcon
          icon={Loading03Icon}
          data-icon="loader-2"
          size={INPUT_AREA_BUTTONS.iconSize}
          strokeWidth={2}
          className="block animate-spin text-[#fff]"
        />
      ) : (
        <HugeiconsIcon
          icon={ArrowUp02Icon}
          data-icon="arrow-up"
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
          label={ariaLabel}
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
