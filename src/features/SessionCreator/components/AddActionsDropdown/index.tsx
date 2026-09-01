/**
 * AddActionsDropdown Component
 *
 * Plus button dropdown that combines:
 * - "@ Add Content" (opens @ context selector)
 * - "Upload" (opens file picker)
 *
 * Uses shared useDropdownEngine hook for consistent behavior.
 */
import React, { useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  PILL_CONTROL_ACTIVE_SURFACE_CLASS,
  PILL_CONTROL_HOVER_CLASS,
} from "@src/components/CompoundPill/config";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { INPUT_AREA_BUTTONS } from "@src/config/inputAreaTokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { Add01Icon, AtIcon, AttachmentIcon, HugeiconsIcon } from "@src/icons";

import { ACTION_ITEMS } from "./config";

// ============================================
// Types
// ============================================

export type DropdownDirection = "up" | "down";

interface AddActionsDropdownProps {
  /** Trigger @ mention / add content flow */
  onAddContent: () => void;
  /** Trigger upload flow */
  onUpload: () => void;
  /** Optional className */
  className?: string;
  /** Dropdown direction - up opens above trigger, down opens below */
  dropdownDirection?: DropdownDirection;
  /** When true, the upload option shows as disabled with bg-fill-2 */
  uploadDisabled?: boolean;
}

// ============================================
// Component
// ============================================

const AddActionsDropdown: React.FC<AddActionsDropdownProps> = ({
  onAddContent,
  onUpload,
  className = "",
  dropdownDirection = "down",
  uploadDisabled = false,
}) => {
  const { t } = useTranslation("sessions");
  const {
    isOpen,
    isPositioned,
    panelPosition,
    triggerRef,
    panelRef,
    toggle,
    close,
  } = useDropdownEngine<HTMLButtonElement>({
    placement: dropdownDirection === "up" ? "top" : "bottom",
  });

  const handleSelect = useCallback(
    (actionId: (typeof ACTION_ITEMS)[number]["id"]) => {
      close();
      if (actionId === "add-content") {
        onAddContent();
        return;
      }
      onUpload();
    },
    [onAddContent, onUpload, close]
  );

  const triggerStateClass = isOpen
    ? PILL_CONTROL_ACTIVE_SURFACE_CLASS
    : PILL_CONTROL_HOVER_CLASS;

  const triggerButton = (
    <button
      ref={triggerRef}
      onClick={toggle}
      className={[
        "flex items-center justify-center rounded-full border border-solid border-border-2 text-text-1 transition-all duration-200 focus:outline-none",
        INPUT_AREA_BUTTONS.iconButtonSizeClass,
        triggerStateClass,
      ].join(" ")}
      aria-label="Add"
      aria-expanded={isOpen}
      aria-haspopup="menu"
    >
      <HugeiconsIcon
        icon={Add01Icon}
        data-icon="plus"
        size={INPUT_AREA_BUTTONS.iconSize}
        strokeWidth={1.75}
        className="text-text-1"
      />
    </button>
  );

  return (
    <div className={`relative ${className}`}>
      {triggerButton}

      {isOpen &&
        isPositioned &&
        createPortal(
          <div
            ref={panelRef}
            className={`${DROPDOWN_CLASSES.menuPanelBase} fixed ${DROPDOWN_WIDTHS.menuClass}`}
            style={{
              ...(panelPosition.top !== undefined
                ? { top: panelPosition.top }
                : { bottom: panelPosition.bottom }),
              left: panelPosition.left,
            }}
            role="menu"
          >
            <button
              onClick={() => handleSelect("add-content")}
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
              role="menuitem"
            >
              <HugeiconsIcon
                icon={AtIcon}
                data-icon="at-sign"
                size={DROPDOWN_ITEM.iconSize}
                strokeWidth={1.75}
                className="text-text-2"
              />
              <span className="text-[13px] font-medium text-text-1">
                {t("creator.addContext")}
              </span>
            </button>

            <button
              onClick={
                uploadDisabled ? undefined : () => handleSelect("upload")
              }
              disabled={uploadDisabled}
              className={`${DROPDOWN_CLASSES.item} w-full text-left ${
                uploadDisabled
                  ? "cursor-not-allowed bg-fill-2 opacity-50"
                  : DROPDOWN_CLASSES.itemHover
              }`}
              role="menuitem"
            >
              <HugeiconsIcon
                icon={AttachmentIcon}
                data-icon="paperclip"
                size={DROPDOWN_ITEM.iconSize}
                strokeWidth={1.75}
                className="text-text-2"
              />
              <span className="text-[13px] font-medium text-text-1">
                {t("common:actions.upload")}
              </span>
            </button>
          </div>,
          document.body
        )}
    </div>
  );
};

export default AddActionsDropdown;
