/**
 * DropdownOptionsRenderer
 *
 * Renders a list of DropdownOption[] with consistent styling,
 * keyboard highlight, multi-select checkboxes, loading/empty states.
 *
 * Used internally by Dropdown (options mode) and Select.
 */
import { Loader2 } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Checkbox from "@src/components/Checkbox";

import DropdownSelectedCheck from "./DropdownSelectedCheck";
import { DROPDOWN_CLASSES, DROPDOWN_ITEM } from "./tokens";
import type { DropdownOption, DropdownSelectValue } from "./types";

export interface DropdownOptionsRendererProps {
  options: DropdownOption[];
  value?: DropdownSelectValue;
  mode: "single" | "multiple";
  highlightedIndex: number;
  keyboardNavigated: boolean;
  onSelect: (option: DropdownOption) => void;
  getOptionMouseEnterProps?: (index: number) => {
    "data-dropdown-keyboard-mode"?: "true";
    onMouseEnter: () => void;
  };
  loading?: boolean;
  emptyContent?: React.ReactNode;
  dropdownRender?: (menu: React.ReactNode) => React.ReactNode;
}

const DropdownOptionsRenderer: React.FC<DropdownOptionsRendererProps> = ({
  options,
  value,
  mode,
  highlightedIndex,
  keyboardNavigated,
  onSelect,
  getOptionMouseEnterProps,
  loading = false,
  emptyContent,
  dropdownRender,
}) => {
  const { t } = useTranslation();
  const isMultiple = mode === "multiple";

  let content: React.ReactNode;

  if (loading) {
    content = (
      <div className={DROPDOWN_CLASSES.listMessage}>
        <Loader2 size={DROPDOWN_ITEM.iconSize} className="animate-spin" />
        <span>{t("actions.loading")}</span>
      </div>
    );
  } else if (options.length === 0) {
    content = emptyContent ?? (
      <div className={DROPDOWN_CLASSES.listMessage}>
        <span>{t("placeholders.noOptions")}</span>
      </div>
    );
  } else {
    content = (
      <div
        className={`select-options-overlay ${DROPDOWN_CLASSES.optionsContainerScrollbar}`}
      >
        <div className={DROPDOWN_CLASSES.itemsColumn}>
          {options.map((option, index) => {
            const isSelected = isMultiple
              ? Array.isArray(value) && value.includes(option.value)
              : value === option.value;
            const isHighlighted =
              keyboardNavigated && index === highlightedIndex;
            const optionMouseEnterProps = getOptionMouseEnterProps?.(index);

            return (
              <div
                key={option.value}
                data-testid={option.dataTestId}
                {...optionMouseEnterProps}
                className={[
                  DROPDOWN_CLASSES.item,
                  DROPDOWN_CLASSES.itemHover,
                  "w-full justify-between",
                  isSelected && DROPDOWN_CLASSES.itemSelected,
                  isHighlighted && "bg-fill-2",
                  option.disabled && DROPDOWN_CLASSES.itemDisabled,
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => onSelect(option)}
              >
                {isMultiple && (
                  <Checkbox checked={isSelected} className="size-4 shrink-0" />
                )}
                {option.icon ? (
                  <span
                    className={`flex shrink-0 items-center ${
                      isSelected ? "text-primary-6" : "text-text-1"
                    }`}
                  >
                    {option.icon}
                  </span>
                ) : null}
                <span
                  className={`flex min-w-0 flex-1 items-center justify-between ${DROPDOWN_ITEM.gapClass} overflow-hidden`}
                >
                  <span
                    className={
                      isSelected
                        ? "truncate text-primary-6"
                        : "truncate text-text-1"
                    }
                  >
                    {option.label}
                  </span>
                  {!isMultiple && isSelected && <DropdownSelectedCheck />}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return <>{dropdownRender ? dropdownRender(content) : content}</>;
};

export default DropdownOptionsRenderer;
