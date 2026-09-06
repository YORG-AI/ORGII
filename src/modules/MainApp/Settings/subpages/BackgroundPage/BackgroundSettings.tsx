/**
 * BackgroundSettings Component
 * Main orchestrator for background customization settings
 */
import {
  DETAIL_PANEL_TOKENS,
  PanelHeader,
  ScrollFadeContainer,
} from "@/src/modules/shared/layouts/blocks";
import React from "react";
import { useTranslation } from "react-i18next";

import Select from "@src/components/Select";
import Slider from "@src/components/Slider";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  DEFAULT_PAGE_OPACITY,
  DEFAULT_SIDEBAR_OPACITY,
  MAX_PAGE_OPACITY,
  MAX_SIDEBAR_OPACITY,
  MIN_PAGE_OPACITY,
  MIN_SIDEBAR_OPACITY,
} from "@src/store/ui/backgroundConfigAtom";

import { ColorSection } from "./components";
import { useBackgroundSettings } from "./hooks";
import type { BackgroundSettingsProps } from "./types";

export const BackgroundSettings: React.FC<BackgroundSettingsProps> = ({
  showHeader = true,
  embedded = false,
  translationNamespace = "settings",
}) => {
  const { t } = useTranslation(translationNamespace);

  const {
    // State
    config,
    appearanceMode,
    appearanceModeOptions,
    skinOptions,
    activeSkinId,
    handleSkinChange,
    // Handlers
    handleBack,
    handleColorSelect,
    handleSelectCustomPaletteHex,
    handleAddCustomPaletteHex,
    handleRemoveCustomPaletteHex,
    handlePageOpacityChange,
    handleSidebarOpacityChange,
    handleAppearanceModeChange,
  } = useBackgroundSettings();

  const showAppearanceChrome = !embedded;

  const sections = (
    <>
      {showAppearanceChrome && (
        <div className="flex flex-col gap-2">
          <SectionRow compact label={t("general.appearanceMode")}>
            <Select
              value={appearanceMode}
              onChange={handleAppearanceModeChange}
              options={appearanceModeOptions}
              size="default"
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
          <SectionRow compact label={t("general.skins")}>
            <Select
              value={activeSkinId}
              onChange={handleSkinChange}
              options={skinOptions}
              showSearch
              size="default"
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
        </div>
      )}

      <SectionContainer title={t("background.title")}>
        <ColorSection
          config={config}
          translationNamespace={translationNamespace}
          onColorSelect={handleColorSelect}
          onSelectCustomHex={handleSelectCustomPaletteHex}
          onAddCustomHex={handleAddCustomPaletteHex}
          onRemoveCustomHex={handleRemoveCustomPaletteHex}
        />

        <SectionRow label={t("background.pageOpacity")}>
          <div className="min-w-0" style={SECTION_CONTROL_STYLE}>
            <Slider
              min={MIN_PAGE_OPACITY}
              max={MAX_PAGE_OPACITY}
              value={config.pageOpacity ?? DEFAULT_PAGE_OPACITY}
              onValueChange={handlePageOpacityChange}
              noPadding
            />
          </div>
        </SectionRow>

        <SectionRow label={t("background.sidebarOpacity")}>
          <div className="min-w-0" style={SECTION_CONTROL_STYLE}>
            <Slider
              min={MIN_SIDEBAR_OPACITY}
              max={MAX_SIDEBAR_OPACITY}
              value={config.sidebarOpacity ?? DEFAULT_SIDEBAR_OPACITY}
              onValueChange={handleSidebarOpacityChange}
              noPadding
            />
          </div>
        </SectionRow>
      </SectionContainer>
    </>
  );

  if (embedded) {
    return <>{sections}</>;
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {showHeader && (
        <PanelHeader
          onBack={handleBack}
          breadcrumb={{
            parent: t("sections.general"),
            current: t("background.title"),
          }}
        />
      )}

      <ScrollFadeContainer className="scrollbar-hide min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div
          className={`${DETAIL_PANEL_TOKENS.contentWidth} flex flex-col gap-3`}
        >
          {sections}
        </div>
      </ScrollFadeContainer>
    </div>
  );
};
