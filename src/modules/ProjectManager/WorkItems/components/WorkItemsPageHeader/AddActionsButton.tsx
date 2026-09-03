import { useCallback } from "react";
import { createPortal } from "react-dom";

import Button from "@src/components/Button";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { HugeiconsIcon, PencilEdit02Icon } from "@src/icons";

interface AddActionsButtonProps {
  onAddProject?: () => void;
  onAddWorkItem?: () => void;
  addProjectLabel: string;
  addWorkItemLabel: string;
}

export function AddActionsButton({
  onAddProject,
  onAddWorkItem,
  addProjectLabel,
  addWorkItemLabel,
}: AddActionsButtonProps) {
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
    align: "right",
    closeOnEsc: true,
    placement: "bottom",
  });
  const handleAddProject = useCallback(() => {
    close();
    onAddProject?.();
  }, [close, onAddProject]);
  const handleAddWorkItem = useCallback(() => {
    close();
    onAddWorkItem?.();
  }, [close, onAddWorkItem]);

  if (!onAddProject && !onAddWorkItem) return null;
  if (!onAddProject || !onAddWorkItem) {
    const label = onAddWorkItem ? addWorkItemLabel : addProjectLabel;
    return (
      <ToolbarTooltip label={label}>
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          onClick={onAddWorkItem ?? onAddProject}
          aria-label={label}
          data-testid={
            onAddWorkItem
              ? "work-items-create-work-item"
              : "work-items-create-project"
          }
          icon={
            <HugeiconsIcon
              icon={PencilEdit02Icon}
              data-icon="square-pen"
              size={HEADER_ICON_SIZE.md}
              strokeWidth={2}
            />
          }
        />
      </ToolbarTooltip>
    );
  }

  return (
    <>
      <ToolbarTooltip label={addWorkItemLabel} disabled={isOpen}>
        <Button
          ref={triggerRef}
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          className={isOpen ? "bg-surface-selected! text-primary-6!" : ""}
          onClick={toggle}
          aria-label={addWorkItemLabel}
          data-testid="work-items-create-menu"
          icon={
            <HugeiconsIcon
              icon={PencilEdit02Icon}
              data-icon="square-pen"
              size={HEADER_ICON_SIZE.md}
              strokeWidth={2}
            />
          }
        />
      </ToolbarTooltip>
      {isOpen &&
        isPositioned &&
        createPortal(
          <div
            ref={panelRef}
            className={`${DROPDOWN_CLASSES.menuPanelBase} fixed ${DROPDOWN_WIDTHS.sidebarMenuClass}`}
            style={{
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left:
                panelPosition.right === undefined
                  ? panelPosition.left
                  : undefined,
              right: panelPosition.right,
            }}
            role="menu"
          >
            <button
              type="button"
              onClick={handleAddWorkItem}
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
              role="menuitem"
              data-testid="work-items-create-work-item"
            >
              <HugeiconsIcon
                icon={PencilEdit02Icon}
                data-icon="square-pen"
                size={DROPDOWN_ITEM.iconSize}
                strokeWidth={1.75}
                className="text-text-2"
              />
              <span className="min-w-0 flex-1 truncate">
                {addWorkItemLabel}
              </span>
            </button>
            <button
              type="button"
              onClick={handleAddProject}
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
              role="menuitem"
              data-testid="work-items-create-project"
            >
              <HugeiconsIcon
                icon={PencilEdit02Icon}
                data-icon="square-pen"
                size={DROPDOWN_ITEM.iconSize}
                strokeWidth={1.75}
                className="text-text-2"
              />
              <span className="min-w-0 flex-1 truncate">{addProjectLabel}</span>
            </button>
          </div>,
          document.body
        )}
    </>
  );
}
