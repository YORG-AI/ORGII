/**
 * Select Component
 *
 * Thin form-trigger wrapper around shared Dropdown building blocks.
 * Renders the trigger element (selector box, tags, clear, chevron)
 * and delegates dropdown behavior to useDropdownEngine, useDropdownKeyboard,
 * and DropdownOptionsRenderer.
 *
 * @example
 * ```tsx
 * <Select
 *   placeholder="Select option"
 *   options={options}
 *   onChange={handleChange}
 * />
 *
 * <Select mode="multiple" showSearch options={options} onChange={handleChange} />
 * ```
 */
import React, { forwardRef, useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import DropdownOptionsRenderer from "@src/components/Dropdown/DropdownOptionsRenderer";
import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import type { DropdownOption } from "@src/components/Dropdown/types";
import { useDropdownKeyboard } from "@src/components/Dropdown/useDropdownKeyboard";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { getDropdownPanelStyle } from "@src/hooks/dropdown/dropdownPanelStyle";
import { useDropdownEngine } from "@src/hooks/dropdown/useDropdownEngine";
import {
  ArrowDown01Icon,
  Cancel01Icon,
  HugeiconsIcon,
  Loading03Icon,
} from "@src/icons";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import { RADIUS_CLASS_MAP, SELECT_DEFAULTS } from "./config";
import "./index.scss";
import type { SelectOption, SelectProps } from "./types";
import { useSelect } from "./useSelect";

// Re-export types for external use
export type { SelectOption, SelectOptionGroup, SelectProps } from "./types";

const Select = forwardRef<HTMLDivElement, SelectProps>(
  (
    {
      value,
      defaultValue,
      onChange,
      mode = SELECT_DEFAULTS.mode,
      options = [],
      placeholder = SELECT_DEFAULTS.placeholder,
      size = SELECT_DEFAULTS.size,
      disabled = SELECT_DEFAULTS.disabled,
      error = SELECT_DEFAULTS.error,
      loading = SELECT_DEFAULTS.loading,
      allowClear = SELECT_DEFAULTS.allowClear,
      showSearch = SELECT_DEFAULTS.showSearch,
      filterOption,
      maxTagCount = SELECT_DEFAULTS.maxTagCount,
      dropdownRender,
      className = "",
      selectorClassName = "",
      style,
      getPopupContainer,
      trigger: _trigger = SELECT_DEFAULTS.trigger,
      popupVisible,
      defaultPopupVisible = SELECT_DEFAULTS.defaultPopupVisible,
      onVisibleChange,
      onSearch,
      onClear,
      onFocus,
      onBlur,
      prefix,
      showTriggerIcon = true,
      placement = SELECT_DEFAULTS.placement,
      dropdownAlign,
      dropdownMinWidth,
      dropdownWidth,
      dropdownWidthMode = SELECT_DEFAULTS.dropdownWidthMode,
      panelZIndex,
      radius = SELECT_DEFAULTS.radius,
      appearance = "default",
      dataTestId,
      ariaLabel,
    },
    ref
  ) => {
    const { t } = useTranslation();
    const { isDark } = useCurrentTheme();

    const resolvedPlaceholder = placeholder || t("placeholders.pleaseSelect");

    // ---- Value management ----
    const {
      currentValue,
      isMultiple,
      flatOptions,
      selectedOptions,
      handleSelect: handleValueSelect,
      handleClear,
    } = useSelect({
      value,
      defaultValue,
      onChange,
      mode,
      options,
      onClear,
    });

    // ---- Search state ----
    const [searchValue, setSearchValue] = useState("");

    const filteredOptions = useMemo(() => {
      if (!showSearch || !searchValue) return flatOptions;

      const filterFn =
        filterOption ||
        ((inputValue: string, option: SelectOption) => {
          const query = inputValue.toLowerCase();
          const searchableText =
            option.triggerLabel ??
            (typeof option.label === "string" ? option.label : "") ??
            "";
          if (
            searchableText &&
            String(searchableText).toLowerCase().includes(query)
          ) {
            return true;
          }
          return String(option.value).toLowerCase().includes(query);
        });

      return flatOptions.filter((opt) => filterFn(searchValue, opt));
    }, [flatOptions, showSearch, searchValue, filterOption]);

    // ---- Dropdown engine (positioning, open/close, click-outside, ESC) ----
    const enginePlacement =
      placement === "top" ? "top" : placement === "bottom" ? "bottom" : "auto";

    const {
      isOpen: currentPopupVisible,
      triggerRef,
      panelRef,
      panelPosition,
      toggle,
      close: engineClose,
      setIsOpen: engineSetIsOpen,
    } = useDropdownEngine({
      defaultOpen: defaultPopupVisible,
      open: popupVisible,
      onOpenChange: (open) => {
        onVisibleChange?.(open);
        if (!open) {
          setSearchValue("");
          resetHighlight();
        }
      },
      disabled,
      gap: DROPDOWN_PANEL.triggerGapTight,
      placement: enginePlacement,
      align: dropdownAlign,
      // Select owns its own keyboard navigation via `useDropdownKeyboard`
      // (typed against the option list, integrates with search filtering
      // and the explicit `highlightedIndex` prop of `DropdownOptionsRenderer`).
      // Opt out of the engine's DOM auto-discover fallback so the two
      // handlers don't both swallow ArrowDown.
      autoKeyboardNavigation: false,
    });

    // ---- Option select handler (wraps value handler + close) ----
    const handleOptionSelect = useCallback(
      (option: DropdownOption) => {
        const shouldClose = handleValueSelect(option);
        if (shouldClose) {
          engineClose();
        }
      },
      [handleValueSelect, engineClose]
    );

    // ---- Keyboard navigation ----
    const {
      highlightedIndex,
      keyboardNavigated,
      handleKeyDown,
      resetHighlight,
      getOptionMouseEnterProps,
    } = useDropdownKeyboard({
      options: filteredOptions,
      isOpen: currentPopupVisible,
      onSelect: handleOptionSelect,
      onOpen: () => engineSetIsOpen(true),
      onClose: () => engineClose(),
    });

    // ---- Search change handler ----
    const handleSearchChange = useCallback(
      (val: string) => {
        setSearchValue(val);
        resetHighlight();
        onSearch?.(val);
      },
      [resetHighlight, onSearch]
    );

    // ---- Trigger rendering ----
    const renderValue = () => {
      if (isMultiple) {
        const selected = selectedOptions as SelectOption[];
        if (selected.length === 0) {
          return (
            <span className="select-placeholder">{resolvedPlaceholder}</span>
          );
        }

        const visibleTags = selected.slice(0, maxTagCount);
        const remainingCount = selected.length - maxTagCount;

        return (
          <div className="select-tags">
            {visibleTags.map((opt) => (
              <span key={opt.value} className="select-tag">
                {opt.label}
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  data-icon="x"
                  size={DROPDOWN_ITEM.iconSize}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleOptionSelect(opt);
                  }}
                  className="cursor-pointer"
                />
              </span>
            ))}
            {remainingCount > 0 && (
              <span className="select-tag-more">+{remainingCount}</span>
            )}
          </div>
        );
      } else {
        const selected = selectedOptions as SelectOption | undefined;
        if (!selected) {
          return (
            <span className="select-placeholder">{resolvedPlaceholder}</span>
          );
        }
        const displayLabel = selected.triggerLabel ?? selected.label;
        if (!showTriggerIcon || !selected.icon) {
          return <span className="select-value">{displayLabel}</span>;
        }
        return (
          <span className="select-value inline-flex items-center gap-2">
            <span className="flex shrink-0 items-center text-text-1">
              {selected.icon}
            </span>
            <span className="min-w-0 truncate">{displayLabel}</span>
          </span>
        );
      }
    };

    const showClearButton =
      allowClear &&
      !disabled &&
      ((isMultiple && (currentValue as (string | number)[]).length > 0) ||
        (!isMultiple && currentValue));

    const radiusClass = RADIUS_CLASS_MAP[radius];

    const wrapperClasses = [
      "select-wrapper",
      `select-size-${size}`,
      appearance !== "default" && `select-${appearance}`,
      error && "select-error",
      disabled && "select-disabled",
      currentPopupVisible && "select-open",
      isDark && "select-dark",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    // ---- Panel width style ----
    const panelWidthStyle = useMemo(() => {
      const width = panelPosition.width;
      if (dropdownWidthMode === "match" && width > 0) {
        return { width: `${width}px` };
      }
      if (dropdownWidthMode === "min-match" && width > 0) {
        return { minWidth: `${width}px` };
      }
      return { width: "max-content" as const };
    }, [dropdownWidthMode, panelPosition.width]);

    // ---- Panel position style ----
    // The engine owns flip side, viewport clamping, and the available-height
    // cap; width is layered on top because Select has its own width modes.
    const panelPositionStyle = useMemo(
      () => ({
        ...getDropdownPanelStyle(panelPosition, {
          widthMode: "none",
          maxHeightCap: DROPDOWN_PANEL.maxHeight,
        }),
        ...panelWidthStyle,
        ...(dropdownWidth ? { width: `${dropdownWidth}px` } : {}),
        ...(dropdownMinWidth ? { minWidth: `${dropdownMinWidth}px` } : {}),
        ...(panelZIndex !== undefined ? { zIndex: panelZIndex } : {}),
      }),
      [
        panelPosition,
        panelWidthStyle,
        dropdownWidth,
        dropdownMinWidth,
        panelZIndex,
      ]
    );

    return (
      <div ref={ref} style={style}>
        <div
          ref={triggerRef}
          className={wrapperClasses}
          data-testid={dataTestId}
          role="combobox"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={currentPopupVisible}
          onClick={toggle}
          onKeyDown={handleKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          tabIndex={disabled ? -1 : 0}
        >
          <div
            className={`select-selector ${radiusClass} ${
              appearance !== "default"
                ? ""
                : "border border-solid border-border-2 bg-bg-2"
            } ${selectorClassName}`}
          >
            {prefix && <span className="select-prefix">{prefix}</span>}
            {renderValue()}
            <div className="select-suffix">
              {loading && (
                <HugeiconsIcon
                  icon={Loading03Icon}
                  data-icon="loader-2"
                  size={SPINNER_TOKENS.default}
                  className="animate-spin"
                />
              )}
              {showClearButton && !loading && (
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  data-icon="x"
                  size={DROPDOWN_ITEM.iconSize}
                  className="select-clear cursor-pointer"
                  onClick={handleClear}
                />
              )}
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                data-icon="chevron-down"
                size={appearance === "ghost" ? 12 : 16}
                className={`select-arrow shrink-0 transition-transform ${
                  appearance === "ghost" ? "text-text-3" : ""
                } ${currentPopupVisible ? "rotate-180" : ""}`}
              />
            </div>
          </div>
        </div>

        {currentPopupVisible &&
          createPortal(
            <div
              ref={panelRef}
              className={`fixed flex flex-col ${DROPDOWN_PANEL.maxHeightClass} ${DROPDOWN_CLASSES.panelAnimated}`}
              style={panelPositionStyle}
            >
              {showSearch && (
                <DropdownSearch
                  type="text"
                  value={searchValue}
                  onChange={handleSearchChange}
                  onKeyDown={handleKeyDown}
                  placeholder={t("common:actions.search")}
                  autoFocus
                />
              )}
              <DropdownOptionsRenderer
                options={filteredOptions}
                value={currentValue}
                mode={mode}
                highlightedIndex={highlightedIndex}
                keyboardNavigated={keyboardNavigated}
                onSelect={handleOptionSelect}
                getOptionMouseEnterProps={getOptionMouseEnterProps}
                loading={loading}
                dropdownRender={dropdownRender}
              />
            </div>,
            getPopupContainer ? getPopupContainer() : document.body
          )}
      </div>
    );
  }
);

Select.displayName = "Select";

export default Select;
