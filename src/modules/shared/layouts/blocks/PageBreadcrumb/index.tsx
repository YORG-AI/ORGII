/**
 * PageBreadcrumb Component
 *
 * Displays tab icon + name using shared PANEL_HEADER_TOKENS.
 * When sidebar is collapsed, clicking triggers the floating sidebar.
 * Used in split panel headers.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { ArrowLeftRight, Check, ChevronRight } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import { deriveBreadcrumbKeys, getPathIcon } from "@src/config/mainAppPaths";
import { findRouteByPath, getLabelForPath } from "@src/config/routes";
import { getIconComponentForPath } from "@src/config/routes";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { useRouteLabel } from "@src/hooks/i18n";
import { useSafeHover } from "@src/hooks/ui/useSafeHover";
import {
  ECONOMY_ROOT_PATH,
  ECONOMY_ROUTES,
} from "@src/modules/MainApp/shared/economyRouteConfig";
import { hoverSidebarOpenAtom } from "@src/store/ui/hoverSidebarAtom";
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";

import { BreadcrumbPillNavTrigger } from "../BreadcrumbPillNav";
import { PANEL_HEADER_TOKENS } from "../PanelHeader";

// ============================================
// Component
// ============================================

export interface PageBreadcrumbProps {
  /** Optional custom className */
  className?: string;
}

interface BreadcrumbSelectorItem {
  key: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }> | null;
}

function getActiveSelectableItem(
  items: readonly BreadcrumbSelectorItem[],
  pathname: string
): BreadcrumbSelectorItem | null {
  return (
    [...items]
      .sort((leftItem, rightItem) => rightItem.key.length - leftItem.key.length)
      .find((item) => pathname.startsWith(item.key)) ??
    items[0] ??
    null
  );
}

const Separator: React.FC = () => (
  <ChevronRight size={13} className="shrink-0 text-text-3" />
);

