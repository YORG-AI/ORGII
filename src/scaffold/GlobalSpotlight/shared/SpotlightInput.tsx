/**
 * Shared Spotlight Input Component
 *
 * Reusable search input for spotlight interfaces
 */
import { Search, X } from "lucide-react";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { useTauriSelectAllShortcut } from "@src/hooks/keyboard";

import { SPOTLIGHT_TOKENS } from "../constants";

export interface SpotlightInputProps {
  /** Input ref for focus management */
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** Current search value */
  value: string;
  /** Change handler */
  onChange: (value: string) => void;
  /** Accessible name when the visible placeholder is insufficient. */
  ariaLabel?: string;
  /** Keydown handler */
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Loading state */
  isLoading?: boolean;
  /** Icon to display (defaults to Search) */
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  /** Custom icon element (overrides icon prop) */
  iconElement?: React.ReactNode;
  /** Renders at the end of the search row (e.g. mode badge); stays in the 56px bar */
  trailingSlot?: React.ReactNode;
  /** Auto focus on mount */
  autoFocus?: boolean;
}

export const SpotlightInput: React.FC<SpotlightInputProps> = ({
  inputRef,
  value,
  onChange,
  ariaLabel,
  onKeyDown,
  placeholder = "Search...",
  isLoading: _isLoading = false,
  icon: IconComponent = Search,
  iconElement,
  trailingSlot,
  autoFocus = true,
}) => {
  const { t } = useTranslation();
  const tauriSelectAll = useTauriSelectAllShortcut();

  const handleResetSearch = () => {
    onChange("");
    inputRef?.current?.focus();
  };

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(event);
      tauriSelectAll(event);
    },
    [onKeyDown, tauriSelectAll]
  );

  return (
    <div>
      <div className="flex h-[56px] min-h-[56px] items-center gap-2 px-4">
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center">
          {iconElement ? (
            iconElement
          ) : (
            <IconComponent
              size={SPOTLIGHT_TOKENS.iconSize}
              className="text-text-2"
            />
          )}
        </div>

        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={`min-w-0 flex-1 bg-transparent ${SPOTLIGHT_TOKENS.inputFontSize} text-text-1 outline-none placeholder:text-text-2`}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck="false"
          data-spotlight-input="true"
          data-action="file.open"
        />

        {trailingSlot ? (
          <div className="flex flex-shrink-0 items-center">{trailingSlot}</div>
        ) : null}

        {value ? (
          <button
            type="button"
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
            aria-label={t("common:actions.clearSearch")}
            onClick={handleResetSearch}
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
    </div>
  );
};

export default SpotlightInput;
