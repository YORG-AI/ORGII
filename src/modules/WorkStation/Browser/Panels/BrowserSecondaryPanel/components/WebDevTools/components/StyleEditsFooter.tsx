/**
 * StyleEditsFooter — Pending style edits summary and actions (Design / CSS panels).
 */
import { Undo2 } from "lucide-react";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";

export interface StyleEditsFooterProps {
  /** Number of successful style edits in the current session */
  editCount: number;
  /** Undo last edit (placeholder until backend supports revert) */
  onUndo: () => void;
  /** Send / commit edits (placeholder until backend supports commit) */
  onSend: () => void;
  /** Disable actions while a style request is in flight */
  disabled?: boolean;
}

export const StyleEditsFooter: React.FC<StyleEditsFooterProps> = memo(
  ({ editCount, onUndo, onSend, disabled = false }) => {
    const { t } = useTranslation();

    if (editCount <= 0) {
      return null;
    }

    return (
      <div
        className="flex shrink-0 items-center justify-between gap-2 border-t border-border-2 bg-fill-1 px-3 py-2"
        role="status"
        aria-live="polite"
      >
        <span className="min-w-0 truncate text-[12px] text-text-2">
          {t("workstation.styleEditsCount", { count: editCount })}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <ToolbarTooltip label={t("actions.undo")}>
            <Button
              size="small"
              shape="square"
              iconOnly
              icon={<Undo2 size={14} strokeWidth={1.75} />}
              disabled={disabled || editCount <= 0}
              onClick={onUndo}
              aria-label={t("actions.undo")}
              htmlType="button"
            />
          </ToolbarTooltip>
          <Button
            variant="primary"
            size="small"
            disabled={disabled}
            onClick={onSend}
            htmlType="button"
          >
            {t("workstation.sendStyleEdits")}
          </Button>
        </div>
      </div>
    );
  }
);

StyleEditsFooter.displayName = "StyleEditsFooter";

export default StyleEditsFooter;
