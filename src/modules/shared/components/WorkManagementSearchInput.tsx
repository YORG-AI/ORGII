import { type RefObject, memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { SearchInput } from "@src/components/SearchInput";

interface WorkManagementSearchInputProps {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onClose?: () => void;
  dataTestId?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  placement?: "header" | "list";
  /** Let a split-list header search occupy the remaining row width. */
  fillWidth?: boolean;
}

/** Compact controlled search shared by Work Management page headers. */
export const WorkManagementSearchInput = memo(
  ({
    value,
    placeholder,
    onChange,
    onClose,
    dataTestId,
    inputRef,
    placement = "header",
    fillWidth = false,
  }: WorkManagementSearchInputProps) => {
    const { t } = useTranslation("common");
    const clear = useCallback(() => onChange(""), [onChange]);
    const resolvedPlaceholder =
      placeholder ?? `${t("actions.search", { defaultValue: "Search" })}...`;
    const fillsAvailableWidth = placement === "list" || fillWidth;

    return (
      <div
        className={fillsAvailableWidth ? "min-w-0 flex-1" : undefined}
        data-testid={dataTestId}
      >
        <SearchInput
          value={value}
          onChange={onChange}
          onClear={clear}
          onClose={onClose}
          showClearButton
          hideChevron
          variant={placement === "list" ? "sidebar" : "panel"}
          surface="ghost"
          className={
            fillsAvailableWidth ? "w-full min-w-0" : "w-64 max-w-[28vw]"
          }
          placeholder={resolvedPlaceholder}
          ariaLabel={resolvedPlaceholder}
          inputRef={inputRef}
        />
      </div>
    );
  }
);

WorkManagementSearchInput.displayName = "WorkManagementSearchInput";
