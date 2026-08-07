import React, { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import type { SlashItem, SlashItemCategory } from "@src/types/extensions";

import { categoryIcon } from "./constants";

interface FlyoutSubmenuProps {
  items: SlashItem[];
  category: SlashItemCategory;
  /** Top of the anchor row in viewport coordinates. */
  anchorTop: number;
  /** Right edge of the main panel in viewport coordinates. */
  panelRight: number;
  onSelect: (item: SlashItem) => void;
  onClose: () => void;
  /** Controlled highlight index (keyboard-driven from parent). */
  highlightIndex: number;
  keyboardNavigated: boolean;
  onHighlightChange: (idx: number) => void;
  onPointerNavigate: () => void;
}

/**
 * Right-side child panel for flyout categories (Skills, MCP Servers).
 * Items are grouped by source/serverName when more than one group exists.
 * Positioned to the right of the main panel, vertically aligned to the trigger row.
 */
const FlyoutSubmenu: React.FC<FlyoutSubmenuProps> = ({
  items,
  anchorTop,
  panelRight,
  onSelect,
  onClose,
  highlightIndex,
  keyboardNavigated,
  onHighlightChange,
  onPointerNavigate,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const map = new Map<string, SlashItem[]>();
    for (const item of items) {
      const key = item.serverName ?? item.source ?? "default";
      const existing = map.get(key) ?? [];
      existing.push(item);
      map.set(key, existing);
    }
    return map;
  }, [items]);

  const groupKeys = useMemo(() => [...groups.keys()], [groups]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!panelRef.current) return;
    const itemEls = panelRef.current.querySelectorAll("[data-slash-flat]");
    itemEls[highlightIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  // Close on click outside the flyout panel.
  useEffect(() => {
    let portalReady = false;
    const readyFrame = window.requestAnimationFrame(() => {
      portalReady = true;
    });

    const handler = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;

      const panel = panelRef.current;
      if (!panel && !portalReady) return;
      if (panel?.contains(target)) return;
      if (document.querySelector("[data-slash-portal]")?.contains(target)) {
        return;
      }

      onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => {
      window.cancelAnimationFrame(readyFrame);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={panelRef}
      className={`${DROPDOWN_CLASSES.panel} flex flex-col overflow-hidden`}
      data-dropdown-keyboard-mode={keyboardNavigated ? "true" : undefined}
      style={{
        position: "fixed",
        top: anchorTop,
        left: panelRight + DROPDOWN_PANEL.submenuGap,
        minWidth: 200,
        maxWidth: 280,
        zIndex: DROPDOWN_PANEL.portalSubmenuZIndex,
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div
        className={`max-h-[320px] overflow-y-auto ${DROPDOWN_PANEL.paddingClass} scrollbar-hide`}
      >
        {groupKeys.map((groupKey) => {
          const groupItems = groups.get(groupKey) ?? [];
          return (
            <div key={groupKey}>
              <div className={`${DROPDOWN_CLASSES.sectionLabel} first:pt-1`}>
                {groupKey}
              </div>
              {groupItems.map((item) => {
                const idx = items.indexOf(item);
                const Icon = categoryIcon(item.category);
                const desc =
                  item.description && item.description !== "---"
                    ? item.description
                    : undefined;
                return (
                  <div
                    key={`${item.source}-${item.name}`}
                    data-slash-flat
                    className={`${DROPDOWN_CLASSES.item} group cursor-pointer justify-between ${
                      keyboardNavigated && idx === highlightIndex
                        ? "bg-fill-2"
                        : "hover:bg-fill-2"
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onSelect(item);
                    }}
                    onMouseEnter={() => {
                      onPointerNavigate();
                      onHighlightChange(idx);
                    }}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {React.createElement(Icon, {
                        size: 14,
                        strokeWidth: 1.75,
                        className: "shrink-0 text-text-2",
                      })}
                      <span className="truncate text-[13px] text-text-1">
                        {item.name}
                      </span>
                      {desc && (
                        <span
                          className="truncate text-[11px] text-text-3"
                          style={{ maxWidth: 110 }}
                        >
                          {desc}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>,
    document.body
  );
};

FlyoutSubmenu.displayName = "FlyoutSubmenu";

export default FlyoutSubmenu;
