/**
 * SlashCommandMenu — the main dropdown panel.
 *
 * Composes the skills-only entry list, floating placement, and keyboard model.
 */
import { useAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import FileTreePreview from "@src/components/FileTreePreview";
import { INPUT_AREA_MENU_FRAME } from "@src/config/inputAreaTokens";
import { useMouseMoved } from "@src/hooks/ui/useMouseMoved";
import {
  getPinnedActionKey,
  pinnedActionsAtom,
  slashItemToPinnedAction,
} from "@src/store/session/pinnedActionsAtom";
import type { SlashItem } from "@src/types/extensions";

import { usePathTreePosition } from "../pathTreePosition";
import { useFloatingPortalPosition } from "../useFloatingPortalPosition";
import {
  MenuGroupSeparatorRow,
  SectionHeaderRow,
  SlashItemRow,
} from "./MenuRows";
import type { SlashCommandPortalProps } from "./types";
import { useEntries } from "./useEntries";
import { useKeyboard } from "./useKeyboard";

const MAX_PANEL_HEIGHT = 300;
const OUTSIDE_CLICK_GRACE_MS = 120;

const SlashCommandMenu: React.FC<SlashCommandPortalProps> = ({
  visible,
  containerRef,
  anchorSelector,
  items,
  loading,
  searchQuery = "",
  onClose,
  onSelect,
  keyboardHandlerRef,
}) => {
  const { t } = useTranslation("sessions");
  const treePosition = usePathTreePosition();
  const portalContainerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuOpenedAtRef = useRef(0);
  const [pinnedActions, setPinnedActions] = useAtom(pinnedActionsAtom);
  const pinnedKeys = useMemo(
    () => new Set(pinnedActions.map(getPinnedActionKey)),
    [pinnedActions]
  );

  // Build the unified entry list
  const { entries, totalFlat } = useEntries({
    items,
    searchQuery,
    pinnedActions,
  });
  const handleTogglePin = useCallback(
    (item: SlashItem) => {
      const action = slashItemToPinnedAction(item);
      const key = getPinnedActionKey(action);
      setPinnedActions((previous) =>
        previous.some((candidate) => getPinnedActionKey(candidate) === key)
          ? previous.filter(
              (candidate) => getPinnedActionKey(candidate) !== key
            )
          : [...previous, action]
      );
    },
    [setPinnedActions]
  );

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
  const [keyboardNavigated, setKeyboardNavigated] = useState(true);

  const placementUpdateKey = `${searchQuery}\0${entries.length}`;
  const { portalPosition, portalWidth, portalMaxHeight, isPositioned } =
    useFloatingPortalPosition({
      visible,
      containerRef,
      floatingRef: portalContainerRef,
      fallbackHeight: 320,
      ...INPUT_AREA_MENU_FRAME,
      anchorSelector,
      updateKey: placementUpdateKey,
      maxHeight: MAX_PANEL_HEIGHT,
    });

  // Reset highlight to the first actionable row when the list shape changes.
  const listIdentity = useMemo(
    () =>
      `${entries
        .map((entry) =>
          entry.kind === "item"
            ? getPinnedActionKey(entry.item)
            : `${entry.kind}:${entry.kind === "header" ? entry.label : ""}`
        )
        .join("\0")}\0${searchQuery}`,
    [entries, searchQuery]
  );
  const [trackedIdentity, setTrackedIdentity] = useState(listIdentity);
  if (trackedIdentity !== listIdentity) {
    setTrackedIdentity(listIdentity);
    setHighlightIndex(0);
    setKeyboardNavigated(true);
  }

  // Scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current) return;
    const itemEls = listRef.current.querySelectorAll("[data-slash-flat]");
    itemEls[highlightIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  // Click outside → close.
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
    setHighlightIndex,
    setKeyboardNavigated,
    onSelect,
    onTogglePin: handleTogglePin,
    onClose,
    keyboardHandlerRef,
  });

  if (!isPositioned || !portalPosition) return null;

  const portalStyle = {
    top: portalPosition.top,
    bottom: portalPosition.bottom,
    left: portalPosition.left,
    width: portalWidth,
  };

  return createPortal(
    <div
      ref={portalContainerRef}
      data-slash-portal
      className="fixed z-99999 flex flex-col gap-2"
      style={portalStyle}
    >
      {activeSkillItem?.skillPath && (
        <div
          className={`absolute top-0 ${treePosition === "left" ? "right-full" : "left-full"}`}
          style={{
            marginLeft:
              treePosition === "right" ? DROPDOWN_PANEL.submenuGap : undefined,
            marginRight:
              treePosition === "left" ? DROPDOWN_PANEL.submenuGap : undefined,
            pointerEvents: "auto",
          }}
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
        onMouseDown={(e) => e.preventDefault()}
      >
        <div
          className={`overflow-y-auto ${DROPDOWN_PANEL.paddingClass} scrollbar-hide`}
          style={{ maxHeight: portalMaxHeight }}
        >
          {entries.map((entry, mapIdx) => {
            if (entry.kind === "divider") {
              return <MenuGroupSeparatorRow key={`divider-${mapIdx}`} />;
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

            // entry.kind === "item"
            const { item, flatIndex } = entry;
            return (
              <SlashItemRow
                key={`${item.category}-${item.source}-${item.name}`}
                item={item}
                isActive={keyboardNavigated && flatIndex === highlightIndex}
                isPinned={pinnedKeys.has(getPinnedActionKey(item))}
                onMouseEnter={() => {
                  if (!mouseMovedRef.current) return;
                  setKeyboardNavigated(false);
                  setHighlightIndex(flatIndex);
                }}
                onClick={() => {
                  onSelect(item);
                }}
                onTogglePin={() => handleTogglePin(item)}
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
    </div>,
    document.body
  );
};

SlashCommandMenu.displayName = "SlashCommandMenu";

export default SlashCommandMenu;
