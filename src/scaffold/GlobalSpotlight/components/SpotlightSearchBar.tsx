/**
 * SpotlightSearchBar Component
 *
 * Search bar with action/value pills and a contextual input placeholder.
 * Backspace removes segments.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import { ArrowLeft01Icon, HugeiconsIcon } from "@src/icons";

import { ICONS } from "../config";
import { SPOTLIGHT_CLASSES, SPOTLIGHT_TOKENS } from "../constants";
import type { PathSegment } from "../types";

// ============ PROPS ============

export interface SpotlightSearchBarProps {
  /** Ref for the input element */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Current search query */
  searchQuery: string;
  /** Handler for search query changes */
  onSearchQueryChange: (value: string) => void;
  /** Handler for keyboard events */
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Placeholder text */
  placeholder: string;
  /** Accessible name when the visible placeholder is insufficient. */
  ariaLabel?: string;
  /** Whether data is loading */
  isLoading?: boolean;
  /** Whether countdown is active */
  isCountingDown?: boolean;
  /** The navigation path (breadcrumb) */
  path: PathSegment[];
  /** Handler to remove a specific segment */
  onRemoveSegment?: (index: number) => void;
  /** Whether to hide the close button on the action segment */
  hideActionClose?: boolean;
  /** Whether to hide the trailing text input after path pills */
  hideInput?: boolean;
  /** Shown inside the search row before the input, replacing path pills. */
  leadingSlot?: React.ReactNode;
  /** Shown inside the search row on the right */
  trailingSlot?: React.ReactNode;
}

// ============ COMPONENT ============

export const SpotlightSearchBar: React.FC<SpotlightSearchBarProps> = ({
  inputRef,
  searchQuery,
  onSearchQueryChange,
  onKeyDown,
  placeholder,
  ariaLabel,
  isLoading: _isLoading = false,
  isCountingDown = false,
  path,
  onRemoveSegment,
  hideActionClose = false,
  hideInput = false,
  leadingSlot,
  trailingSlot,
}) => {
  const { t } = useTranslation();

  const hasPills = path.length > 0;
  const hasLeadingSlot = Boolean(leadingSlot);

  const getSegmentLabel = (segment: PathSegment): string => {
    const data = segment.data as
      | { labelKey?: string; pillLabelKey?: string }
      | undefined;
    if (data?.pillLabelKey) return t(data.pillLabelKey);
    if (data?.labelKey) return t(data.labelKey);
    return segment.label;
  };

  const handlePillRemove = (
    index: number,
    event?: React.MouseEvent<HTMLElement>
  ) => {
    event?.preventDefault();
    event?.stopPropagation();
    onRemoveSegment?.(index);
  };

  const handleResetSearch = () => {
    onSearchQueryChange("");
    inputRef.current?.focus();
  };

  const renderBackChevron = () => (
    <HugeiconsIcon
      icon={ArrowLeft01Icon}
      data-icon="chevron-left"
      size={13}
      strokeWidth={2.5}
      className="shrink-0"
    />
  );

  // AnyIcon resolves every shape a segment can carry: `""` (deliberate
  // no-icon), a brand-mark component (including forwardRef/memo wrappers,
  // which `typeof === "function"` misses), and hugeicons glyph data — which a
  // hand-rolled switch here used to drop entirely, leaving pills iconless.
  const renderPillIcon = (segment: PathSegment) => (
    <AnyIcon icon={segment.icon} size={14} className="text-primary-6" />
  );

  return (
    <div>
      <div className="spotlight-search-bar flex h-[56px] min-h-[56px] items-center gap-2 px-4">
        {hasLeadingSlot ? (
          <div className="flex flex-shrink-0 items-center">{leadingSlot}</div>
        ) : !hasPills ? (
          <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center">
            <AnyIcon
              icon={ICONS.search}
              size={SPOTLIGHT_TOKENS.iconSize}
              className="text-text-2"
              data-icon="search"
            />
          </div>
        ) : null}

        {!hasLeadingSlot && hasPills && (
          <div
            className={`flex min-w-0 flex-shrink-0 items-center gap-2 ${SPOTLIGHT_TOKENS.inputFontSize} text-text-1`}
          >
            {path.map((segment, index) => {
              const canRemove =
                !!onRemoveSegment &&
                (segment.type !== "action" || !hideActionClose);
              const label = getSegmentLabel(segment);
              return (
                <div
                  key={`${segment.type}-${segment.id}`}
                  className={`${SPOTLIGHT_CLASSES.primaryPill} ${canRemove ? "cursor-pointer" : ""}`}
                  onClick={
                    canRemove
                      ? (event) => handlePillRemove(index, event)
                      : undefined
                  }
                  title={label}
                >
                  {canRemove && !isCountingDown && renderBackChevron()}
                  {!canRemove && renderPillIcon(segment)}
                  <span
                    className={`max-w-[220px] truncate ${SPOTLIGHT_TOKENS.inputFontSize}`}
                  >
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {!hideInput && (
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label={ariaLabel}
            className={`min-w-0 flex-1 bg-transparent ${SPOTLIGHT_TOKENS.inputFontSize} text-text-1 placeholder:text-text-1 focus:outline-none`}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-spotlight-input="true"
          />
        )}

        {!hideInput && searchQuery && !isCountingDown && (
          <button
            type="button"
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
            aria-label={t("common:actions.clearSearch")}
            onClick={handleResetSearch}
          >
            <HugeiconsIcon icon={ICONS.close} size={14} />
          </button>
        )}

        {trailingSlot ? (
          <div className="flex flex-shrink-0 items-center">{trailingSlot}</div>
        ) : null}
      </div>
    </div>
  );
};

export default SpotlightSearchBar;
