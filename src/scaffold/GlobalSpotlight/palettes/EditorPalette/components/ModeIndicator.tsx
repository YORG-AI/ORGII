/**
 * ModeIndicator Component
 *
 * Shows current mode badge in the spotlight input
 */
import React from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";

import { EDITOR_PALETTE_CONFIG } from "../../config";
import type { EditorPaletteMode } from "../types";

const EDITOR_PALETTE_MODES = EDITOR_PALETTE_CONFIG.modes;

interface ModeIndicatorProps {
  mode: EditorPaletteMode;
}

export const ModeIndicator: React.FC<ModeIndicatorProps> = ({ mode }) => {
  const { t } = useTranslation();
  const modeConfig = EDITOR_PALETTE_MODES[mode];
  if (!modeConfig) return null;

  const icon = modeConfig.icon;
  const label = t(`selectors.editorSpotlight.modes.${mode}.label`);

  return (
    <div className="flex items-center gap-2">
      {icon && <AnyIcon icon={icon} size={14} className="text-text-2" />}
      <span className="text-[12px] text-text-2">{label}</span>
    </div>
  );
};

export default ModeIndicator;
