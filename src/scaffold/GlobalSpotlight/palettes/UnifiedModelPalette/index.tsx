/**
 * UnifiedModelPalette Component
 *
 * Two-column spotlight palette: a full-width "Recent" section (one-click)
 * above an "All Models" area laid out as Models (left) | Accounts (right) —
 * mirroring the Models & Keys table. The "Key first" footer toggle
 * (`spotlightModelKeyFirstAtom`) flips the columns to Keys (left) |
 * Models (right).
 *
 * Keyboard: the left column is driven by the shared selector kernel.
 * Enter / ArrowRight / Tab on a model row hands focus to the right column;
 * Tab / ArrowLeft / Escape returns focus to the left column.
 *
 * Thin UI wrapper — business logic lives in useUnifiedModelPalette.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useFilteredItems } from "@src/hooks/search";
import { useRefreshSpin } from "@src/hooks/ui";
import { GripIcon, HugeiconsIcon, Refresh04Icon } from "@src/icons";
import { spotlightOpenAtom } from "@src/store";
import { agentNameAtom } from "@src/store/session/creatorStateAtom";
import { spotlightModelKeyFirstAtom } from "@src/store/ui/spotlightModelKeyFirstAtom";

import {
  ManageKeysFooterAction,
  ManageModelsFooterAction,
  SPOTLIGHT_FOOTER_ACTIVE_CHIP,
  SpotlightFooterToggle,
} from "../../components";
import { PaletteBody, ShellFooterAction, SpotlightShell } from "../../shell";
import type { SpotlightItem } from "../../types";
import { buildPathSegment } from "../config";
import { useSelectorKernel } from "../core";
import { TwoColumnModelBody } from "./TwoColumnModelBody";
import { advancePaletteSearchState } from "./searchState";
import type { UnifiedModelPaletteProps } from "./types";
import {
  MODEL_SECTION,
  useUnifiedModelPalette,
} from "./useUnifiedModelPalette";

export type { UnifiedModelPaletteProps } from "./types";
export { UnifiedModelDropdown } from "./UnifiedModelDropdown";

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
  const [keyFirst, setKeyFirst] = useAtom(spotlightModelKeyFirstAtom);

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
    keyItems,
    keyModelItems,
    selectedKeyAccountId,
    previewKey,
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
    keyFirst,
  });

  // ============ COLUMN ORIENTATION ============
  // "primary" is whatever the kernel-driven left column lists under
  // "All Models"; "secondary" is the manual right column. Default mode
  // is models → keys; key-first mode is keys → models.
  const primaryItems = keyFirst ? keyItems : allModelItems;
  const secondaryItems = keyFirst ? keyModelItems : sourceItems;
  const hasFocusedPrimary = keyFirst
    ? selectedKeyAccountId !== null
    : selectedModelId !== null;

  // ============ SEARCH ============
  // The query is owned here so we can filter the list before handing it to
  // the kernel — the kernel must navigate the filtered (visible) rows.
  const [searchState, setSearchState] = useState({ isOpen, query: "" });
  const nextSearchState = advancePaletteSearchState(searchState, isOpen);
  if (nextSearchState !== searchState) {
    setSearchState(nextSearchState);
  }
  const searchQuery = nextSearchState.query;
  const setSearchQuery = useCallback(
    (nextQuery: React.SetStateAction<string>) => {
      setSearchState((current) => ({
        ...current,
        query:
          typeof nextQuery === "function"
            ? nextQuery(current.query)
            : nextQuery,
      }));
    },
    []
  );

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
    items: primaryItems,
    searchQuery,
    getSearchText,
  });

  const filteredItems = useMemo<SpotlightItem[]>(() => {
    const out: SpotlightItem[] = [];
    if (filteredRecentItems.length > 0) {
      out.push(recentHeader);
      out.push(...filteredRecentItems);
    }
    if (primaryItems.length > 0) {
      out.push(allHeader);
      out.push(...filteredAllModelItems);
    }
    return out;
  }, [
    filteredRecentItems,
    filteredAllModelItems,
    primaryItems.length,
    recentHeader,
    allHeader,
  ]);

  // ============ RIGHT-COLUMN NAVIGATION ============
  const activateSource = useCallback(() => {
    const sourceIndex = selectedSourceIndex >= 0 ? selectedSourceIndex : 0;
    const source = secondaryItems[sourceIndex];
    source?.action?.();
  }, [secondaryItems, selectedSourceIndex]);

  const focusSourcesColumn = useCallback(() => {
    if (secondaryItems.length === 0) return;
    setSelectedSourceIndex((prev) =>
      prev >= 0 && prev < secondaryItems.length ? prev : -1
    );
    setActiveColumn("sources");
  }, [secondaryItems.length, setActiveColumn, setSelectedSourceIndex]);

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
              prev < 0 ? 0 : Math.min(prev + 1, secondaryItems.length - 1)
            );
            return;
          case "ArrowUp":
            event.preventDefault();
            setSelectedSourceIndex((prev) =>
              prev < 0
                ? Math.max(secondaryItems.length - 1, 0)
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

      // Left column: Tab is the column-switch key — it crosses over to
      // the right column when the focused row (model, or key in key-first
      // mode) has at least one option there. ArrowRight mirrors it.
      if (event.key === "Tab" || event.key === "ArrowRight") {
        if (hasFocusedPrimary && secondaryItems.length > 0) {
          event.preventDefault();
          focusSourcesColumn();
          return;
        }
      }

      internalHandleKeyDown(event);
    },
    [
      activeColumn,
      secondaryItems.length,
      hasFocusedPrimary,
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
  const focusModelInput = kernel.focusInput;

  // Keep the keyboard-focused row previewed in the right column. The ref
  // gate ensures the preview setter (which resets the right-column cursor)
  // only fires on a genuine change, not on every render. Two cases clear
  // the preview (right column shows the "Hover a model/key…" empty state):
  //  - The focused row carries no model/key (search filtered the list to zero).
  //  - The focused row is in the Recent Models section — those rows are
  //    one-click launches and the two-column flow does not apply.
  // The selection hook also resets its state (deferred to a frame) when
  // the palette opens or the key-first toggle flips; the state checks
  // below re-apply the preview for the row still under the cursor after
  // such a reset, which the ref gate alone would miss.
  const hoveredItem = filteredItems[kernel.selectedIndex];
  const previewedRef = useRef<string | null>(null);
  useEffect(() => {
    const data = hoveredItem?.data as Record<string, unknown> | undefined;
    const isAllModelsRow = data?.modelSection === MODEL_SECTION.ALL;
    if (keyFirst) {
      const accountId = isAllModelsRow
        ? ((data?.keyAccountId as string | undefined) ?? null)
        : null;
      const previewKeyId = accountId === null ? null : `key:${accountId}`;
      if (
        previewedRef.current !== previewKeyId ||
        selectedKeyAccountId !== accountId
      ) {
        previewedRef.current = previewKeyId;
        previewKey(accountId);
      }
      return;
    }
    const modelId = isAllModelsRow
      ? ((data?.modelId as string | undefined) ?? null)
      : null;
    const previewModelId = modelId === null ? null : `model:${modelId}`;
    // Only a focused model row may re-assert itself: the CLI no-model
    // flow parks selectedModelId at "" with no row under the cursor and
    // must not be clobbered back to null.
    const resetUnderCursor = modelId !== null && selectedModelId !== modelId;
    if (previewedRef.current !== previewModelId || resetUnderCursor) {
      previewedRef.current = previewModelId;
      const groupModelIds =
        (data?.groupModelIds as string[] | undefined) ??
        (modelId ? [modelId] : []);
      previewModel(modelId, hoveredItem?.label ?? "", groupModelIds);
    }
  }, [
    hoveredItem,
    keyFirst,
    previewKey,
    previewModel,
    selectedKeyAccountId,
    selectedModelId,
  ]);

  useEffect(() => {
    // Never steal focus while closed — a closed palette focusing its input
    // yanks the caret from the composer (same class of bug as the
    // WorkspacePalette focus loop).
    if (!isOpen) return;
    focusModelInput();
  }, [activeColumn, focusModelInput, isOpen]);

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
        icon: GripIcon,
        template: modelTemplate,
        requiredParams: ["model"],
      }),
    ];
  }, [agentName, tCommonHook, selectModelLabel]);

  // ============ FOOTER ACTION ============
  // Offer "Manage Keys" while the keys column owns the cursor and
  // "Manage Models" while the models column does — whichever side that is.
  const keysColumnActive = keyFirst
    ? activeColumn === "models"
    : activeColumn === "sources";
  const footerAction = keysColumnActive ? (
    <ManageKeysFooterAction onClose={onClose} />
  ) : (
    <ManageModelsFooterAction onClose={onClose} />
  );

  const keyFirstToggle = (
    <ShellFooterAction placement="inline">
      <SpotlightFooterToggle
        label={tCommonHook("selectors.spotlightFooter.keyFirst")}
        checked={keyFirst}
        onCheckedChange={setKeyFirst}
      />
    </ShellFooterAction>
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
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1 disabled:opacity-60"
      data-testid="model-spotlight-refresh-button"
    >
      <HugeiconsIcon
        icon={Refresh04Icon}
        data-icon="refresh-cw"
        size={14}
        className={refreshSpinClass}
      />
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
      keyFirst={keyFirst}
      sourceItems={secondaryItems}
      selectedSourceIndex={selectedSourceIndex}
      hasFocusedModel={hasFocusedPrimary}
      accountsLoading={accountsLoading || refreshingAllModels}
      accountsError={accountsError}
      onRetryAccounts={() => {
        void refreshAllModels();
      }}
      onSourceSelect={(index) => {
        const source = secondaryItems[index];
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
      {keyFirstToggle}
    </SpotlightShell>
  );
};
