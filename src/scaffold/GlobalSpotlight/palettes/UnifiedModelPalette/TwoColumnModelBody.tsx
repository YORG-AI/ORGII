/**
 * TwoColumnModelBody
 *
 * Renders the UnifiedModelPalette content area:
 *
 *   │ Recent Models (full width, no divider)       │
 *   ├─────────────────────────────────────────────┤
 *   │ All Models (full-width header)               │
 *   ├──────────────────────┬──────────────────────┤
 *   │ Choose model (left)  │ Choose key (right)    │
 *   └──────────────────────┴──────────────────────┘
 *
 * The left column (recents + models) is keyboard-driven by the shared
 * selector kernel; `selectedIndex` indexes the flat `items` array. The
 * right column is a manual list keyed by `selectedSourceIndex`.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import { useKeyboardMouseMode } from "@src/hooks/keyboard";

import { SpotlightItemRow } from "../../components/SpotlightItemRow";
import type { SpotlightItem } from "../../types";

// ============ TYPES ============

interface TwoColumnModelBodyProps {
  /** Flat kernel list: [recent header?, recents…, all header, models…]. */
  items: SpotlightItem[];
  /** Kernel cursor over `items`. */
  selectedIndex: number;
  onItemSelect: (item: SpotlightItem, index: number) => void;
  onItemHover: (index: number) => void;
  searchQuery: string;
  activeColumn: "models" | "sources";
  /** Compatible accounts for the focused model (right column). */
  sourceItems: SpotlightItem[];
  selectedSourceIndex: number;
  /** Whether a model row currently owns the left-column cursor. */
  hasFocusedModel: boolean;
  /** Whether the Key Vault account list is currently loading. */
  accountsLoading: boolean;
  /** Key Vault account-list load error. */
  accountsError: string | null;
  /** Retry loading Key Vault accounts after an error. */
  onRetryAccounts: () => void;
  onSourceSelect: (index: number) => void;
  onSourceHover: (index: number) => void;
}

// ============ CONSTANTS ============

const COLUMN_HEIGHT = 260;
const RECENT_MAX_HEIGHT = 220;

// ============ HELPERS ============

function isHeader(item: SpotlightItem): boolean {
  return Boolean((item.data as Record<string, unknown> | undefined)?.isHeader);
}

function getSection(item: SpotlightItem): string | undefined {
  return (item.data as Record<string, unknown> | undefined)?.modelSection as
    | string
    | undefined;
}

// ============ SUB-COMPONENTS ============

/** A vertically-scrolling column of rows that carry their flat-array index. */
const RowColumn: React.FC<{
  rows: { item: SpotlightItem; index: number }[];
  selectedIndex: number;
  isKeyboardMode: boolean;
  searchQuery: string;
  maxHeight: number;
  onSelect: (item: SpotlightItem, index: number) => void;
  onHover: (index: number) => void;
  onMouseMove: (event: React.MouseEvent) => void;
  dataKeyboardMode: string;
}> = ({
  rows,
  selectedIndex,
  isKeyboardMode,
  searchQuery,
  maxHeight,
  onSelect,
  onHover,
  onMouseMove,
  dataKeyboardMode,
}) => (
  <div
    className="spotlight-scrollable overflow-y-auto"
    style={{ maxHeight }}
    onMouseMove={onMouseMove}
    data-keyboard-mode={dataKeyboardMode}
  >
    {rows.map(({ item, index }) => (
      <SpotlightItemRow
        key={item.id}
        item={item}
        selectionState={item.data?.selectionState}
        index={index}
        isSelected={selectedIndex === index}
        isKeyboardMode={isKeyboardMode}
        onSelect={() => onSelect(item, index)}
        onHover={onHover}
        searchQuery={searchQuery}
      />
    ))}
  </div>
);

// ============ MAIN COMPONENT ============

