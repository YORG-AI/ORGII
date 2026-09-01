/**
 * SpotlightFooter Component
 *
 * Keyboard shortcut hints for selectors.
 * - `spotlight` (default): below the main panel — simple bg-bg-2 pill.
 * - `dropdown`: same hints with `DROPDOWN_CLASSES.panel` (e.g. @-mention menu).
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import {
  KEYBOARD_SHORTCUT_VARIANT,
  KeyboardShortcut,
} from "@src/components/KeyboardShortcut";
import { ArrowDown02Icon, ArrowUp02Icon, HugeiconsIcon } from "@src/icons";

// ============ TYPES ============

/**
 * Which chip to show when {@link SpotlightFooterProps.hasActiveAction} is true.
 *
 * - `back` — Backspace + "Back" (drill-in palettes, e.g. WorkspacePalette).
 * - `switchColumn` — Tab + "Switch column" (two-column palettes like
 *   UnifiedModelPalette, where Backspace is intentionally inert and
 *   Tab/ArrowLeft hand focus back to the left column).
 * - `switchSection` — Tab + "Switch section" for palettes with a pinned
 *   action section below the main result list.
 */
export const SPOTLIGHT_FOOTER_ACTIVE_CHIP = {
  back: "back",
  switchColumn: "switchColumn",
  switchSection: "switchSection",
} as const;
export type SpotlightFooterActiveChip =
  (typeof SPOTLIGHT_FOOTER_ACTIVE_CHIP)[keyof typeof SPOTLIGHT_FOOTER_ACTIVE_CHIP];

interface SpotlightFooterProps {
  /** Whether there's an active path (items selected) */
  hasActiveAction: boolean;
  /**
   * `spotlight` — simple bg-bg-2 pill (default, GlobalSpotlight shell).
   * `dropdown` — `DROPDOWN_CLASSES.panel` (border-border-2, bg-bg-2, shadow-dropdown).
   */
  variant?: "spotlight" | "dropdown";
  /**
   * Which chip to render in the "active action" slot. Defaults to `back`
   * (Backspace + Return) to match historical drill-in palettes.
   */
  activeActionChip?: SpotlightFooterActiveChip;
  /**
   * Palette-owned controls rendered inside the pill after the last hint
   * (see `ShellFooterAction placement="inline"`). Keep these visually
   * quiet — the pill is a hint strip, not a toolbar.
   */
  trailingSlot?: React.ReactNode;
}

// ============ COMPONENT ============

export const SpotlightFooter: React.FC<SpotlightFooterProps> = ({
  hasActiveAction,
  variant = "spotlight",
  activeActionChip = SPOTLIGHT_FOOTER_ACTIVE_CHIP.back,
  trailingSlot,
}) => {
  const { t } = useTranslation();

  const inner = (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 py-2 text-[11px] text-text-2">
      <span className="flex items-center gap-1.5">
        {/* `↑↓` stays as a hand-rolled paired pill: the shared
            KeyboardShortcut component renders one pill per key, but the
            macOS convention is to show navigation arrows joined inside a
            single pill. Background/height match the spotlightFooter
            variant so the look is consistent. */}
        <kbd className="flex h-[18px] items-center gap-0.5 rounded bg-fill-3 px-1.5 leading-none font-medium text-text-2">
          <HugeiconsIcon
            icon={ArrowUp02Icon}
            data-icon="arrow-up"
            size={10}
            strokeWidth={2}
          />
          <HugeiconsIcon
            icon={ArrowDown02Icon}
            data-icon="arrow-down"
            size={10}
            strokeWidth={2}
          />
        </kbd>
        <span>{t("selectors.spotlightFooter.navigate")}</span>
      </span>

      <span className="flex items-center gap-1.5">
        <KeyboardShortcut
          shortcut="enter"
          variant={KEYBOARD_SHORTCUT_VARIANT.spotlightFooter}
        />
        <span>{t("selectors.spotlightFooter.select")}</span>
      </span>

      {hasActiveAction &&
        (activeActionChip === SPOTLIGHT_FOOTER_ACTIVE_CHIP.switchColumn ||
        activeActionChip === SPOTLIGHT_FOOTER_ACTIVE_CHIP.switchSection ? (
          <span className="flex items-center gap-1.5">
            <KeyboardShortcut
              shortcut="tab"
              variant={KEYBOARD_SHORTCUT_VARIANT.spotlightFooter}
            />
            <span>
              {activeActionChip === SPOTLIGHT_FOOTER_ACTIVE_CHIP.switchSection
                ? t("selectors.spotlightFooter.switchSection")
                : t("selectors.spotlightFooter.switchColumn")}
            </span>
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <KeyboardShortcut
              shortcut="backspace"
              variant={KEYBOARD_SHORTCUT_VARIANT.spotlightFooter}
            />
            <span>{t("actions.back")}</span>
          </span>
        ))}

      <span className="flex items-center gap-1.5">
        <KeyboardShortcut
          shortcut="esc"
          variant={KEYBOARD_SHORTCUT_VARIANT.spotlightFooter}
        />
        <span>{t("actions.close")}</span>
      </span>

      {trailingSlot}
    </div>
  );

  if (variant === "dropdown") {
    return (
      <div className={`${DROPDOWN_CLASSES.panel} mx-auto w-fit max-w-full`}>
        {inner}
      </div>
    );
  }

  return (
    <div className="mx-auto w-fit max-w-full overflow-hidden rounded-full border border-border-2 bg-bg-2 shadow-lg">
      {inner}
    </div>
  );
};

export default SpotlightFooter;
