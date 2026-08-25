import { Check, RefreshCw } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import SegmentedTextPill from "@src/components/SegmentedTextPill";
import {
  type UseDropdownListNavigationReturn,
  useDropdownEngine,
} from "@src/hooks/dropdown";
import { useTauriSelectAllShortcut } from "@src/hooks/keyboard";
import { useSelectorKernel } from "@src/scaffold/GlobalSpotlight/palettes/core";
import {
  PaletteBody,
  SpotlightShell,
} from "@src/scaffold/GlobalSpotlight/shell";
import type { SpotlightItem } from "@src/scaffold/GlobalSpotlight/types";
import { getViewportSize } from "@src/util/ui/window/viewport";

import { sourceKey } from "./worktreeBranchSource";
import type {
  WorktreeSourcePickerItem,
  WorktreeSourcePickerMode,
  WorktreeSourcePickerSection,
} from "./worktreeSourceSelectorTypes";

const LIST_MAX_HEIGHT = 360;
const VIEWPORT_MARGIN = 12;
const MIN_DROPDOWN_WIDTH = 360;

function WorktreeSourceModeSwitch({
  mode,
  disabled,
  onChange,
}: {
  mode: WorktreeSourcePickerMode;
  disabled: boolean;
  onChange: (mode: WorktreeSourcePickerMode) => void;
}) {
  const { t } = useTranslation("sessions");
  return (
    <SegmentedTextPill
      ariaLabel={t("creator.worktreeSource.sourceTypeAria", {
        defaultValue: "Select branch or pull request",
      })}
      dataTestId="worktree-source-mode-switch"
      value={mode}
      options={[
        {
          value: "branch",
          label: t("creator.worktreeSource.tabs.branch", {
            defaultValue: "Branch",
          }),
          disabled,
        },
        {
          value: "pr",
          label: t("creator.worktreeSource.tabs.pr", { defaultValue: "PR" }),
          disabled,
        },
      ]}
      onChange={onChange}
    />
  );
}

function SelectorError({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex min-h-40 flex-col items-center justify-center gap-3 px-4 text-center text-[13px] text-text-3"
    >
      <span>{message}</span>
      <Button
        variant="secondary"
        size="small"
        icon={<RefreshCw size={14} strokeWidth={1.8} />}
        onClick={onRetry}
      >
        {retryLabel}
      </Button>
    </div>
  );
}

export interface WorktreeSourceSelectorViewProps {
  isOpen: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  placement: "top" | "bottom" | "auto";
  mode: WorktreeSourcePickerMode;
  query: string;
  sections: WorktreeSourcePickerSection[];
  items: WorktreeSourcePickerItem[];
  selectedSourceKey: string | null;
  effectiveCurrentBranchName?: string;
  loading: boolean;
  refreshing: boolean;
  resolving: boolean;
  error: string | null;
  emptyMessage: string;
  loadingLabel: string;
  resolvingLabel: string;
  searchPlaceholder: string;
  searchAriaLabel: string;
  retryLabel: string;
  onClose: () => void;
  onModeChange: (mode: WorktreeSourcePickerMode) => void;
  onQueryChange: (query: string) => void;
  onRetry: () => void;
  onSelect: (item: WorktreeSourcePickerItem) => void;
}

function isPickerItemSelected(
  item: WorktreeSourcePickerItem,
  selectedSourceKey: string | null,
  effectiveCurrentBranchName?: string
): boolean {
  if (selectedSourceKey) return sourceKey(item.source) === selectedSourceKey;
  return (
    item.source.kind === "branch" &&
    item.source.baseBranch === effectiveCurrentBranchName
  );
}

export function WorktreeSourceSpotlightView({
  isOpen,
  mode,
  query,
  sections,
  selectedSourceKey,
  effectiveCurrentBranchName,
  loading,
  refreshing,
  resolving,
  error,
  emptyMessage,
  resolvingLabel,
  searchPlaceholder,
  searchAriaLabel,
  retryLabel,
  onClose,
  onModeChange,
  onQueryChange,
  onRetry,
  onSelect,
}: WorktreeSourceSelectorViewProps) {
  const spotlightItems = useMemo<SpotlightItem[]>(() => {
    const result: SpotlightItem[] = [];
    for (const section of sections) {
      if (section.label) {
        result.push({
          id: `header:${section.key}`,
          label: section.label,
          icon: "",
          type: "option",
          data: { isHeader: true },
          action: () => undefined,
        });
      }
      for (const item of section.items) {
        const selected = isPickerItemSelected(
          item,
          selectedSourceKey,
          effectiveCurrentBranchName
        );
        result.push({
          id: item.id,
          label: item.label,
          desc: item.detail,
          icon: item.icon,
          type: "option",
          data: {
            isSelector: true,
            isCurrentSelection: selected,
            rightLabel: item.meta,
            disabled: resolving,
          },
          action: () => onSelect(item),
        });
      }
    }
    return result;
  }, [
    effectiveCurrentBranchName,
    onSelect,
    resolving,
    sections,
    selectedSourceKey,
  ]);

  const kernel = useSelectorKernel({
    isOpen,
    onClose,
    items: spotlightItems,
    isItemSelectable: (item) => !item.data?.isHeader && !item.data?.disabled,
    externalSearchQuery: query,
    externalSetSearchQuery: onQueryChange,
  });

  const contentOverride = error ? (
    <SelectorError message={error} retryLabel={retryLabel} onRetry={onRetry} />
  ) : !loading && spotlightItems.length === 0 ? (
    <div className={DROPDOWN_CLASSES.listMessage}>{emptyMessage}</div>
  ) : undefined;

  return (
    <SpotlightShell isOpen={isOpen} onClose={onClose}>
      <PaletteBody
        kernel={kernel}
        items={spotlightItems}
        inputLeadingSlot={
          <WorktreeSourceModeSwitch
            mode={mode}
            disabled={resolving}
            onChange={onModeChange}
          />
        }
        placeholder={searchPlaceholder}
        inputAriaLabel={searchAriaLabel}
        isLoading={loading || refreshing || resolving}
        fixedHeight
        contentOverride={contentOverride}
        hintSlot={
          resolving ? (
            <div
              aria-live="polite"
              className="border-t border-border-2 px-4 py-2 text-[12px] text-text-3"
            >
              {resolvingLabel}
            </div>
          ) : undefined
        }
      />
    </SpotlightShell>
  );
}

