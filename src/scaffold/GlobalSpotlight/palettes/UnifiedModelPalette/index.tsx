/**
 * UnifiedModelPalette Component
 *
 * Two-column spotlight palette: a full-width "Recent" section (one-click)
 * above an "All Models" area laid out as Models (left) | Accounts (right) —
 * mirroring the Models & Keys table.
 *
 * Keyboard: the left column is driven by the shared selector kernel.
 * Enter / ArrowRight / Tab on a model row hands focus to the right column;
 * Tab / ArrowLeft / Escape returns focus to the left column.
 *
 * Thin UI wrapper — business logic lives in useUnifiedModelPalette.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { Grip, RefreshCw } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useFilteredItems } from "@src/hooks/search";
import { useRefreshSpin } from "@src/hooks/ui";
import { spotlightOpenAtom } from "@src/store";
import { agentNameAtom } from "@src/store/session/creatorStateAtom";

import {
  ManageKeysFooterAction,
  ManageModelsFooterAction,
  SPOTLIGHT_FOOTER_ACTIVE_CHIP,
} from "../../components";
import { PaletteBody, ShellFooterAction, SpotlightShell } from "../../shell";
import type { SpotlightItem } from "../../types";
import { buildPathSegment } from "../config";
import { useSelectorKernel } from "../core";
import { TwoColumnModelBody } from "./TwoColumnModelBody";
import type { UnifiedModelPaletteProps } from "./types";
import {
  MODEL_SECTION,
  useUnifiedModelPalette,
} from "./useUnifiedModelPalette";

export type { UnifiedModelPaletteProps } from "./types";
export { UnifiedModelDropdown } from "./UnifiedModelDropdown";
export type { UnifiedModelDropdownProps } from "./UnifiedModelDropdown";

// ============ COMPONENT ============

export const UnifiedModelPalette: React.FC<UnifiedModelPaletteProps> = ({
  isOpen,
  onClose,
  advancedConfig,
  onConfigChange,
  dispatchCategoryOverride,
  cliAgentTypeOverride,
}) => {
  const agentName = useAtomValue(agentNameAtom);
  const setDefaultSpotlightOpen = useSetAtom(spotlightOpenAtom);

  const {
    activeColumn,
    setActiveColumn,
    selectedModelId,
    selectedSourceIndex,
    setSelectedSourceIndex,
    recentItems,
    allModelItems,
    recentHeader,
    allHeader,
    sourceItems,
    previewModel,
    handleBack,
    accountsLoading,
    accountsError,
    refreshAllModels,
    refreshingAllModels,
    tCommon: tCommonHook,
  } = useUnifiedModelPalette({
    isOpen,
    onClose,
    advancedConfig,
    onConfigChange,
    dispatchCategoryOverride,
    cliAgentTypeOverride,
  });

  // ============ SEARCH ============
  // The query is owned here so we can filter the list before handing it to
  // the kernel — the kernel must navigate the filtered (visible) rows.
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (isOpen) setSearchQuery("");
  }, [isOpen]);

  const isItemSelectable = useCallback((item: SpotlightItem) => {
    const data = item.data as Record<string, unknown> | undefined;
    return !data?.isHeader;
  }, []);

  // Filter each section's rows independently so the section headers stay
  // visible (and in their original order) while the user types. A section
  // header is dropped only when its section has zero matches.
  const getSearchText = useCallback((item: SpotlightItem) => {
    const data = item.data as Record<string, unknown> | undefined;
    const rightLabel = (data?.rightLabel as string | undefined) ?? "";
    // `searchAlias` is a hidden search-only hint (not rendered) used by
    // model rows to let users find an alias by typing the raw model id.
    const searchAlias = (data?.searchAlias as string | undefined) ?? "";
    return `${item.label} ${item.desc || ""} ${rightLabel} ${searchAlias}`;
  }, []);

  const { filteredItems: filteredRecentItems } = useFilteredItems({
    items: recentItems,
    searchQuery,
    getSearchText,
  });

  const { filteredItems: filteredAllModelItems } = useFilteredItems({
    items: allModelItems,
    searchQuery,
    getSearchText,
  });

  const filteredItems = useMemo<SpotlightItem[]>(() => {
    const out: SpotlightItem[] = [];
    if (filteredRecentItems.length > 0) {
      out.push(recentHeader);
      out.push(...filteredRecentItems);
    }
    if (allModelItems.length > 0) {
      out.push(allHeader);
      out.push(...filteredAllModelItems);
    }
    return out;
  }, [
    filteredRecentItems,
    filteredAllModelItems,
    allModelItems.length,
    recentHeader,
    allHeader,
  ]);

  // ============ RIGHT-COLUMN NAVIGATION ============
  const activateSource = useCallback(() => {
    const sourceIndex = selectedSourceIndex >= 0 ? selectedSourceIndex : 0;
    const source = sourceItems[sourceIndex];
    source?.action?.();
  }, [sourceItems, selectedSourceIndex]);

  const focusSourcesColumn = useCallback(() => {
    if (sourceItems.length === 0) return;
    setSelectedSourceIndex((prev) =>
      prev >= 0 && prev < sourceItems.length ? prev : -1
    );
    setActiveColumn("sources");
  }, [sourceItems.length, setActiveColumn, setSelectedSourceIndex]);

  /**
   * Route keyboard events between the two columns. The kernel owns the
   * left column; the right column is handled manually here.
   */
  const externalHandleKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLInputElement>,
      internalHandleKeyDown: (
        keyEvent: React.KeyboardEvent<HTMLInputElement>
      ) => void
    ) => {
      if (activeColumn === "sources") {
        switch (event.key) {
          case "ArrowDown":
            event.preventDefault();
            setSelectedSourceIndex((prev) =>
              prev < 0 ? 0 : Math.min(prev + 1, sourceItems.length - 1)
            );
            return;
          case "ArrowUp":
            event.preventDefault();
            setSelectedSourceIndex((prev) =>
              prev < 0
                ? Math.max(sourceItems.length - 1, 0)
                : Math.max(prev - 1, 0)
            );
            return;
          case "Enter":
            event.preventDefault();
            activateSource();
            return;
          // Tab is the column-switch key: it returns focus to the model
          // column. Backspace is intentionally NOT a back key here.
          case "Tab":
          case "ArrowLeft":
            event.preventDefault();
            handleBack();
            return;
          case "Escape":
            event.preventDefault();
            onClose();
            return;
          default:
            return;
        }
      }

      // Left (models) column: Tab is the column-switch key — it crosses
      // over to the accounts column when a model with at least one source
      // is focused. ArrowRight mirrors it for convenience.
      if (event.key === "Tab" || event.key === "ArrowRight") {
        if (selectedModelId !== null && sourceItems.length > 0) {
          event.preventDefault();
          focusSourcesColumn();
          return;
        }
      }

      internalHandleKeyDown(event);
    },
    [
      activeColumn,
      sourceItems.length,
      selectedModelId,
      setSelectedSourceIndex,
      activateSource,
      focusSourcesColumn,
      handleBack,
      onClose,
    ]
  );

  // ============ KERNEL ============
  const kernel = useSelectorKernel({
    isOpen,
    onClose,
    items: filteredItems,
    hasModalState: activeColumn !== "models",
    onGoBack: handleBack,
    isItemSelectable,
    externalSearchQuery: searchQuery,
    externalSetSearchQuery: setSearchQuery,
    externalHandleKeyDown,
  });

  // Keep the keyboard-focused model previewed in the right column. The ref
  // gate ensures previewModel (which resets the source cursor) only fires
  // on a genuine model change, not on every render. Two cases clear the
  // preview (right column shows the "Hover a model…" empty state):
  //  - The focused row carries no model (search filtered the list to zero).
  //  - The focused row is in the Recent Models section — those rows are
  //    one-click launches and the two-column flow does not apply.
  const hoveredItem = filteredItems[kernel.selectedIndex];
  const previewedModelRef = useRef<string | null>(null);
  useEffect(() => {
    const data = hoveredItem?.data as Record<string, unknown> | undefined;
    const isAllModelsRow = data?.modelSection === MODEL_SECTION.ALL;
    const modelId = isAllModelsRow
      ? ((data?.modelId as string | undefined) ?? null)
      : null;
    if (previewedModelRef.current !== modelId) {
      previewedModelRef.current = modelId;
      const groupModelIds =
        (data?.groupModelIds as string[] | undefined) ??
        (modelId ? [modelId] : []);
      previewModel(modelId, hoveredItem?.label ?? "", groupModelIds);
    }
  }, [hoveredItem, previewModel]);

  useEffect(() => {
    kernel.focusInput();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeColumn]);

  const handleRemovePathSegment = useCallback(() => {
    onClose();
    Promise.resolve().then(() => setDefaultSpotlightOpen(true));
  }, [onClose, setDefaultSpotlightOpen]);

  // ============ PATH ============
  const selectModelLabel = tCommonHook("filters.model");
  // When we know the target agent, surface it in the search placeholder
  // (e.g. "Select a model for Builder...") instead of the generic
  // "Search model..." label.
  const placeholderModel = agentName
    ? tCommonHook("filters.searchModelFor", { target: agentName })
    : tCommonHook("filters.searchModel");

  const path = useMemo(() => {
    const modelTemplate = agentName
      ? tCommonHook("filters.tplSelectModelFor", { target: agentName })
      : tCommonHook("filters.tplSelectModel");

    return [
      buildPathSegment({
        id: "unified-model-model",
        label: selectModelLabel,
        icon: Grip,
        template: modelTemplate,
        requiredParams: ["model"],
      }),
    ];
  }, [agentName, tCommonHook, selectModelLabel]);

  // ============ FOOTER ACTION ============
  const footerAction =
    activeColumn === "sources" ? (
      <ManageKeysFooterAction onClose={onClose} />
    ) : (
      <ManageModelsFooterAction onClose={onClose} />
    );

  // Hovering a left-column row returns keyboard ownership to that column.
  const handleItemHover = useCallback(
    (index: number) => {
      kernel.setSelectedIndex(index);
      setActiveColumn("models");
    },
    [kernel, setActiveColumn]
  );

  const handleItemSelect = useCallback(
    (item: SpotlightItem, index: number) => {
      kernel.setSelectedIndex(index);
      kernel.handleItemClick(item);
    },
    [kernel]
  );

  // ============ RENDER ============
  const { spinClass: refreshSpinClass, handleClick: handleRefreshModelsClick } =
    useRefreshSpin(() => {
      void refreshAllModels();
    }, refreshingAllModels);

  const refreshModelsButton = (
    <button
      type="button"
      onClick={handleRefreshModelsClick}
      disabled={refreshingAllModels}
      aria-label={tCommonHook("actions.refresh")}
      title={tCommonHook("actions.refresh")}
      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1 disabled:opacity-60"
      data-testid="model-spotlight-refresh-button"
    >
      <RefreshCw size={14} className={refreshSpinClass} />
    </button>
  );

  const content = (
    <TwoColumnModelBody
      items={filteredItems}
      selectedIndex={kernel.selectedIndex}
      onItemSelect={handleItemSelect}
      onItemHover={handleItemHover}
      searchQuery={searchQuery}
      activeColumn={activeColumn}
      sourceItems={sourceItems}
      selectedSourceIndex={selectedSourceIndex}
      hasFocusedModel={selectedModelId !== null}
      accountsLoading={accountsLoading || refreshingAllModels}
      accountsError={accountsError}
      onRetryAccounts={() => {
        void refreshAllModels();
      }}
      onSourceSelect={(index) => {
        const source = sourceItems[index];
        source?.action?.();
      }}
      onSourceHover={(index) => {
        setSelectedSourceIndex(index);
        setActiveColumn("sources");
      }}
    />
  );

  return (
    <SpotlightShell
      isOpen={isOpen}
      onClose={onClose}
      hasActiveAction={activeColumn !== "models"}
      activeActionChip={SPOTLIGHT_FOOTER_ACTIVE_CHIP.switchColumn}
    >
      <PaletteBody
        kernel={kernel}
        items={filteredItems}
        path={path}
        onRemoveSegment={handleRemovePathSegment}
        hideActionClose={false}
        placeholder={placeholderModel}
        contentOverride={content}
        inputTrailingSlot={refreshModelsButton}
      />
      <ShellFooterAction>{footerAction}</ShellFooterAction>
    </SpotlightShell>
  );
};
