/**
 * AppGridEditPanel Component
 *
 * Panel for customizing app grid layout:
 * - Adjust horizontal and vertical gaps
 * - Reset layout to default
 */
import { motion } from "framer-motion";
import { useSetAtom } from "jotai";
import { RotateCcw } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Slider from "@src/components/Slider";
import {
  DEFAULT_APP_GRID_CONFIG,
  appGridConfigAtom,
} from "@src/store/ui/appGridAtom";
import { classNames } from "@src/util/ui/classNames";

// ============================================
// Types
// ============================================

export interface AppGridEditPanelProps {
  horizontalGap: number;
  verticalGap: number;
  onHorizontalGapChange: (value: number) => void;
  onVerticalGapChange: (value: number) => void;
  className?: string;
}

// ============================================
// Constants
// ============================================

const GAP_LIMITS = {
  min: 20,
  max: 100,
  step: 4,
};

// ============================================
// Component
// ============================================

const AppGridEditPanel: React.FC<AppGridEditPanelProps> = ({
  horizontalGap,
  verticalGap,
  onHorizontalGapChange,
  onVerticalGapChange,
  className,
}) => {
  const { t } = useTranslation("navigation");
  const setGridConfig = useSetAtom(appGridConfigAtom);

  // ============================================
  // Event Handlers
  // ============================================

  const handleReset = () => {
    setGridConfig(DEFAULT_APP_GRID_CONFIG);
  };

  // ============================================
  // Render
  // ============================================

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      className={classNames(
        "flex flex-col gap-4 rounded-[12px] p-4",
        className
      )}
      style={{
        background: "var(--start-edit-panel-bg)",
        backdropFilter: "var(--start-edit-panel-backdrop)",
        WebkitBackdropFilter: "var(--start-edit-panel-backdrop)",
        border: "var(--start-edit-panel-border)",
        boxShadow: "var(--start-edit-panel-shadow)",
      }}
    >
      {/* Title */}
      <div className="text-[14px] font-semibold text-text-1">
        {t("appGrid.customizeGrid")}
      </div>

      {/* Gap Controls */}
      <div className="flex flex-col gap-3">
        {/* Horizontal Gap */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-[12px] text-text-2">
              {t("appGrid.horizontalGap")}
            </label>
            <span className="text-[12px] font-medium text-text-1">
              {horizontalGap}px
            </span>
          </div>
          <Slider
            min={GAP_LIMITS.min}
            max={GAP_LIMITS.max}
            step={GAP_LIMITS.step}
            value={horizontalGap}
            onChange={(value) =>
              onHorizontalGapChange(Array.isArray(value) ? value[0] : value)
            }
            showTooltip={false}
            noPadding
          />
        </div>

        {/* Vertical Gap */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-[12px] text-text-2">
              {t("appGrid.verticalGap")}
            </label>
            <span className="text-[12px] font-medium text-text-1">
              {verticalGap}px
            </span>
          </div>
          <Slider
            min={GAP_LIMITS.min}
            max={GAP_LIMITS.max}
            step={GAP_LIMITS.step}
            value={verticalGap}
            onChange={(value) =>
              onVerticalGapChange(Array.isArray(value) ? value[0] : value)
            }
            showTooltip={false}
            noPadding
          />
        </div>
      </div>

      {/* Reset Button */}
      <button
        onClick={handleReset}
        className="flex items-center justify-center gap-2 rounded-[8px] border border-border-2 bg-fill-1 px-3 py-2 text-[13px] font-medium text-text-1 transition-all"
      >
        <RotateCcw size={14} strokeWidth={2} />
        {t("appGrid.resetToDefault")}
      </button>
    </motion.div>
  );
};

export default AppGridEditPanel;