function WorktreeSourceDropdownRow({
  item,
  selected,
  disabled,
  keyboardProps,
}: {
  item: WorktreeSourcePickerItem;
  selected: boolean;
  disabled: boolean;
  keyboardProps: ReturnType<UseDropdownListNavigationReturn["getItemProps"]>;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      data-testid={`worktree-source-row-${item.id}`}
      {...keyboardProps}
      disabled={disabled}
      className={`${DROPDOWN_CLASSES.item} ${
        selected ? DROPDOWN_CLASSES.itemSelected : DROPDOWN_CLASSES.itemHover
      } w-full justify-start ${disabled ? "opacity-60" : ""}`}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        <Icon size={DROPDOWN_ITEM.iconSize} className="text-text-2" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col items-start">
        <span className="w-full truncate text-[13px] text-text-1">
          {item.label}
        </span>
        {item.detail && (
          <span className="w-full truncate text-[11px] text-text-3">
            {item.detail}
          </span>
        )}
      </span>
      {item.meta && (
        <span className="shrink-0 text-[11px] tabular-nums text-text-3">
          {item.meta}
        </span>
      )}
      {selected && (
        <Check
          size={DROPDOWN_ITEM.iconSize}
          strokeWidth={2.25}
          className="shrink-0 text-primary-6"
        />
      )}
    </button>
  );
}

export function WorktreeSourceDropdownView({
  isOpen,
  anchorRef,
  placement,
  mode,
  query,
  sections,
  items,
  selectedSourceKey,
  effectiveCurrentBranchName,
  loading,
  resolving,
  error,
  emptyMessage,
  loadingLabel,
  searchPlaceholder,
  searchAriaLabel,
  retryLabel,
  onClose,
  onModeChange,
  onQueryChange,
  onRetry,
  onSelect,
}: WorktreeSourceSelectorViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const tauriSelectAll = useTauriSelectAllShortcut();
  const handleSelect = useCallback(
    (item: WorktreeSourcePickerItem) => {
      if (!resolving) onSelect(item);
    },
    [onSelect, resolving]
  );
  const { isPositioned, panelRef, panelPosition, keyboard } = useDropdownEngine<
    HTMLElement,
    WorktreeSourcePickerItem
  >({
    open: isOpen,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
    anchorRef,
    placement,
    gap: DROPDOWN_PANEL.triggerGap,
    listNavigation: {
      items,
      onSelect: handleSelect,
      isItemSelectable: () => !resolving,
      initialSelectedIndex: -1,
    },
  });

  useEffect(() => {
    if (!isOpen || !isPositioned) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen, isPositioned, mode]);

  if (!isOpen || !isPositioned) return null;

  const width = Math.max(MIN_DROPDOWN_WIDTH, panelPosition.width);
  const { width: viewportWidth } = getViewportSize();
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(panelPosition.left, viewportWidth - VIEWPORT_MARGIN - width)
  );

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={searchAriaLabel}
      className={`${DROPDOWN_CLASSES.panel} fixed flex flex-col`}
      style={{
        top: panelPosition.top,
        bottom: panelPosition.bottom,
        left,
        width,
      }}
    >
      <div className={`${DROPDOWN_CLASSES.searchContainer} gap-2`}>
        <WorktreeSourceModeSwitch
          mode={mode}
          disabled={resolving}
          onChange={onModeChange}
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={tauriSelectAll}
          placeholder={searchPlaceholder}
          aria-label={searchAriaLabel}
          className={DROPDOWN_CLASSES.searchInput}
          disabled={resolving}
        />
      </div>

      <div
        className={DROPDOWN_CLASSES.optionsContainerOverlay}
        style={{ maxHeight: LIST_MAX_HEIGHT }}
      >
        {error ? (
          <SelectorError
            message={error}
            retryLabel={retryLabel}
            onRetry={onRetry}
          />
        ) : loading && items.length === 0 ? (
          <div className={DROPDOWN_CLASSES.listMessage}>{loadingLabel}</div>
        ) : items.length === 0 ? (
          <div className={DROPDOWN_CLASSES.listMessage}>{emptyMessage}</div>
        ) : (
          sections.map((section) => (
            <React.Fragment key={section.key}>
              {section.label && (
                <div className={DROPDOWN_CLASSES.sectionLabel}>
                  {section.label}
                </div>
              )}
              {section.items.map((item) => {
                const index = items.findIndex(
                  (visibleItem) => visibleItem.id === item.id
                );
                return (
                  <WorktreeSourceDropdownRow
                    key={item.id}
                    item={item}
                    selected={isPickerItemSelected(
                      item,
                      selectedSourceKey,
                      effectiveCurrentBranchName
                    )}
                    disabled={resolving}
                    keyboardProps={keyboard.getItemProps(index)}
                  />
                );
              })}
            </React.Fragment>
          ))
        )}
      </div>
    </div>,
    document.body
  );
}
