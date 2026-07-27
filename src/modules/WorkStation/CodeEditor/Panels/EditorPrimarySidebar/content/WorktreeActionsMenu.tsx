import { Ellipsis, Trash2 } from "lucide-react";
import React, { memo, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { DropdownPanel } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import {
  FOLDER_HEADER,
  HEADER_BUTTON,
  PRIMARY_SIDEBAR_HOVER,
} from "@src/modules/WorkStation/shared/tokens";
import { getViewportSize } from "@src/util/ui/window/viewport";

interface WorktreeActionsMenuProps {
  onRemove: () => void;
}

export const WorktreeActionsMenu: React.FC<WorktreeActionsMenuProps> = memo(
  ({ onRemove }) => {
    const { t } = useTranslation();
    const {
      isOpen,
      isPositioned,
      toggle,
      close,
      triggerRef,
      panelRef,
      panelPosition,
    } = useDropdownEngine<HTMLButtonElement>({
      gap: DROPDOWN_PANEL.triggerGapTight,
      placement: "bottom",
      align: "right",
    });

    const handleRemove = useCallback(() => {
      close();
      onRemove();
    }, [close, onRemove]);

    const triggerRightEdge = panelPosition.left + panelPosition.width;
    const viewportWidth =
      typeof window !== "undefined" ? getViewportSize().width : 0;

    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          className={isOpen ? HEADER_BUTTON.active : FOLDER_HEADER.action}
          data-state={isOpen ? "open" : "closed"}
          title={t("sourceControl.worktreeActions")}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          <Ellipsis
            size={14}
            className={isOpen ? "text-primary-6" : "text-text-3"}
          />
        </button>

        {isOpen &&
          isPositioned &&
          createPortal(
            <DropdownPanel
              ref={panelRef}
              className={`${DROPDOWN_WIDTHS.sidebarMenuClass} ${DROPDOWN_PANEL.paddingClass}`}
              animated={false}
              maxHeight="none"
              style={{
                position: "fixed",
                top: panelPosition.top,
                right: viewportWidth - triggerRightEdge,
                zIndex: DROPDOWN_PANEL.zIndex,
              }}
            >
              <div className={DROPDOWN_CLASSES.itemsColumn}>
                <button
                  type="button"
                  className={`${DROPDOWN_CLASSES.item} ${PRIMARY_SIDEBAR_HOVER.row} w-full text-danger-6`}
                  onClick={handleRemove}
                >
                  <Trash2 size={DROPDOWN_ITEM.iconSize} className="shrink-0" />
                  <span className="truncate">
                    {t("sourceControl.removeWorktree")}
                  </span>
                </button>
              </div>
            </DropdownPanel>,
            document.body
          )}
      </>
    );
  }
);

WorktreeActionsMenu.displayName = "WorktreeActionsMenu";

export interface WorktreeContextMenuProps {
  x: number;
  y: number;
  onRemove: () => void;
  onClose: () => void;
}

export function WorktreeContextMenu({
  x,
  y,
  onRemove,
  onClose,
}: WorktreeContextMenuProps) {
  const { t } = useTranslation();

  const handleRemove = useCallback(() => {
    onClose();
    onRemove();
  }, [onClose, onRemove]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9998]"
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <DropdownPanel
        className={`${DROPDOWN_WIDTHS.sidebarMenuClass} ${DROPDOWN_PANEL.paddingClass}`}
        animated={false}
        maxHeight="none"
        style={{
          position: "fixed",
          top: y,
          left: x,
          zIndex: DROPDOWN_PANEL.zIndex,
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={DROPDOWN_CLASSES.itemsColumn}>
          <button
            type="button"
            className={`${DROPDOWN_CLASSES.item} ${PRIMARY_SIDEBAR_HOVER.row} w-full text-danger-6`}
            onClick={handleRemove}
          >
            <Trash2 size={DROPDOWN_ITEM.iconSize} className="shrink-0" />
            <span className="truncate">
              {t("sourceControl.removeWorktree")}
            </span>
          </button>
        </div>
      </DropdownPanel>
    </div>,
    document.body
  );
}

export default WorktreeActionsMenu;
