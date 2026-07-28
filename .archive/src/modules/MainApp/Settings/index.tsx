import React, { Suspense, lazy, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { TabPillItem } from "@src/components/TabPill/types";
import { assertSettingsUiParity } from "@src/config/settingsSchema/assertSettingsUiParity";
import { getSettingsSectionById } from "@src/config/settingsUiManifest";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import { SettingsMainContent } from "./components/SettingsMainContent";
import { SECTION_TAB_META } from "./config";
import { useSettingsMonitorToolbar } from "./hooks/useSettingsMonitorToolbar";
import { useSettingsRouteState } from "./hooks/useSettingsRouteState";

const EditorAppearancePage = lazy(
  () => import("./subpages/EditorAppearancePage")
);

const Settings: React.FC = () => {
  const { t } = useTranslation("settings");
  const { activeSection, activeSectionTab, subpage, handleSectionTabChange } =
    useSettingsRouteState();
  useSettingsMonitorToolbar(activeSection, t);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      assertSettingsUiParity();
    }
  }, []);

  const activeSectionDefinition = useMemo(
    () => getSettingsSectionById(activeSection),
    [activeSection]
  );
  const activeSectionTitle = activeSectionDefinition
    ? t(activeSectionDefinition.headingTitleKey)
    : "";
  const activeSectionTabs = useMemo<TabPillItem[]>(() => {
    const metadata = SECTION_TAB_META[activeSection];
    if (metadata) {
      return metadata.map(({ key, labelKey }) => ({
        key,
        label: t(labelKey),
      }));
    }
    return [{ key: activeSection, label: activeSectionTitle }];
  }, [activeSection, activeSectionTitle, t]);

  if (subpage === "editor-appearance") {
    return (
      <div className="settings-page h-full overflow-hidden">
        <Suspense
          fallback={<Placeholder variant="loading" placement="detail-panel" />}
        >
          <EditorAppearancePage />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="settings-page h-full overflow-hidden">
      <SettingsMainContent
        activeSection={activeSection}
        activeSectionTab={activeSectionTab}
        tabs={activeSectionTabs}
        onTabChange={handleSectionTabChange}
      />
    </div>
  );
};

export default Settings;
