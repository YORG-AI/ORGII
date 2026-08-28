/**
 * SlashCommandMenu — the main dropdown panel.
 *
 * Composes useEntries, useFloatingPortalPosition, useKeyboard, FlyoutSubmenu,
 * and the individual MenuRow components into the full slash command experience.
 */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import FileTreePreview from "@src/components/FileTreePreview";
import { useMouseMoved } from "@src/hooks/ui/useMouseMoved";

import { useFloatingPortalPosition } from "../useFloatingPortalPosition";
import FlyoutSubmenu from "./FlyoutSubmenu";
import {
  DividerRow,
  FlyoutTriggerRow,
  ImageRow,
  ModeRow,
  SectionHeaderRow,
  SlashItemRow,
} from "./MenuRows";
import type { OpenFlyoutState, SlashCommandPortalProps } from "./types";
import { useEntries } from "./useEntries";
import { useKeyboard } from "./useKeyboard";

const PANEL_WIDTH = 280;
const MAX_PANEL_HEIGHT = 300;
const OUTSIDE_CLICK_GRACE_MS = 120;

const SlashCommandMenu: React.FC<SlashCommandPortalProps> = ({
  visible,
  containerRef,
  anchorSelector,
  placement = "prefer-up",
  items,
  loading,
  currentMode,
  searchQuery = "",
  onClose,
  onSelect,
  onModeSelect,
  keyboardHandlerRef,
  searchMode = "inline",
  onSearchQueryChange,
  showActionFlyouts = false,
  onImageUpload,
  showModeRows = true,
  includeProjectMode = false,
}) => {
  const { t } = useTranslation("sessions");
  const isHeaderMode = searchMode === "header";

  const portalContainerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const menuOpenedAtRef = useRef(0);

  // Build the unified entry list
  const { entries, totalFlat } = useEntries({
    items,
    searchQuery,
    showActionFlyouts,
    hasImageUpload: Boolean(onImageUpload),
    showModeRows,
    includeProjectMode,
  });

  const [highlightIndex, setHighlightIndex] = useState(0);
  const activeEntry = entries.find(
    (entry) => "flatIndex" in entry && entry.flatIndex === highlightIndex
  );
  const activeSkillItem =
    activeEntry?.kind === "item" &&
    activeEntry.item.category === "skill" &&
    activeEntry.item.skillPath
      ? activeEntry.item
      : null;
  const [keyboardNavigated, setKeyboardNavigated] = useState(!isHeaderMode);
  const [openFlyout, setOpenFlyout] = useState<OpenFlyoutState | null>(null);
  const [flyoutHighlightIndex, setFlyoutHighlightIndex] = useState(0);
  const [panelRight, setPanelRight] = useState(0);

  const placementUpdateKey = `${searchQuery}\0${entries.length}\0${openFlyout?.kind ?? ""}`;
  const { portalPosition, portalMaxHeight, isPositioned } =
    useFloatingPortalPosition({
      visible,
      containerRef,
      floatingRef: portalContainerRef,
      floatingWidth: PANEL_WIDTH,
      fallbackHeight: 320,
      placement,
      anchorSelector,
      updateKey: placementUpdateKey,
      maxHeight: MAX_PANEL_HEIGHT,
    });

  // Reset highlight to the first actionable row when the list shape changes.
  const listIdentity = useMemo(
    () =>
      `${items.map((i) => `${i.source}:${i.category}:${i.name}`).join("\0")}\0${searchQuery}`,
    [items, searchQuery]
  );
  const [trackedIdentity, setTrackedIdentity] = useState(listIdentity);
  if (trackedIdentity !== listIdentity) {
    setTrackedIdentity(listIdentity);
    setHighlightIndex(0);
    setKeyboardNavigated(!isHeaderMode);
  }

  // Close flyout when a search query is active (derived state)
  const [trackedQuery, setTrackedQuery] = useState(searchQuery);
  if (trackedQuery !== searchQuery) {
    setTrackedQuery(searchQuery);
    if (searchQuery) setOpenFlyout(null);
  }

  // Reset flyout highlight when the flyout opens or its items change (derived state)
  const flyoutItemsKey =
    openFlyout?.kind === "category"
      ? (openFlyout.items?.map((i) => i.name).join("\0") ?? "")
      : (openFlyout?.kind ?? "");
  const [trackedFlyoutKey, setTrackedFlyoutKey] = useState(flyoutItemsKey);
  if (trackedFlyoutKey !== flyoutItemsKey) {
    setTrackedFlyoutKey(flyoutItemsKey);
    setFlyoutHighlightIndex(0);
  }

  useEffect(() => {
    if (!isHeaderMode || !visible || !isPositioned || !portalPosition) return;
    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isHeaderMode, visible, isPositioned, portalPosition]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current) return;
    const itemEls = listRef.current.querySelectorAll("[data-slash-flat]");
    itemEls[highlightIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  // Keep panelRight in sync after DOM mutation and window resize
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () => setPanelRight(el.getBoundingClientRect().right);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isPositioned]);

  // Click outside → close (but not when clicking inside a flyout portal)
  useEffect(() => {
    if (!visible || !isPositioned) return;

    menuOpenedAtRef.current = performance.now();
    let portalReady = false;
    const readyFrame = window.requestAnimationFrame(() => {
      portalReady = true;
    });

    const handler = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        performance.now() - menuOpenedAtRef.current <
        OUTSIDE_CLICK_GRACE_MS
      ) {
        return;
      }
      const portalContainer = portalContainerRef.current;
      const ownerContainer = containerRef.current;
      if (!portalContainer && !portalReady) return;
      if (
        portalContainer?.contains(target) ||
        ownerContainer?.contains(target)
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => {
      window.cancelAnimationFrame(readyFrame);
      document.removeEventListener("mousedown", handler);
    };
  }, [visible, isPositioned, containerRef, onClose, searchQuery]);

  const menuReady = visible && isPositioned && Boolean(portalPosition);
  const mouseMovedRef = useMouseMoved(menuReady);

  // Wire keyboard navigation
  useKeyboard({
    visible: menuReady,
    entries,
    totalFlat,
    highlightIndex,
    openFlyout,
    listRef,
    setHighlightIndex,
    setKeyboardNavigated,
    setOpenFlyout,
    onSelect,
    onModeSelect,
    onImageUpload,
    onClose,
    keyboardHandlerRef,
    flyoutHighlightIndex,
    setFlyoutHighlightIndex,
  });

  const openCategoryFlyout = useCallback(
    (
      event: React.MouseEvent<HTMLDivElement>,
      payload: OpenFlyoutState | null
    ) => {
      setOpenFlyout(
        payload
          ? {
              ...payload,
              anchorTop: event.currentTarget.getBoundingClientRect().top,
            }
          : null
      );
    },
    []
  );

  if (!isPositioned || !portalPosition) return null;

  const portalStyle = {
    top: portalPosition.top,
    bottom: portalPosition.bottom,
    left: portalPosition.left,
    width: PANEL_WIDTH,
  };

  return createPortal(
    <div
      ref={portalContainerRef}
      data-slash-portal
      className="fixed z-[99999] flex flex-col gap-2"
      style={portalStyle}
    >
      {activeSkillItem?.skillPath && (
        <div
          className="absolute left-full top-0 ml-2"
          style={{ pointerEvents: "auto" }}
        >
          <FileTreePreview path={activeSkillItem.skillPath} itemType="file" />
        </div>
      )}

      {/* Main panel */}
      <div
        ref={listRef}
        data-testid="slash-command-menu"
        data-dropdown-keyboard-mode={keyboardNavigated ? "true" : undefined}
        className={DROPDOWN_CLASSES.panel}
        onMouseDown={(e) => {
          if (
            isHeaderMode &&
            (e.target as HTMLElement).closest("[data-slash-search-input]")
          ) {
            return;
          }
          e.preventDefault();
        }}
      >
        {isHeaderMode && (
          <DropdownSearch
            ref={searchInputRef}
            data-slash-search-input="true"
            testId="slash-command-search"
            type="text"
            value={searchQuery}
            onChange={(value) => onSearchQueryChange?.(value)}
            onKeyDown={(event) => {
              if (keyboardHandlerRef.current?.(event.nativeEvent)) {
                event.preventDefault();
              }
            }}
            placeholder={t("creator.slashSearchPlaceholder", {
              defaultValue: "Search commands…",
            })}
          />
        )}

        <div
          className={`overflow-y-auto ${DROPDOWN_PANEL.paddingClass} scrollbar-hide`}
          style={{ maxHeight: portalMaxHeight }}
        >
          {entries.map((entry, mapIdx) => {
            if (entry.kind === "divider") {
              return <DividerRow key={`divider-${mapIdx}`} />;
            }

            if (entry.kind === "header") {
              return (
                <SectionHeaderRow
                  key={`header-${entry.label}`}
                  label={
                    entry.translationKey
                      ? t(entry.translationKey, { defaultValue: entry.label })
                      : entry.label
                  }
                />
              );
            }

            if (entry.kind === "image") {
              return (
                <ImageRow
                  key="image-upload"
                  isActive={
                    keyboardNavigated && entry.flatIndex === highlightIndex
                  }
                  onMouseEnter={() => {
                    if (!mouseMovedRef.current) return;
                    setKeyboardNavigated(false);
                    setHighlightIndex(entry.flatIndex);
                    setOpenFlyout(null);
                  }}
                  onMouseDown={() => {
                    onImageUpload?.();
                    onClose();
                  }}
                />
              );
            }

            if (entry.kind === "mode") {
              return (
                <ModeRow
                  key={`mode-${entry.mode.id}`}
                  mode={entry.mode}
                  isActive={
                    keyboardNavigated && entry.flatIndex === highlightIndex
                  }
                  isCurrent={entry.mode.id === currentMode}
                  onMouseEnter={() => {
                    if (!mouseMovedRef.current) return;
                    setKeyboardNavigated(false);
                    setHighlightIndex(entry.flatIndex);
                    setOpenFlyout(null);
                  }}
                  onMouseDown={() => onModeSelect(entry.mode.id)}
                />
              );
            }

            if (entry.kind === "flyout") {
              const { flatIndex, category, label, items: flyoutItems } = entry;
              return (
                <FlyoutTriggerRow
                  key={`flyout-${category}`}
                  category={category}
                  label={label}
                  isActive={keyboardNavigated && flatIndex === highlightIndex}
                  isOpen={
                    openFlyout?.kind === "category" &&
                    openFlyout.category === category
                  }
                  onMouseEnter={(e) => {
                    if (!mouseMovedRef.current) return;
                    setKeyboardNavigated(false);
                    setHighlightIndex(flatIndex);
                    setOpenFlyout({
                      kind: "category",
                      category,
                      anchorTop: e.currentTarget.getBoundingClientRect().top,
                      items: flyoutItems,
                    });
                  }}
                  onMouseDown={(e) => {
                    openCategoryFlyout(
                      e,
                      openFlyout?.kind === "category" &&
                        openFlyout.category === category
                        ? null
                        : {
                            kind: "category",
                            category,
                            anchorTop: 0,
                            items: flyoutItems,
                          }
                    );
                  }}
                />
              );
            }

            // entry.kind === "item" (flat rows when searching)
            const { item, flatIndex } = entry;
            return (
              <SlashItemRow
                key={`${item.category}-${item.source}-${item.name}`}
                item={item}
                isActive={keyboardNavigated && flatIndex === highlightIndex}
                onMouseEnter={() => {
                  if (!mouseMovedRef.current) return;
                  setKeyboardNavigated(false);
                  setHighlightIndex(flatIndex);
                  setOpenFlyout(null);
                }}
                onClick={() => {
                  onSelect(item);
                }}
              />
            );
          })}

          {loading && items.length === 0 && (
            <div className="px-3 py-2 text-sm text-text-3">
              {t("status.loading", { ns: "common" })}
            </div>
          )}
          {!loading && entries.length === 0 && (
            <div className="px-3 py-2 text-sm text-text-3">
              {t("placeholders.noItems", { ns: "common" })}
            </div>
          )}
        </div>
      </div>

      {/* Category flyout (Skills / MCP Servers) */}
      {openFlyout?.kind === "category" &&
        openFlyout.items &&
        openFlyout.category && (
          <FlyoutSubmenu
            items={openFlyout.items}
            category={openFlyout.category}
            anchorTop={openFlyout.anchorTop}
            panelRight={panelRight}
            highlightIndex={flyoutHighlightIndex}
            keyboardNavigated={keyboardNavigated}
            onHighlightChange={setFlyoutHighlightIndex}
            onPointerNavigate={() => {
              if (!mouseMovedRef.current) return;
              setKeyboardNavigated(false);
            }}
            onSelect={(item) => {
              onSelect(item);
              setOpenFlyout(null);
            }}
            onClose={() => setOpenFlyout(null)}
          />
        )}
    </div>,
    document.body
  );
};

SlashCommandMenu.displayName = "SlashCommandMenu";

export default SlashCommandMenu;
