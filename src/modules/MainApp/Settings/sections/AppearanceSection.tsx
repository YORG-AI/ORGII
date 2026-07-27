import {
  SECTION_CONTROL_STYLE,
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import { useAtom } from "jotai";
import React from "react";
import { useTranslation } from "react-i18next";

import Select from "@src/components/Select";
import Slider from "@src/components/Slider";
import Switch from "@src/components/Switch";
import type { ApplicationUiFontId } from "@src/config/appearance/applicationUiFonts";
import type { PrimaryColorPreset } from "@src/config/appearance/primaryColors";
import {
  HOST_DESKTOP,
  resolveHostDesktop,
} from "@src/config/windowChromeRadius";
import { useSetting } from "@src/hooks/settings/useSettings";
import { BackgroundSettings } from "@src/modules/MainApp/Settings/subpages/BackgroundPage/BackgroundSettings";
import {
  FeaturesSection as EditorFeaturesSection,
  TerminalSection as EditorTerminalSection,
  TypographySection as EditorTypographySection,
} from "@src/modules/MainApp/Settings/subpages/EditorAppearancePage";
import {
  DEFAULT_SIDEBAR_OPACITY,
  MAX_SIDEBAR_OPACITY,
  MIN_SIDEBAR_OPACITY,
  backgroundConfigPersistAtom,
  sanitizeSidebarOpacity,
} from "@src/store/ui/backgroundConfigAtom";
import type { SpotlightPlacement } from "@src/store/ui/uiAtom";

import { ChatPanelAppearanceTab } from "./ChatPanelAppearanceTab";
import { UI_SCALE_OPTIONS, useAppearanceState } from "./useAppearanceState";

const getApproxFontSize = (scale: number): string => {
  const baseFontSize = 14;
  const scaledSize = Math.round((baseFontSize * scale) / 100);
  return `${scaledSize}px`;
};

export const APPEARANCE_TAB_KEYS = {
  APP: "app",
  CODE_EDITOR: "code-editor",
  CHAT_PANEL: "chat-panel",
} as const;

export type AppearanceTabKey =
  (typeof APPEARANCE_TAB_KEYS)[keyof typeof APPEARANCE_TAB_KEYS];

const SPOTLIGHT_PLACEMENT_OPTIONS: SpotlightPlacement[] = ["top", "center"];
const IS_MACOS_HOST = resolveHostDesktop() === HOST_DESKTOP.MACOS;

const MacOSSidebarOpacityRow: React.FC = () => {
  const { t } = useTranslation("settings");
  const [config, setConfig] = useAtom(backgroundConfigPersistAtom);

  return (
    <SectionRow label={t("background.sidebarOpacity")}>
      <div className="min-w-0" style={SECTION_CONTROL_STYLE}>
        <Slider
          min={MIN_SIDEBAR_OPACITY}
          max={MAX_SIDEBAR_OPACITY}
          value={config.sidebarOpacity ?? DEFAULT_SIDEBAR_OPACITY}
          onChange={(value) =>
            setConfig({
              ...config,
              sidebarOpacity: sanitizeSidebarOpacity(value),
            })
          }
          noPadding
        />
      </div>
    </SectionRow>
  );
};

interface AppearanceSectionProps {
  activeTab?: string;
}

const AppearanceSection: React.FC<AppearanceSectionProps> = ({
  activeTab = APPEARANCE_TAB_KEYS.APP,
}) => {
  const { t } = useTranslation("settings");
  const [sidebarSelectedRowOpacity, setSidebarSelectedRowOpacity] = useSetting(
    "layout.sidebarSelectedRowOpacity"
  );
  const [sidebarEdgeDepthEnabled, setSidebarEdgeDepthEnabled] = useSetting(
    "layout.sidebarEdgeDepthEnabled"
  );
  const [usePointerCursors, setUsePointerCursors] = useSetting(
    "general.usePointerCursors"
  );
  const {
    globalThemeId,
    primaryColorPreset,
    setPrimaryColorPreset,
    uiScale,
    applicationUiFont,
    setApplicationUiFont,
    spotlightPlacement,
    setSpotlightPlacement,
    appearanceMode,
    appearanceModeOptions,
    themeOptions,
    primaryColorOptions,
    applicationUiFontOptions,
    handleThemeChange,
    handleAppearanceModeChange,
    handleUIScaleChange,
  } = useAppearanceState();

  return (
    <div className={SECTION_GAP_CLASSES}>
      {activeTab === APPEARANCE_TAB_KEYS.APP && (
        <>
          <SectionContainer>
            <SectionRow label={t("general.appearanceMode")}>
              <Select
                value={appearanceMode}
                onChange={handleAppearanceModeChange}
                options={appearanceModeOptions}
                showSearch
                size="default"
                style={SECTION_CONTROL_STYLE}
              />
            </SectionRow>
            <SectionRow label={t("general.themePreset")}>
              <Select
                value={globalThemeId}
                onChange={(value) => handleThemeChange(String(value))}
                options={themeOptions}
                showSearch
                size="default"
                style={SECTION_CONTROL_STYLE}
              />
            </SectionRow>
            <SectionRow label={t("general.primaryColor")}>
              <Select
                value={primaryColorPreset}
                onChange={(value) =>
                  setPrimaryColorPreset(String(value) as PrimaryColorPreset)
                }
                options={primaryColorOptions}
                showSearch
                size="default"
                style={SECTION_CONTROL_STYLE}
              />
            </SectionRow>
          </SectionContainer>

          <SectionContainer>
            <SectionRow label={t("general.applicationFont")}>
              <Select
                value={applicationUiFont}
                onChange={(value) =>
                  setApplicationUiFont(value as ApplicationUiFontId)
                }
                options={applicationUiFontOptions}
                showSearch
                size="default"
                style={SECTION_CONTROL_STYLE}
              />
            </SectionRow>
            <SectionRow label={t("general.uiScale")}>
              <Select
                value={String(uiScale)}
                onChange={(value) => handleUIScaleChange(String(value))}
                options={UI_SCALE_OPTIONS.map((scale) => ({
                  label: `${scale}% · ${getApproxFontSize(scale)}`,
                  value: String(scale),
                }))}
                size="default"
                style={SECTION_CONTROL_STYLE}
              />
            </SectionRow>
          </SectionContainer>

          <SectionContainer title={t("general.preferences")}>
            <SectionRow
              label={t("general.usePointerCursors")}
              description={t("general.usePointerCursorsDesc")}
            >
              <Switch
                checked={usePointerCursors}
                onChange={setUsePointerCursors}
                ariaLabel={t("general.usePointerCursors")}
                dataTestId="use-pointer-cursors-switch"
              />
            </SectionRow>
          </SectionContainer>

          <SectionContainer title={t("general.sidebar")}>
            {IS_MACOS_HOST && <MacOSSidebarOpacityRow />}
            <SectionRow label={t("general.selectedItemTransparency")}>
              <div className="min-w-0" style={SECTION_CONTROL_STYLE}>
                <Slider
                  min={0}
                  max={20}
                  value={sidebarSelectedRowOpacity}
                  onChange={(value) =>
                    setSidebarSelectedRowOpacity(
                      Array.isArray(value) ? value[0] : value
                    )
                  }
                  noPadding
                />
              </div>
            </SectionRow>
            {IS_MACOS_HOST && (
              <SectionRow label={t("general.sidebarEdgeDepth")}>
                <Switch
                  checked={sidebarEdgeDepthEnabled}
                  onChange={setSidebarEdgeDepthEnabled}
                />
              </SectionRow>
            )}
          </SectionContainer>

          <SectionContainer title={t("general.spotlight")}>
            <SectionRow
              label={t("general.spotlightPlacement")}
              description={t("general.spotlightPlacementDesc")}
            >
              <Select
                value={spotlightPlacement}
                onChange={(value) =>
                  setSpotlightPlacement(String(value) as SpotlightPlacement)
                }
                options={SPOTLIGHT_PLACEMENT_OPTIONS.map((placement) => ({
                  label: t(`general.spotlightPlacementOptions.${placement}`),
                  value: placement,
                }))}
                size="default"
                style={SECTION_CONTROL_STYLE}
              />
            </SectionRow>
          </SectionContainer>

          {!IS_MACOS_HOST && <BackgroundSettings embedded showHeader={false} />}
        </>
      )}

      {activeTab === APPEARANCE_TAB_KEYS.CODE_EDITOR && (
        <>
          <EditorTypographySection showTitle={false} />
          <EditorTerminalSection />
          <EditorFeaturesSection />
        </>
      )}

      {activeTab === APPEARANCE_TAB_KEYS.CHAT_PANEL && (
        <ChatPanelAppearanceTab />
      )}
    </div>
  );
};

export default AppearanceSection;
