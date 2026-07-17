/**
 * SelectionGrid Component
 *
 * The selection grid used across all wizards.
 * Renders a responsive grid of ActionCards.
 *
 * Supports two selection modes:
 * - **Single-select** (default): radio-style, one option at a time
 * - **Multi-select** (`multiSelect`): checkbox-style, toggle multiple options
 *
 * Also supports an optional compact mode (inline label + "Switch method" button)
 * used when an embedded browser is open (e.g. CursorSetup, CopilotSetup).
 *
 * @example
 * ```tsx
 * // Single-select (radio)
 * <SelectionGrid
 *   options={[
 *     { key: "telegram", label: "Telegram", icon: MessageCircle },
 *     { key: "discord", label: "Discord", icon: Hash },
 *   ]}
 *   selected={selectedType}
 *   onSelect={setSelectedType}
 * />
 *
 * // Multi-select (checkbox)
 * <SelectionGrid
 *   multiSelect
 *   options={languageOptions}
 *   selected={selectedLanguages}
 *   onToggle={handleToggleLanguage}
 * />
 * ```
 */
import type { LucideIcon } from "lucide-react";
import React from "react";

import ActionCard from "@src/components/ActionCard";
import type { ActionCardVariant } from "@src/components/ActionCard/types";
import Button from "@src/components/Button";

// ============================================
// Types
// ============================================

export interface SelectionGridOption<T extends string = string> {
  /** Unique key used for selection state */
  key: T;
  /** Display label */
  label: string;
  /** Lucide icon component */
  icon?: LucideIcon;
  /** Custom icon element (takes precedence over icon) */
  iconElement?: React.ReactNode;
  /** Keep icon color unchanged when selected (e.g. brand icons like GitHub) */
  iconPreserveColor?: boolean;
  /** Optional description shown below the label */
  description?: string;
  /** Optional tooltip (shown via info icon; use instead of description for compact single-line cards) */
  tooltip?: string;
  /** Disable this option (greyed out, not clickable) */
  disabled?: boolean;
  /** Badge text shown next to the label (e.g. "Recommended") */
  badge?: string;
  /** Stable test id for this option's card (defaults to selection-grid-option-<key>) */
  dataTestId?: string;
}

/** Props shared by both selection modes */
interface SharedGridProps<T extends string = string> {
  /** Options to display */
  options: SelectionGridOption<T>[];
  /** Minimum width for grid columns (default 180px). Ignored when columns is set. */
  columnMinWidth?: number;
  /** Fixed number of columns — each option fills equal width. */
  columns?: number;
  /** Compact mode — shows inline label + "Switch method" button instead of grid. */
  compact?: boolean;
  /** Label shown in compact mode (defaults to selected option label). */
  compactLabel?: string;
  /** ActionCard variant. Use "subtle" for bg-bg-2 cards when placed on fill-2 backgrounds. */
  cardVariant?: ActionCardVariant;
  /** When using showSelect on cards, show the trailing checkmark (default true). */
  showSelectionCheck?: boolean;
  /** Use compact card padding, useful for text-only picker cards. */
  compactCards?: boolean;
}

/** Single-select mode (default) — radio-style */
interface SingleSelectGridProps<
  T extends string = string,
> extends SharedGridProps<T> {
  multiSelect?: false;
  /** Currently selected key (null = none) */
  selected: T | null;
  /** Selection handler — receives the clicked key */
  onSelect: (key: T) => void;
  onToggle?: never;
}

/** Multi-select mode — checkbox-style */
interface MultiSelectGridProps<
  T extends string = string,
> extends SharedGridProps<T> {
  multiSelect: true;
  /** Set of currently selected keys */
  selected: Set<T>;
  /** Toggle handler — receives the clicked key */
  onToggle: (key: T) => void;
  onSelect?: never;
}

export type SelectionGridProps<T extends string = string> =
  | SingleSelectGridProps<T>
  | MultiSelectGridProps<T>;

// ============================================
// Component
// ============================================

function SelectionGrid<T extends string = string>(
  props: SelectionGridProps<T>
) {
  const {
    options,
    selected,
    columnMinWidth = 180,
    columns,
    compact = false,
    compactLabel,
    cardVariant = "default",
    showSelectionCheck = true,
    compactCards = false,
  } = props;

  const isMulti = props.multiSelect === true;

  // Compact mode (single-select only)
  if (compact && !isMulti) {
    const singleSelected = selected as T | null;
    const selectedOption = options.find((opt) => opt.key === singleSelected);
    const label = compactLabel || selectedOption?.label || "";
    const nextOption = options.find((opt) => opt.key !== singleSelected);

    return (
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-[12px] font-medium text-text-1">{label}</span>
        {nextOption && (
          <Button
            variant="tertiary"
            size="mini"
            onClick={() =>
              (props as SingleSelectGridProps<T>).onSelect(nextOption.key)
            }
          >
            Switch method
          </Button>
        )}
      </div>
    );
  }

  const gridStyle =
    columns != null
      ? { gridTemplateColumns: `repeat(${columns}, 1fr)` }
      : {
          gridTemplateColumns: `repeat(auto-fill, minmax(${columnMinWidth}px, 1fr))`,
        };

  return (
    <div className="grid w-full gap-2" style={gridStyle}>
      {options.map((option) => {
        const isSelected = isMulti
          ? (selected as Set<T>).has(option.key)
          : selected === option.key;

        const handleClick = () => {
          if (isMulti) {
            (props as MultiSelectGridProps<T>).onToggle(option.key);
          } else {
            (props as SingleSelectGridProps<T>).onSelect(option.key);
          }
        };

        return (
          <ActionCard
            key={option.key}
            title={option.label}
            description={option.description}
            tooltip={option.tooltip}
            badge={option.badge}
            onClick={handleClick}
            icon={option.icon}
            iconElement={option.iconElement}
            iconPreserveColor={option.iconPreserveColor}
            showSelect
            showSelectionCheck={showSelectionCheck}
            selected={isSelected}
            disabled={option.disabled}
            variant={cardVariant}
            compact={compactCards}
            dataTestId={
              option.dataTestId ?? `selection-grid-option-${option.key}`
            }
          />
        );
      })}
    </div>
  );
}

export default SelectionGrid;
