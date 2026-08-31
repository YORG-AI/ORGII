/**
 * SearchInput Component
 *
 * VSCode-style find input with options inline.
 * Supports two variants:
 * - "panel": For in-editor search (with border, navigation arrows)
 * - "sidebar": For sidebar search (borderless, minimal style)
 *
 * Single-line <input> uses inline styles with line-height equal to row height (28px)
 * so text aligns with prefix icons; see searchControlInputStyles.ts.
 *
 * [chevron] [Search icon] [input] [Aa] [ab] [o*] [book] [↑] [↓]
 */
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import {
  HEADER_BUTTON,
  HEADER_ICON_SIZE,
} from "@src/config/workstation/tokens";
import { useTauriSelectAllShortcut } from "@src/hooks/keyboard";
import {
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowRight01Icon,
  ArrowUp02Icon,
  BookOpen01Icon,
  Cancel01Icon,
  CaseSensitiveIcon,
  HugeiconsIcon,
  RegexIcon,
  WholeWordIcon,
} from "@src/icons";

import {
  SEARCH_WRAPPER_PANEL,
  SEARCH_WRAPPER_PANE_INPUT,
  SEARCH_WRAPPER_SIDEBAR,
  searchControlSingleLineInputStyle,
  searchWrapperMultiline,
} from "./searchControlInputStyles";

// ============================================
// Types
// ============================================

export type SearchInputVariant = "panel" | "sidebar";
export type SearchInputSize = "sm" | "md";
export type SearchInputSurface = "default" | "pane" | "transparent";

export interface SearchInputProps {
  /** Current search query value */
  value: string;
  /** Callback when value changes */
  onChange: (value: string) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Accessible name when the surrounding surface has no visible label. */
  ariaLabel?: string;
  /** Visual variant: "panel" (editor search) or "sidebar" (global search) */
  variant?: SearchInputVariant;
  /** Height size — both map to 28px (tree row standard). Kept for API compatibility. */
  size?: SearchInputSize;
  /** Background surface token for the input box. */
  surface?: SearchInputSurface;
  /** Search options */
  caseSensitive?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
  onlyOpenFiles?: boolean;
  /** Option toggle callbacks */
  onCaseSensitiveToggle?: () => void;
  onWholeWordToggle?: () => void;
  onRegexToggle?: () => void;
  onOnlyOpenFilesToggle?: () => void;
  /** Navigation callbacks (optional - for in-file search) */
  onPrevious?: () => void;
  onNext?: () => void;
  /** Expand/collapse replace */
  expanded?: boolean;
  onExpandToggle?: () => void;
  /** Close button callback (optional - for sidebar variant) */
  onClose?: () => void;
  /** Input ref - supports both input and textarea */
  inputRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  /** Custom class name */
  className?: string;
  /** Enable multiline input (uses textarea instead of input) */
  multiline?: boolean;
  /** Hide the chevron toggle button (for external layout control) */
  hideChevron?: boolean;
  /** Callback when Enter is pressed (prevents newline insertion in multiline mode) */
  onSubmit?: () => void;
  /** Show clear button when input has value */
  showClearButton?: boolean;
  /** Optional clear handler (defaults to onChange("")) */
  onClear?: () => void;
  /** Extra class name applied to the input box itself (not the outer container) */
  inputBoxClassName?: string;
}

// ============================================
// Component
// ============================================

