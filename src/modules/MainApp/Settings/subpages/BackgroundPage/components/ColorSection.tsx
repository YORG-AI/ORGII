/**
 * ColorSection Component
 * Preset solid colors, saved DIY hex colors, and + picker in one row.
 */
import Button from "@/src/components/Button";
import { SectionRow } from "@/src/modules/shared/layouts/SectionLayout";
import React from "react";
import { useTranslation } from "react-i18next";

import { BACKGROUND_COLOR_PRESETS } from "@src/config/appearance/backgroundColors";
import { Add01Icon, Cancel01Icon, HugeiconsIcon } from "@src/icons";

import { MAX_CUSTOM_BACKGROUND_COLORS } from "../config";
import type { BackgroundConfig } from "../types";
import { normalizeHexColor } from "../utils";

const COLOR_SWATCH_SIZE = "h-8 w-8";

/** Idle / hover / focus ring aligned with Select trigger + Input (see Select/index.scss) */
const SWATCH_BASE = `relative shrink-0 rounded-full border border-solid transition-[border-color,box-shadow] duration-150 ease-out ${COLOR_SWATCH_SIZE}`;
const SWATCH_IDLE =
  "border-border-2 hover:border-border-3 focus-visible:outline-none focus-visible:border-primary-6 focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]";
const SWATCH_SELECTED =
  "border-primary-6 shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]";

interface ColorSectionProps {
  config: BackgroundConfig;
  translationNamespace: string;
  onColorSelect: (presetId: string) => void;
  onSelectCustomHex: (hex: string) => void;
  onAddCustomHex: (hex: string) => void;
  onRemoveCustomHex: (hex: string, event: React.MouseEvent) => void;
}

export const ColorSection: React.FC<ColorSectionProps> = ({
  config,
  translationNamespace,
  onColorSelect,
  onSelectCustomHex,
  onAddCustomHex,
  onRemoveCustomHex,
}) => {
  const { t } = useTranslation(translationNamespace);

  const activeCustomHex =
    !config.glass &&
    !config.backgroundColorId &&
    typeof config.backgroundColor === "string"
      ? normalizeHexColor(config.backgroundColor)
      : null;

  const customPalette = (config.customColors ?? [])
    .map((hex) => normalizeHexColor(hex))
    .filter((hex): hex is string => hex !== null);

  const atCustomLimit = customPalette.length >= MAX_CUSTOM_BACKGROUND_COLORS;

  /** Seed for native color input (controlled), matching legacy picker behavior */
  const nativePickerValue =
    activeCustomHex ?? customPalette[customPalette.length - 1] ?? "#808080";

  return (
    <SectionRow label={t("background.colors")} layout="vertical">
      <div className="flex flex-wrap gap-2">
        {BACKGROUND_COLOR_PRESETS.map((preset) => {
          const isSelected = config.backgroundColorId === preset.id;

          return (
            <button
              key={preset.id}
              type="button"
              title={preset.description}
              className={`${SWATCH_BASE} ${isSelected ? SWATCH_SELECTED : SWATCH_IDLE}`}
              style={{ backgroundColor: `var(${preset.cssVar})` }}
              onClick={() => onColorSelect(preset.id)}
            />
          );
        })}

        {customPalette.map((hex) => {
          const isSelected =
            activeCustomHex !== null && activeCustomHex === hex;

          return (
            <div key={hex} className="group relative shrink-0">
              <button
                type="button"
                title={hex}
                className={`${SWATCH_BASE} ${isSelected ? SWATCH_SELECTED : SWATCH_IDLE}`}
                style={{ backgroundColor: hex }}
                onClick={() => onSelectCustomHex(hex)}
              />
              <Button
                className="absolute -top-0.5 -right-0.5 z-10 opacity-0 shadow-xs transition-opacity group-hover:opacity-100"
                style={{ width: 18, height: 18, minWidth: 18 }}
                variant="secondary"
                appearance="solid"
                size="mini"
                shape="circle"
                icon={
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    data-icon="x"
                    size={9}
                    strokeWidth={2.25}
                  />
                }
                iconOnly
                title={t("common:actions.delete")}
                onClick={(event) => onRemoveCustomHex(hex, event)}
              />
            </div>
          );
        })}

        <label
          className={`${SWATCH_BASE} inline-flex items-center justify-center bg-transparent text-text-3 ${
            atCustomLimit
              ? "pointer-events-none cursor-not-allowed border-border-2 opacity-40"
              : `cursor-pointer ${SWATCH_IDLE}`
          }`}
          title={
            atCustomLimit
              ? t("background.customColorsLimit", {
                  max: MAX_CUSTOM_BACKGROUND_COLORS,
                })
              : t("background.pickCustomColor")
          }
          aria-label={t("background.addCustomColor")}
        >
          <input
            type="color"
            value={nativePickerValue}
            onChange={(event) => {
              onAddCustomHex(event.target.value);
            }}
            disabled={atCustomLimit}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          />
          <HugeiconsIcon
            icon={Add01Icon}
            data-icon="plus"
            size={14}
            strokeWidth={2.25}
            className="pointer-events-none"
          />
        </label>
      </div>
    </SectionRow>
  );
};
