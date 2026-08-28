/**
 * FactoryViewPill
 *
 * Header controls for the Kanban station.
 * Toggles between Kanban board, list view, and daily Diary. Data Sources is a
 * navigation affordance that opens the canonical Runtime tab.
 *
 * View is stored in the URL search param `?view=kanban|list|diary` so it
 * survives navigation and can be bookmarked/shared. Defaults to "kanban".
 */
import { useSetAtom } from "jotai";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import TabPill, { type TabPillItem } from "@src/components/TabPill";
import { HugeiconsIcon, SquareArrowUpRightIcon } from "@src/icons";
import { openRuntimeInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";

export type FactoryViewMode = "kanban" | "list" | "diary";

const RUNTIME_DATA_SOURCES_KEY = "runtime-data-sources";

export function parseFactoryViewMode(search: string): FactoryViewMode {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  if (view === "list") return "list";
  if (view === "diary") return "diary";
  return "kanban";
}

const FactoryViewPill: React.FC = () => {
  const { t } = useTranslation("sessions");
  const navigate = useNavigate();
  const location = useLocation();
  const openRuntimeTab = useSetAtom(openRuntimeInChatPanelTabAtom);

  const activeView = parseFactoryViewMode(location.search);
  const tabs = useMemo<TabPillItem[]>(
    () => [
      { key: "kanban", label: t("simulator.tabs.kanban") },
      {
        key: "list",
        label: t("kanban.view.list"),
        dataTestId: "kanban-view-list",
      },
      { key: "diary", label: t("kanban.view.diary") },
      {
        key: RUNTIME_DATA_SOURCES_KEY,
        label: t("kanban.view.dataSource"),
        dataTestId: "kanban-view-data-source-runtime",
        hoverBadge: (
          <HugeiconsIcon
            icon={SquareArrowUpRightIcon}
            data-icon="square-arrow-out-up-right"
            size={11}
            strokeWidth={1.75}
            aria-hidden="true"
            data-testid="kanban-data-source-runtime-icon"
          />
        ),
      },
    ],
    [t]
  );

  const handleViewChange = useCallback(
    (view: FactoryViewMode | typeof RUNTIME_DATA_SOURCES_KEY) => {
      if (view === RUNTIME_DATA_SOURCES_KEY) {
        openRuntimeTab(t("chat.startPage.tabs.runtime"));
        return;
      }
      const params = new URLSearchParams(location.search);
      if (view === "kanban") {
        params.delete("view");
      } else {
        params.set("view", view);
      }
      const search = params.toString();
      navigate({ search: search ? `?${search}` : "" }, { replace: true });
    },
    [location.search, navigate, openRuntimeTab, t]
  );

  return (
    <TabPill
      activeTab={activeView}
      tabs={tabs}
      onChange={(key) =>
        handleViewChange(
          key as FactoryViewMode | typeof RUNTIME_DATA_SOURCES_KEY
        )
      }
      variant="pill"
      color="fill"
      fillWidth={false}
      size="small"
    />
  );
};

export default FactoryViewPill;
