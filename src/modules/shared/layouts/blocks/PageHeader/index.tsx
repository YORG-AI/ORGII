/**
 * PageHeader Component
 *
 * Reusable header for pages with multiple variants:
 * - "default": Title with optional icon and actions
 * - "search": URL-bar style centered search input
 *
 * Height: 40px (matches PanelHeader)
 * No bottom border by default
 */
import type { FC, KeyboardEvent, ReactNode } from "react";
import { memo, useRef, useState } from "react";

import AnyIcon from "@src/components/AnyIcon";
import {
  Cancel01Icon,
  HugeiconsIcon,
  type IconSvgElement,
  Search01Icon,
} from "@src/icons";

// ============================================
// Types
// ============================================

interface BaseProps {
  /** Additional className */
  className?: string;
  /** Show bottom border (default: false) */
  showBorder?: boolean;
  /** Left side content (e.g., back button) */
  leftContent?: ReactNode;
  /** Right side actions */
  actions?: ReactNode;
}

interface DefaultVariantProps extends BaseProps {
  variant?: "default";
  /** Title text */
  title?: string;
  /** Hugeicons icon data */
  icon?: IconSvgElement;
  /** Subtitle text */
  subtitle?: string;
}

interface SearchVariantProps extends BaseProps {
  variant: "search";
  /** Search query value */
  searchValue: string;
  /** Search value change handler */
  onSearchChange: (value: string) => void;
  /** Placeholder text */
  searchPlaceholder?: string;
  /** Called when Enter is pressed */
  onSearchSubmit?: (value: string) => void;
}

type PageHeaderProps = DefaultVariantProps | SearchVariantProps;

// ============================================
// Search Input Component (URL-bar style)
// ============================================

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onSubmit?: (value: string) => void;
}

const SearchInput: FC<SearchInputProps> = memo(
  ({ value, onChange, placeholder = "Search...", onSubmit }) => {
    const [isFocused, setIsFocused] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const handleFocus = () => {
      setIsFocused(true);
      setTimeout(() => {
        inputRef.current?.select();
      }, 50);
    };

    const handleBlur = () => {
      setIsFocused(false);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" && onSubmit) {
        onSubmit(value);
        inputRef.current?.blur();
      } else if (event.key === "Escape") {
        inputRef.current?.blur();
      }
    };

    const handleClear = () => {
      onChange("");
      inputRef.current?.focus();
    };

    return (
      <div
        className="relative flex h-6 min-w-0 max-w-md flex-1 cursor-text items-center rounded-full bg-fill-2"
        onClick={() => {
          if (!isFocused) {
            inputRef.current?.focus();
          }
        }}
      >
        {/* Centered placeholder when empty and not focused */}
        {!isFocused && !value && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 px-3">
            <HugeiconsIcon
              icon={Search01Icon}
              data-icon="search"
              size={14}
              className="shrink-0 text-text-3"
            />
            <span className="text-xs text-text-3">{placeholder}</span>
          </div>
        )}

        {/* Centered value when not focused */}
        {!isFocused && value && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 px-3">
            <HugeiconsIcon
              icon={Search01Icon}
              data-icon="search"
              size={14}
              className="shrink-0 text-text-3"
            />
            <span className="max-w-[300px] truncate text-xs text-text-1">
              {value}
            </span>
          </div>
        )}

        {/* Icon on left when focused */}
        {isFocused && (
          <div className="absolute left-2.5 flex items-center">
            <HugeiconsIcon
              icon={Search01Icon}
              data-icon="search"
              size={14}
              className="shrink-0 text-text-3"
            />
          </div>
        )}

        {/* Input field */}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={`h-6 min-w-0 flex-1 border-none bg-transparent text-xs text-text-1 outline-none placeholder:text-text-3 ${
            isFocused ? "pl-7 pr-7" : "opacity-0"
          }`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />

        {/* Clear button when has value and not focused */}
        {!isFocused && value && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              handleClear();
            }}
            className="absolute right-1.5 flex items-center justify-center rounded p-0.5 text-text-3 transition-colors hover:text-text-1"
            title="Clear"
          >
            <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={12} />
          </button>
        )}

        {/* Clear button when focused and has value */}
        {isFocused && value && (
          <button
            type="button"
            onMouseDown={(event) => {
              event.preventDefault();
              handleClear();
            }}
            className="absolute right-1.5 flex items-center justify-center rounded p-0.5 text-text-3 transition-colors hover:text-text-1"
            title="Clear"
          >
            <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={12} />
          </button>
        )}
      </div>
    );
  }
);

SearchInput.displayName = "SearchInput";

// ============================================
// Main Component
// ============================================

const PageHeader: FC<PageHeaderProps> = (props) => {
  const { className = "", showBorder = false, leftContent, actions } = props;

  const borderClass = showBorder ? "border-b border-border-2" : "";

  // Search variant - centered layout
  if (props.variant === "search") {
    return (
      <div
        className={`relative flex h-10 flex-shrink-0 items-center justify-center px-4 ${borderClass} ${className}`}
      >
        {/* Left content - absolute positioned */}
        {leftContent && (
          <div className="absolute left-4 flex items-center">{leftContent}</div>
        )}

        {/* Centered search */}
        <SearchInput
          value={props.searchValue}
          onChange={props.onSearchChange}
          placeholder={props.searchPlaceholder}
          onSubmit={props.onSearchSubmit}
        />

        {/* Right side actions - absolute positioned */}
        {actions && (
          <div className="absolute right-4 flex items-center gap-1">
            {actions}
          </div>
        )}
      </div>
    );
  }

  // Default variant
  const { title, icon: IconComponent, subtitle } = props;
  return (
    <div
      className={`flex h-10 flex-shrink-0 items-center gap-3 px-4 ${borderClass} ${className}`}
    >
      {/* Left content (e.g., back button) */}
      {leftContent && (
        <div className="flex flex-shrink-0 items-center">{leftContent}</div>
      )}

      {/* Main content */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {IconComponent && (
          <AnyIcon
            icon={IconComponent}
            size={14}
            className="flex-shrink-0 text-text-2"
          />
        )}
        {title && (
          <span className="truncate text-[13px] font-medium text-text-1">
            {title}
          </span>
        )}
        {subtitle && (
          <>
            <span className="text-text-4">/</span>
            <span className="truncate text-[13px] text-text-2">{subtitle}</span>
          </>
        )}
      </div>

      {/* Right side actions */}
      {actions && (
        <div className="flex flex-shrink-0 items-center gap-1.5">{actions}</div>
      )}
    </div>
  );
};

export default memo(PageHeader);