const PageBreadcrumb: React.FC<PageBreadcrumbProps> = ({ className = "" }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const isSidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const setIsHoverSidebarOpen = useSetAtom(hoverSidebarOpenAtom);
  const [ref, isHovered] = useSafeHover<HTMLDivElement>();
  const [selectorOpen, setSelectorOpen] = useState(false);
  const { t } = useTranslation();
  const { getTranslatedRouteLabel, getTranslatedLabelForPath } =
    useRouteLabel();

  const currentRoute = useMemo(() => {
    const path = location.pathname;
    const routeInfo = findRouteByPath(path);
    if (!routeInfo) return null;

    const icon = getPathIcon(path);
    const keys = deriveBreadcrumbKeys(path);
    const labels = keys.map((key) => t(key));
    let selectorItems: BreadcrumbSelectorItem[] = [];
    let activeSelectorItem: BreadcrumbSelectorItem | null = null;
    let selectorReplacesLeaf = false;

    if (path.startsWith(ECONOMY_ROOT_PATH)) {
      selectorItems = ECONOMY_ROUTES.map((route) => ({
        key: route.path,
        label: getTranslatedRouteLabel(route),
        icon: getIconComponentForPath(route.path),
      }));
      activeSelectorItem = getActiveSelectableItem(selectorItems, path);
      selectorReplacesLeaf = true;
    }

    if (activeSelectorItem) {
      if (selectorReplacesLeaf && labels.length > 0) {
        labels[labels.length - 1] = activeSelectorItem.label;
      } else {
        labels.push(activeSelectorItem.label);
      }
    }

    if (labels.length === 0) {
      labels.push(getTranslatedLabelForPath(getLabelForPath(path)));
    }

    return { labels, IconComponent: icon, selectorItems, activeSelectorItem };
  }, [
    getTranslatedLabelForPath,
    getTranslatedRouteLabel,
    location.pathname,
    t,
  ]);

  const selectorItems = currentRoute?.selectorItems ?? [];

  const handleSelectorSelect = useCallback(
    (item: BreadcrumbSelectorItem) => {
      navigate(item.key, { replace: false });
      setSelectorOpen(false);
    },
    [navigate]
  );

  const {
    isOpen,
    isPositioned,
    toggle,
    triggerRef,
    panelRef,
    panelPosition,
    keyboard,
  } = useDropdownEngine<HTMLButtonElement, BreadcrumbSelectorItem>({
    open: selectorOpen,
    onOpenChange: setSelectorOpen,
    disabled: selectorItems.length === 0,
    gap: DROPDOWN_PANEL.triggerGapTight,
    placement: "bottom",
    align: "left",
    listNavigation: {
      disableGlobalListener: true,
      items: selectorItems,
      onSelect: handleSelectorSelect,
    },
  });

  // Handle click - trigger floating sidebar when collapsed
  const handleClick = useCallback(() => {
    if (isSidebarCollapsed) {
      setIsHoverSidebarOpen(true);
    }
  }, [isSidebarCollapsed, setIsHoverSidebarOpen]);

  if (!currentRoute) {
    return null;
  }

  // Show ArrowLeftRight icon on hover when sidebar is collapsed
  const IconComponent =
    isSidebarCollapsed && isHovered
      ? ArrowLeftRight
      : currentRoute.IconComponent;
  const selectorLabel = currentRoute.activeSelectorItem?.label;
  const dropdown =
    isOpen && isPositioned
      ? createPortal(
          <div
            ref={panelRef}
            className={`${DROPDOWN_CLASSES.panel} fixed flex min-w-[220px] flex-col p-1`}
            onKeyDown={keyboard.handleKeyDown}
            style={{
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left: panelPosition.left,
              right: panelPosition.right,
              minWidth: Math.max(panelPosition.width, 220),
            }}
          >
            <div className={DROPDOWN_CLASSES.itemsColumn}>
              {selectorItems.map((item, index) => {
                const ItemIcon = item.icon;
                const isSelected =
                  item.key === currentRoute.activeSelectorItem?.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    {...keyboard.getItemProps(index)}
                    className={`${DROPDOWN_CLASSES.item} w-full justify-start text-left ${
                      isSelected
                        ? DROPDOWN_CLASSES.itemSelected
                        : DROPDOWN_CLASSES.itemHover
                    }`}
                  >
                    {ItemIcon ? (
                      <ItemIcon
                        size={DROPDOWN_ITEM.iconSize}
                        className={`shrink-0 ${
                          isSelected ? "text-primary-6" : "text-text-2"
                        }`}
                      />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">
                      {item.label}
                    </span>
                    {isSelected ? (
                      <Check
                        size={DROPDOWN_ITEM.iconSize}
                        className="shrink-0 text-primary-6"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <div
        ref={ref}
        className={`flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2 transition-colors ${
          isSidebarCollapsed
            ? "active:bg-bg-4 cursor-pointer hover:bg-bg-3"
            : ""
        } ${className}`}
        onClick={handleClick}
      >
        {IconComponent && (
          <IconComponent
            size={PANEL_HEADER_TOKENS.iconSize}
            className="shrink-0 text-text-2"
          />
        )}
        <div
          className="flex min-w-0 items-center gap-1"
          style={{ fontSize: PANEL_HEADER_TOKENS.fontSize }}
        >
          {currentRoute.labels.map((label, index) => {
            const isLast = index === currentRoute.labels.length - 1;
            const shouldRenderSelector = isLast && selectorLabel;
            return (
              <React.Fragment key={`${label}-${index}`}>
                {index > 0 ? <Separator /> : null}
                {shouldRenderSelector ? (
                  <BreadcrumbPillNavTrigger
                    ref={triggerRef}
                    isOpen={isOpen}
                    variant="primary"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle();
                    }}
                    aria-haspopup="listbox"
                    aria-expanded={isOpen}
                    className="min-w-0"
                  >
                    <span className="min-w-0 truncate">{selectorLabel}</span>
                  </BreadcrumbPillNavTrigger>
                ) : (
                  <span
                    className={`min-w-0 truncate ${
                      isLast ? "font-medium text-text-1" : "text-text-2"
                    }`}
                  >
                    {label}
                  </span>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>
      {dropdown}
    </>
  );
};

export default PageBreadcrumb;
