/**
 * ReplaceInput Component
 *
 * VSCode-style replace input with action buttons.
 * Supports two variants matching SearchInput:
 * - "panel": For in-editor search (with border, larger)
 * - "sidebar": For sidebar search (borderless, minimal style)
 *
 * Single-line <input> uses searchControlSingleLineInputStyle (line-height = row height).
 *
 * [Replace icon] [input] [replace] [replace all]
 */
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import type {
  SearchInputSurface,
  SearchInputVariant,
} from "@src/components/SearchInput";
import {
  SEARCH_WRAPPER_PANEL,
  SEARCH_WRAPPER_PANE_INPUT,
  SEARCH_WRAPPER_SIDEBAR,
  searchControlSingleLineInputStyle,
  searchWrapperMultiline,
} from "@src/components/SearchInput/searchControlInputStyles";
import { HugeiconsIcon, ReplaceAllIcon, ReplaceIcon } from "@src/icons";
import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";

// ============================================
// Types
// ============================================

export interface ReplaceInputProps {
  /** Current replace value */
  value: string;
  /** Callback when value changes */
  onChange: (value: string) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Visual variant: "panel" (editor search) or "sidebar" (global search) */
  variant?: SearchInputVariant;
  /** Background surface token for the input box. */
  surface?: SearchInputSurface;
  /** Callback for replace single (optional - for in-file search) */
  onReplace?: () => void;
  /** Callback for replace all */
  onReplaceAll?: () => void;
  /** Whether buttons are disabled */
  disabled?: boolean;
  /** Input ref - supports both input and textarea */
  inputRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement>;
  /** Custom class name */
  className?: string;
  /** Enable multiline input (uses textarea instead of input) */
  multiline?: boolean;
  /** Hide the spacer (for external layout control where chevron is separate) */
  hideSpacer?: boolean;
  /** Callback when Enter is pressed (prevents newline insertion in multiline mode) */
  onSubmit?: () => void;
  /** Extra class name applied to the input box itself (not the outer container) */
  inputBoxClassName?: string;
}

// ============================================
// Component
// ============================================

export const ReplaceInput: React.FC<ReplaceInputProps> = memo(
  ({
    value,
    onChange,
    placeholder = "Replace",
    variant = "panel",
    surface = "default",
    onReplace,
    onReplaceAll,
    disabled = false,
    inputRef,
    className = "",
    multiline = false,
    hideSpacer = false,
    onSubmit,
    inputBoxClassName = "",
  }) => {
    const { t } = useTranslation();
    const handleChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        onChange(event.target.value);
      },
      [onChange]
    );

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onSubmit?.();
        }
      },
      [onSubmit]
    );

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

    const inputWrapperClass = isSidebar
      ? SEARCH_WRAPPER_SIDEBAR
      : SEARCH_WRAPPER_PANEL;
    const inputWrapperSurfaceClass =
      surface === "pane"
        ? `${inputWrapperClass} ${SEARCH_WRAPPER_PANE_INPUT}`
        : inputWrapperClass;
    const inputWrapperMultilineClass = multiline
      ? searchWrapperMultiline(inputWrapperSurfaceClass)
      : inputWrapperSurfaceClass;

    const actionButtonClass = `${HEADER_BUTTON.action} disabled:cursor-not-allowed disabled:opacity-50`;

    const spacerWidth = isSidebar ? "w-[17px]" : "w-[22px]";
    const iconSize = 14;

    return (
      <div className={`${containerClass} ${className}`}>
        {!hideSpacer && <div className={spacerWidth} />}

        <div
          className={`${inputWrapperMultilineClass} ${multiline ? "items-start" : ""} ${inputBoxClassName}`}
        >
          {multiline ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
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
              style={searchControlSingleLineInputStyle(14)}
              className="min-w-0 flex-1 text-text-1 placeholder:text-text-3"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          )}
        </div>

        {onReplace && (
          <button
            onClick={onReplace}
            disabled={disabled}
            className={actionButtonClass}
            title={t("tooltips.replace")}
          >
            <HugeiconsIcon
              icon={ReplaceIcon}
              data-icon="replace"
              size={iconSize}
            />
          </button>
        )}
        {onReplaceAll && (
          <button
            onClick={onReplaceAll}
            disabled={disabled}
            className={actionButtonClass}
            title={t("tooltips.replaceAll")}
          >
            <HugeiconsIcon
              icon={ReplaceAllIcon}
              data-icon="replace-all"
              size={iconSize}
            />
          </button>
        )}
      </div>
    );
  }
);

ReplaceInput.displayName = "ReplaceInput";

export default ReplaceInput;
