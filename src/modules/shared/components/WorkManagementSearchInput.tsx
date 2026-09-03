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
  }: WorkManagementSearchInputProps) => {
    const { t } = useTranslation("common");
    const clear = useCallback(() => onChange(""), [onChange]);
    const resolvedPlaceholder =
      placeholder ?? `${t("actions.search", { defaultValue: "Search" })}...`;

    return (
      <div
        className={placement === "list" ? "min-w-0 flex-1" : undefined}
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
          surface="pane"
          className={
            placement === "list" ? "w-full min-w-0" : "w-64 max-w-[28vw]"
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
