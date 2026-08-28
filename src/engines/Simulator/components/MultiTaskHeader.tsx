/**
 * MultiTaskHeader
 *
 * Window header bar for the background-tasks dock app.
 * Contains task count and close button.
 */
import { useAtomValue } from "jotai";
import React from "react";
import { useTranslation } from "react-i18next";

import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { EVENT_LOADING_SHIMMER_TEXT_CLASSES } from "@src/engines/ChatPanel/blocks/primitives";
import { replayModeAtom } from "@src/engines/SessionCore";
import { ArrowShrink01Icon, Cancel01Icon, HugeiconsIcon } from "@src/icons";

interface MultiTaskHeaderProps {
  taskCount: number;
  onClose?: () => void;
  onMinimize?: () => void;
}

const MultiTaskHeader: React.FC<MultiTaskHeaderProps> = ({
  taskCount,
  onClose,
  onMinimize,
}) => {
  const { t } = useTranslation("sessions");
  const replayMode = useAtomValue(replayModeAtom);
  const headerBorderClass =
    replayMode === "follow" ? "" : "border-b border-border-2";

  return (
    <div
      className={`flex h-10 flex-shrink-0 items-center justify-between bg-bg-1 px-3 ${headerBorderClass}`}
    >
      <div className="flex items-center">
        <div
          className={`text-xs text-text-3 ${
            taskCount > 0
              ? `font-bold ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}`
              : ""
          }`}
        >
          {t("simulator.multiTask.monitoringProgress", { count: taskCount })}
        </div>
      </div>

      <div className="flex items-center gap-0.5">
        {onMinimize && (
          <button
            type="button"
            onClick={onMinimize}
            className={`flex h-6 w-6 items-center justify-center rounded text-text-3 transition-all ${SURFACE_TOKENS.hover} hover:text-text-1`}
            title={t("simulator.multiTask.minimizePanel")}
          >
            <HugeiconsIcon
              icon={ArrowShrink01Icon}
              data-icon="minimize-2"
              size={14}
            />
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className={`flex h-6 w-6 items-center justify-center rounded text-text-3 transition-all ${SURFACE_TOKENS.hover} hover:text-text-1`}
            title={t("simulator.multiTask.closePanel")}
          >
            <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={14} />
          </button>
        )}
      </div>
    </div>
  );
};

export { MultiTaskHeader };
