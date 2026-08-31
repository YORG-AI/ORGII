/**
 * PageBreadcrumb Component
 *
 * Displays tab icon + name using shared PANEL_HEADER_TOKENS.
 * When sidebar is collapsed, clicking triggers the floating sidebar.
 * Used in split panel headers.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import AnyIcon from "@src/components/AnyIcon";
import { deriveBreadcrumbKeys, getPathIcon } from "@src/config/mainAppPaths";
import { findRouteByPath, getLabelForPath } from "@src/config/routes";
import { useRouteLabel } from "@src/hooks/i18n";
import { useSafeHover } from "@src/hooks/ui/useSafeHover";
import {
  ArrowLeftRightIcon,
  ArrowRight01Icon,
  HugeiconsIcon,
} from "@src/icons";
import { hoverSidebarOpenAtom } from "@src/store/ui/hoverSidebarAtom";
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";

import { PANEL_HEADER_TOKENS } from "../PanelHeader";

// ============================================
// Component
// ============================================

export interface PageBreadcrumbProps {
  /** Optional custom className */
  className?: string;
}

const Separator: React.FC = () => (
  <HugeiconsIcon
    icon={ArrowRight01Icon}
    data-icon="chevron-right"
    size={13}
    className="shrink-0 text-text-3"
  />
);

const PageBreadcrumb: React.FC<PageBreadcrumbProps> = ({ className = "" }) => {
  const location = useLocation();
  const isSidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const setIsHoverSidebarOpen = useSetAtom(hoverSidebarOpenAtom);
  const [ref, isHovered] = useSafeHover<HTMLDivElement>();
  const { t } = useTranslation();
  const { getTranslatedLabelForPath } = useRouteLabel();

  const currentRoute = useMemo(() => {
    const path = location.pathname;
    const routeInfo = findRouteByPath(path);
    if (!routeInfo) return null;

    const icon = getPathIcon(path);
    const keys = deriveBreadcrumbKeys(path);
    const labels = keys.map((key) => t(key));

    if (labels.length === 0) {
      labels.push(getTranslatedLabelForPath(getLabelForPath(path)));
    }

    return { labels, IconComponent: icon };
  }, [getTranslatedLabelForPath, location.pathname, t]);

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
      ? ArrowLeftRightIcon
      : currentRoute.IconComponent;

  return (
    <div
      ref={ref}
      className={`flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2 transition-colors ${
        isSidebarCollapsed ? "active:bg-bg-4 cursor-pointer hover:bg-bg-3" : ""
      } ${className}`}
      onClick={handleClick}
    >
      {IconComponent && (
        <AnyIcon
          icon={IconComponent}
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
          return (
            <React.Fragment key={`${label}-${index}`}>
              {index > 0 ? <Separator /> : null}
              <span
                className={`min-w-0 truncate ${
                  isLast ? "font-medium text-text-1" : "text-text-2"
                }`}
              >
                {label}
              </span>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

export default PageBreadcrumb;