export const TwoColumnModelBody: React.FC<TwoColumnModelBodyProps> = ({
  items,
  selectedIndex,
  onItemSelect,
  onItemHover,
  searchQuery,
  activeColumn,
  sourceItems,
  selectedSourceIndex,
  hasFocusedModel,
  accountsLoading,
  accountsError,
  onRetryAccounts,
  onSourceSelect,
  onSourceHover,
}) => {
  const { t } = useTranslation();
  const { isKeyboardMode, handleMouseMove, dataKeyboardMode } =
    useKeyboardMouseMode();

  // Split the flat list into Recent vs All-Models rows, preserving each
  // row's index into the flat `items` array (kernel cursor space).
  const { recentRows, modelRows, recentHeader, allHeader } = useMemo(() => {
    const recents: { item: SpotlightItem; index: number }[] = [];
    const models: { item: SpotlightItem; index: number }[] = [];
    let recentH: SpotlightItem | null = null;
    let allH: SpotlightItem | null = null;

    items.forEach((item, index) => {
      if (isHeader(item)) {
        if (item.id.endsWith(":recent")) recentH = item;
        else allH = item;
        return;
      }
      if (getSection(item) === "recent") {
        recents.push({ item, index });
      } else {
        models.push({ item, index });
      }
    });

    return {
      recentRows: recents,
      modelRows: models,
      recentHeader: recentH as SpotlightItem | null,
      allHeader: allH as SpotlightItem | null,
    };
  }, [items]);

  const sourcesColumnActive = activeColumn === "sources";
  const hasQuickPickSection = recentRows.length > 0;

  return (
    <div className="flex flex-col">
      {/* ── Recent (full width, one-click) ───────────────────────────── */}
      {hasQuickPickSection && (
        <div className="border-b border-border-1">
          {recentHeader && (
            <div className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-text-3 uppercase">
              {recentHeader.label}
            </div>
          )}
          <RowColumn
            rows={recentRows}
            selectedIndex={selectedIndex}
            isKeyboardMode={isKeyboardMode}
            searchQuery={searchQuery}
            maxHeight={RECENT_MAX_HEIGHT}
            onSelect={onItemSelect}
            onHover={onItemHover}
            onMouseMove={handleMouseMove}
            dataKeyboardMode={dataKeyboardMode}
          />
        </div>
      )}

      {/* ── All Models | Accounts (two columns) ──────────────────────── */}
      {allHeader && (
        <div className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-text-3 uppercase">
          {allHeader.label}
        </div>
      )}
      <div className="flex items-stretch">
        {/* Left: models */}
        <div className="flex w-2/5 flex-col">
          <div className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-text-3 uppercase">
            {`Step 1 - ${t("selectors.modelSelector.chooseModel")}`}
          </div>
          {modelRows.length > 0 ? (
            <RowColumn
              rows={modelRows}
              selectedIndex={selectedIndex}
              isKeyboardMode={isKeyboardMode}
              searchQuery={searchQuery}
              maxHeight={COLUMN_HEIGHT}
              onSelect={onItemSelect}
              onHover={() => undefined}
              onMouseMove={handleMouseMove}
              dataKeyboardMode={dataKeyboardMode}
            />
          ) : (
            <div
              className="flex items-center justify-center"
              style={{ height: COLUMN_HEIGHT }}
            >
              <Placeholder
                variant={
                  searchQuery.trim()
                    ? "no-results"
                    : accountsLoading
                      ? "loading"
                      : accountsError
                        ? "error"
                        : "empty"
                }
                title={
                  searchQuery.trim()
                    ? t("common:common.noResults")
                    : accountsLoading
                      ? t("placeholders.loading")
                      : accountsError
                        ? t("placeholders.failedToLoad")
                        : t("placeholders.noItemsAvailable")
                }
                subtitle={accountsError ?? undefined}
                onRetry={accountsError ? onRetryAccounts : undefined}
                placement="sidebar"
              />
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col py-2">
          <div className="w-px flex-1 bg-border-1" />
        </div>

        {/* Right: accounts for the focused model */}
        <div className="flex w-3/5 flex-col">
          <div className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-text-3 uppercase">
            {`Step 2 - ${t("selectors.modelSelector.chooseKey")}`}
          </div>
          {!hasFocusedModel || sourceItems.length === 0 ? (
            <div
              className="flex items-center justify-center px-4"
              style={{ height: COLUMN_HEIGHT }}
            >
              <Placeholder
                variant="empty"
                title={
                  hasFocusedModel
                    ? t("selectors.modelSelector.noCompatibleAccounts")
                    : t("selectors.modelSelector.chooseModelHint")
                }
                placement="sidebar"
              />
            </div>
          ) : (
            <div
              className="spotlight-scrollable overflow-y-auto"
              style={{ maxHeight: COLUMN_HEIGHT }}
              onMouseMove={handleMouseMove}
              data-keyboard-mode={dataKeyboardMode}
            >
              {sourceItems.map((source, index) => (
                <SpotlightItemRow
                  key={source.id}
                  item={source}
                  selectionState={source.data?.selectionState}
                  index={index}
                  isSelected={
                    sourcesColumnActive && selectedSourceIndex === index
                  }
                  isKeyboardMode={isKeyboardMode}
                  onSelect={() => onSourceSelect(index)}
                  onHover={() => onSourceHover(index)}
                  searchQuery=""
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TwoColumnModelBody;
