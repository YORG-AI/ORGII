import React, { Suspense, lazy, memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import TabPill, { type TabPillItem } from "@src/components/TabPill";
import { SECTION_GAP_CLASSES } from "@src/modules/shared/layouts/SectionLayout";
import {
  DETAIL_PANEL_TOKENS,
  InternalHeader,
  Placeholder,
  ScrollPreservation,
} from "@src/modules/shared/layouts/blocks";

type RuntimeSection = "usage" | "quota" | "scanning" | "hooks" | "assets";

const SessionUsagePanel = lazy(() => import("./SessionUsagePanel"));
const RuntimeScanningPanel = lazy(() => import("./RuntimeScanningPanel"));
const SessionProvenanceHooksPanel = lazy(
  () => import("./SessionProvenanceHooksPanel")
);
const StartPageQuotaGrid = lazy(() =>
  import("@src/engines/ChatPanel/StartPageQuotaGrid").then((module) => ({
    default: module.StartPageQuotaGrid,
  }))
);
const WorkspaceDashboardPanelView = lazy(
  () => import("@src/engines/ChatPanel/panels/WorkspaceDashboardPanelView")
);

interface RuntimeSectionTabsProps {
  activeView: RuntimeSection;
  onChange: (view: RuntimeSection) => void;
}

const RuntimeSectionTabs: React.FC<RuntimeSectionTabsProps> = memo(
  ({ activeView, onChange }) => {
    const { t } = useTranslation("sessions", {
      keyPrefix: "kanban.dataSource",
    });
    const viewTabs = useMemo<TabPillItem[]>(
      () => [
        {
          key: "usage",
          label: t("views.usage"),
          dataTestId: "data-source-view-usage",
        },
        {
          key: "quota",
          label: t("views.quota"),
          dataTestId: "data-source-view-quota",
        },
        {
          key: "scanning",
          label: t("views.scanning"),
          dataTestId: "data-source-view-scanning",
        },
        {
          key: "hooks",
          label: t("views.hooks"),
          dataTestId: "data-source-view-hooks",
        },
        {
          key: "assets",
          label: t("views.assets"),
          dataTestId: "data-source-view-assets",
        },
      ],
      [t]
    );

    return (
      <TabPill
        activeTab={activeView}
        tabs={viewTabs}
        onChange={(key) => onChange(key as RuntimeSection)}
        variant="simple"
        size="large"
        fillWidth={false}
      />
    );
  }
);

RuntimeSectionTabs.displayName = "RuntimeSectionTabs";

function RuntimeSectionContent({
  activeView,
}: {
  activeView: RuntimeSection;
}): React.ReactElement {
  switch (activeView) {
    case "usage":
      return <SessionUsagePanel />;
    case "quota":
      return <StartPageQuotaGrid />;
    case "scanning":
      return <RuntimeScanningPanel />;
    case "hooks":
      return <SessionProvenanceHooksPanel showTitle={false} />;
    case "assets":
      return <WorkspaceDashboardPanelView />;
  }
}

const RuntimeDataSourcePanel: React.FC = () => {
  const [panelView, setPanelView] = useState<RuntimeSection>("usage");
  const loadingFallback = (
    <Placeholder variant="loading" placement="detail-panel" />
  );

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col overflow-hidden">
      <InternalHeader
        noPanelHeader
        contentPadding
        className={DETAIL_PANEL_TOKENS.headerWidth}
        tabs={
          <div className="flex w-full justify-center">
            <RuntimeSectionTabs
              activeView={panelView}
              onChange={setPanelView}
            />
          </div>
        }
      />

      <ScrollPreservation
        data-testid="data-source-scroll-region"
        className={
          panelView === "assets"
            ? "min-h-0 flex-1 overflow-hidden scrollbar-hide"
            : "min-h-0 flex-1 overflow-y-auto px-4 scrollbar-hide @container"
        }
      >
        {panelView === "assets" ? (
          <Suspense key={panelView} fallback={loadingFallback}>
            <RuntimeSectionContent activeView={panelView} />
          </Suspense>
        ) : (
          <div
            className={`${DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop} ${SECTION_GAP_CLASSES}`}
          >
            <Suspense key={panelView} fallback={loadingFallback}>
              <RuntimeSectionContent activeView={panelView} />
            </Suspense>
          </div>
        )}
      </ScrollPreservation>
    </div>
  );
};

export default RuntimeDataSourcePanel;
