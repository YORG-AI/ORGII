/**
 * EconomySidebar
 *
 * Second-level sidebar for Economy pages.
 * Entering Economy replaces the HomeSidebar list with a focused page-level
 * list and a back affordance to the Start Page.
 */
import { BadgeCent } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { ROUTES, getIconComponentForPath } from "@src/config/routes";
import { useRouteLabel } from "@src/hooks/i18n";
import { ECONOMY_ROUTES } from "@src/modules/MainApp/shared/economyRouteConfig";

import type { PageLevelSidebarItem } from "./PageLevelSidebar";
import PageLevelSidebar from "./PageLevelSidebar";

const EconomySidebar: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation("navigation");
  const { getTranslatedRouteLabel } = useRouteLabel();

  const items = useMemo<PageLevelSidebarItem[]>(
    () =>
      ECONOMY_ROUTES.map((route) => ({
        key: route.path,
        label: getTranslatedRouteLabel(route),
        icon: getIconComponentForPath(route.path) ?? BadgeCent,
      })),
    [getTranslatedRouteLabel]
  );

  const activeKey = useMemo(() => {
    const activeRoute = [...ECONOMY_ROUTES]
      .sort(
        (leftRoute, rightRoute) =>
          rightRoute.path.length - leftRoute.path.length
      )
      .find((route) => location.pathname.startsWith(route.path));

    return activeRoute?.path ?? ROUTES.app.market.tokenMarket.path;
  }, [location.pathname]);

  const handleItemClick = useCallback(
    (key: string) => {
      navigate(key, { replace: false });
    },
    [navigate]
  );

  const handleBack = useCallback(() => {
    navigate(ROUTES.app.home.start.path, { replace: false });
  }, [navigate]);

  return (
    <PageLevelSidebar
      backLabel={t("labels.economy")}
      onBack={handleBack}
      items={items}
      activeKey={activeKey}
      onItemClick={handleItemClick}
    />
  );
};

export default EconomySidebar;