export const SearchInput: React.FC<SearchInputProps> = memo(
  ({
    value,
    onChange,
    placeholder = "Find",
    ariaLabel,
    variant = "panel",
    size: _size = "sm",
    surface = "default",
    caseSensitive = false,
    wholeWord = false,
    useRegex = false,
    onlyOpenFiles = false,
    onCaseSensitiveToggle,
    onWholeWordToggle,
    onRegexToggle,
    onOnlyOpenFilesToggle,
    onPrevious,
    onNext,
    expanded = false,
    onExpandToggle,
    onClose,
    inputRef,
    className = "",
    multiline = false,
    hideChevron = false,
    onSubmit,
    showClearButton = false,
    onClear,
    inputBoxClassName = "",
  }) => {
    const { t } = useTranslation();
    const handleChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        onChange(event.target.value);
      },
      [onChange]
    );

    const tauriSelectAll = useTauriSelectAllShortcut();

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onSubmit?.();
          return;
        }
        tauriSelectAll(event);
      },
      [onSubmit, tauriSelectAll]
    );

    const handleClear = useCallback(() => {
      if (onClear) {
        onClear();
        return;
      }
      onChange("");
    }, [onChange, onClear]);

    const handleTextareaResize = useCallback(
      (textarea: HTMLTextAreaElement | null) => {
        if (textarea) {
          textarea.style.height = "auto";
          textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
        }
      },
      []
    );

    React.useEffect(() => {
      if (multiline && inputRef?.current instanceof HTMLTextAreaElement) {
        handleTextareaResize(inputRef.current);
      }
    }, [value, multiline, inputRef, handleTextareaResize]);

    const isSidebar = variant === "sidebar";

    const containerClass = isSidebar
      ? "flex items-center gap-2.5"
      : "flex items-center gap-3";

    // Single wrapper div — Tailwind for layout, .input SCSS class on the <input> for centering
    const inputWrapperClass = isSidebar
      ? SEARCH_WRAPPER_SIDEBAR
      : SEARCH_WRAPPER_PANEL;
    const inputWrapperSurfaceClass =
      surface === "pane"
        ? `${inputWrapperClass} ${SEARCH_WRAPPER_PANE_INPUT}`
        : surface === "transparent"
          ? `${inputWrapperClass} !bg-transparent`
          : inputWrapperClass;
    const inputWrapperMultilineClass = multiline
      ? searchWrapperMultiline(inputWrapperSurfaceClass)
      : inputWrapperSurfaceClass;

    const buttonClass = isSidebar
      ? "flex items-center justify-center rounded text-text-3 transition-colors hover:bg-fill-1"
      : "flex items-center justify-center rounded p-1 text-text-3 transition-colors hover:bg-fill-1";

    const actionButtonClass = HEADER_BUTTON.action;
    const iconSize = HEADER_ICON_SIZE.sm;

    return (
      <div className={`${containerClass} ${className}`}>
        {/* Expand/collapse chevron */}
        {onExpandToggle && !hideChevron && (
          <div onClick={onExpandToggle} className={buttonClass}>
            {expanded ? (
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                data-icon="chevron-down"
                size={iconSize}
              />
            ) : (
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={iconSize}
              />
            )}
          </div>
        )}

        {/* Search input with inline options */}
        <div
          className={`${inputWrapperMultilineClass} ${multiline ? "items-start" : ""} ${inputBoxClassName}`}
          data-action="search.codebase"
        >
          {multiline ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              aria-label={ariaLabel}
              style={{
                ...searchControlSingleLineInputStyle(14),
                height: "auto",
                lineHeight: 1.4,
                resize: "none",
              }}
              className="min-w-0 flex-1 text-text-1 placeholder:text-text-3"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              rows={1}
              onInput={(event) =>
                handleTextareaResize(event.target as HTMLTextAreaElement)
              }
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              aria-label={ariaLabel}
              style={searchControlSingleLineInputStyle(14)}
              className="min-w-0 flex-1 text-text-1 placeholder:text-text-3"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          )}
          {showClearButton && value && (
            <button
              type="button"
              onClick={handleClear}
              className="flex shrink-0 items-center justify-center self-center rounded p-0.5 text-text-3 transition-colors hover:text-text-2"
              title={t("tooltips.clearSearch")}
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                data-icon="x"
                size={iconSize}
              />
            </button>
          )}

          {onCaseSensitiveToggle && (
            <button
              type="button"
              onClick={onCaseSensitiveToggle}
              className={`flex shrink-0 items-center justify-center self-center rounded p-0.5 transition-colors ${
                caseSensitive
                  ? "text-primary-6 hover:text-primary-5"
                  : "text-text-2 hover:text-text-1"
              }`}
              title={t("tooltips.matchCase")}
            >
              <HugeiconsIcon
                icon={CaseSensitiveIcon}
                data-icon="case-sensitive"
                size={iconSize}
              />
            </button>
          )}
          {onWholeWordToggle && (
            <button
              type="button"
              onClick={onWholeWordToggle}
              className={`flex shrink-0 items-center justify-center self-center rounded p-0.5 transition-colors ${
                wholeWord
                  ? "text-primary-6 hover:text-primary-5"
                  : "text-text-2 hover:text-text-1"
              }`}
              title={t("tooltips.matchWholeWord")}
            >
              <HugeiconsIcon
                icon={WholeWordIcon}
                data-icon="whole-word"
                size={iconSize}
              />
            </button>
          )}
          {onRegexToggle && (
            <button
              type="button"
              onClick={onRegexToggle}
              className={`flex shrink-0 items-center justify-center self-center rounded p-0.5 transition-colors ${
                useRegex
                  ? "text-primary-6 hover:text-primary-5"
                  : "text-text-2 hover:text-text-1"
              }`}
              title={t("tooltips.useRegex")}
            >
              <HugeiconsIcon
                icon={RegexIcon}
                data-icon="regex"
                size={iconSize}
              />
            </button>
          )}
          {onOnlyOpenFilesToggle && (
            <button
              type="button"
              onClick={onOnlyOpenFilesToggle}
              className={`flex shrink-0 items-center justify-center self-center rounded p-0.5 transition-colors ${
                onlyOpenFiles
                  ? "text-primary-6 hover:text-primary-5"
                  : "text-text-2 hover:text-text-1"
              }`}
              title={t("tooltips.searchInOpenEditors")}
            >
              <HugeiconsIcon
                icon={BookOpen01Icon}
                data-icon="book-open"
                size={iconSize}
              />
            </button>
          )}
        </div>

        {/* Navigation arrows — up/down grouped, close separate */}
        {(onPrevious || onNext) && (
          <div className="flex items-center gap-1.5">
            {onPrevious && (
              <button
                type="button"
                onClick={onPrevious}
                className={actionButtonClass}
                title={t("tooltips.previousMatch")}
              >
                <HugeiconsIcon
                  icon={ArrowUp02Icon}
                  data-icon="arrow-up"
                  size={iconSize}
                />
              </button>
            )}
            {onNext && (
              <button
                type="button"
                onClick={onNext}
                className={actionButtonClass}
                title={t("tooltips.nextMatch")}
              >
                <HugeiconsIcon
                  icon={ArrowDown02Icon}
                  data-icon="arrow-down"
                  size={iconSize}
                />
              </button>
            )}
          </div>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className={actionButtonClass}
            title={t("tooltips.closeEsc")}
          >
            <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={iconSize} />
          </button>
        )}
      </div>
    );
  }
);

SearchInput.displayName = "SearchInput";

export default SearchInput;
