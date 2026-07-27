/**
 * Settings List Panel Component
 *
 * Left panel for Settings page with anchor navigation for app sections.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { MenuPanel, type MenuPanelItem } from "@src/components/ListPanel";

import { APP_SECTIONS } from "./config";

interface SettingsListPanelProps {
  activeSection: string;
  onSectionClick: (sectionId: string) => void;
}

const SettingsListPanel: React.FC<SettingsListPanelProps> = ({
  activeSection,
  onSectionClick,
}) => {
  const { t } = useTranslation("settings");

  const items = useMemo<MenuPanelItem<string>[]>(
    () =>
      APP_SECTIONS.map((section) => ({
        key: section.id,
        label: t(`sections.${section.labelKey}`),
        icon: section.icon,
      })),
    [t]
  );

  return (
    <MenuPanel
      items={items}
      activeView={activeSection}
      onViewChange={onSectionClick}
    />
  );
};

export default SettingsListPanel;
