import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import ModelIcon from "@src/components/ModelIcon";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { useFilteredItems } from "@src/hooks/search";
import { HugeiconsIcon, Tick01Icon } from "@src/icons";
import type { MobileModelOption } from "@src/modules/MobileRemote/connection/types";
import { formatModelName } from "@src/util/formatModelName";
import { getViewportSize } from "@src/util/ui/window/viewport";

import { mobileModelOptionsShareFamily } from "./collapseMobileModelOptions";

const DROPDOWN_WIDTH = 380;
const VIEWPORT_MARGIN = 12;

function formatModelLabel(modelId: string): string {
  return formatModelName(modelId) || modelId;
}

export interface MobileModelListDropdownProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  options: MobileModelOption[];
  /** Full catalog used for family matching on the current selection. */
  allOptions?: MobileModelOption[];
  currentModelId?: string;
  currentAccountId?: string;
  loading?: boolean;
  patching?: boolean;
  loadingLabel: string;
  emptyLabel: string;
  onSelect: (option: MobileModelOption) => void;
}

/** Anchored model list — same dropdown chrome as desktop UnifiedModelDropdown. */
export function MobileModelListDropdown({
  anchorRef,
  open,
  onClose,
  options,
  allOptions,
  currentModelId,
  currentAccountId,
  loading = false,
  patching = false,
  loadingLabel,
  emptyLabel,
  onSelect,
}: MobileModelListDropdownProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const familyOptions = allOptions ?? options;

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => setSearchQuery(""));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const getSearchText = useCallback(
    (option: MobileModelOption) =>
      `${formatModelLabel(option.id)} ${option.accountLabel} ${option.id}`,
    []
  );
  const { filteredItems } = useFilteredItems({
    items: options,
    searchQuery,
    getSearchText,
  });

  const handleSelect = useCallback(
    (option: MobileModelOption) => {
      if (patching) return;
      onSelect(option);
    },
    [onSelect, patching]
  );

  const { isPositioned, panelRef, panelPosition, keyboard } = useDropdownEngine<
    HTMLElement,
    MobileModelOption
  >({
    anchorRef,
    open,
    onOpenChange: (nextOpen) => {
      if (!nextOpen) onClose();
    },
    placement: "top",
    gap: DROPDOWN_PANEL.triggerGap,
    listNavigation: {
      items: filteredItems,
      onSelect: handleSelect,
      initialSelectedIndex: -1,
    },
  });

  useEffect(() => {
    if (!open || !isPositioned) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isPositioned, open]);

  if (!open || !isPositioned) return null;

  const { width: viewportWidth } = getViewportSize();
  const panelWidth = Math.min(
    DROPDOWN_WIDTH,
    viewportWidth - VIEWPORT_MARGIN * 2
  );
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(panelPosition.left, viewportWidth - VIEWPORT_MARGIN - panelWidth)
  );

  return createPortal(
    <div
      ref={panelRef}
      role="listbox"
      aria-label={loadingLabel}
      data-testid="mobile-model-picker-dropdown"
      className={`${DROPDOWN_CLASSES.panelAnimated} fixed flex flex-col overflow-hidden p-1`}
      style={{
        top: panelPosition.top,
        bottom: panelPosition.bottom,
        left,
        width: panelWidth,
        maxHeight: panelPosition.maxHeight,
        visibility: isPositioned ? "visible" : "hidden",
      }}
    >
      <DropdownSearch
        ref={inputRef}
        value={searchQuery}
        onChange={setSearchQuery}
        containerClassName="mb-1"
        autoFocus
      />
      <div
        className={`${DROPDOWN_CLASSES.optionsContainerOverlay} min-h-0 flex-1`}
        style={{ maxHeight: panelPosition.maxHeight }}
      >
        {filteredItems.length === 0 ? (
          <div className={DROPDOWN_CLASSES.listMessage}>
            {loading ? loadingLabel : emptyLabel}
          </div>
        ) : (
          filteredItems.map((option, index) => {
            const selected =
              option.id === currentModelId &&
              option.accountId === (currentAccountId ?? "");
            const selectedByFamily =
              !selected &&
              Boolean(currentModelId) &&
              option.accountId === (currentAccountId ?? "") &&
              mobileModelOptionsShareFamily(
                familyOptions,
                currentModelId ?? "",
                option.id
              );
            const showSelected = selected || selectedByFamily;
            const label = formatModelLabel(option.id);
            return (
              <button
                key={`${option.accountId}:${option.id}`}
                type="button"
                role="option"
                disabled={patching}
                {...keyboard.getItemProps(index)}
                className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full justify-start`}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center text-text-1">
                  {showSelected ? (
                    <HugeiconsIcon
                      icon={Tick01Icon}
                      data-icon="check"
                      size={DROPDOWN_ITEM.iconSize}
                      strokeWidth={2.25}
                      className="text-primary-6"
                    />
                  ) : (
                    <ModelIcon modelName={option.id} size={14} />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate overflow-hidden text-[13px]">
                  {label}
                </span>
                <span className="relative z-10 ml-1 shrink-0 truncate text-[12px] text-text-3">
                  {option.accountLabel}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>,
    document.body
  );
}

MobileModelListDropdown.displayName = "MobileModelListDropdown";
