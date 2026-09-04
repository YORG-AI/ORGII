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
import type { AccentPreset } from "@src/config/appearance/skins/accent";
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

/**
 * Only meaningful while the sidebar is translucent — at an opaque surface the
 * slider would silently do nothing, so it is hidden rather than disabled.
 */
const SidebarOpacityRow: React.FC = () => {
  const { t } = useTranslation("settings");
  const [config, setConfig] = useAtom(backgroundConfigPersistAtom);

  return (
    <SectionRow
      settingsSearchKeys="background.sidebarOpacity"
      label={t("background.sidebarOpacity")}
    >
      <div className="min-w-0" style={SECTION_CONTROL_STYLE}>
        <Slider
          min={MIN_SIDEBAR_OPACITY}
          max={MAX_SIDEBAR_OPACITY}
          value={config.sidebarOpacity ?? DEFAULT_SIDEBAR_OPACITY}
          onValueChange={(value) =>
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
    uiScale,
    applicationUiFont,
    setApplicationUiFont,
    spotlightPlacement,
    setSpotlightPlacement,
    appearanceMode,
    appearanceModeOptions,
    applicationUiFontOptions,
    handleAppearanceModeChange,
    handleUIScaleChange,
    linkSkinVariants,
    setLinkSkinVariants,
    unifiedSkinId,
    unifiedSkinOptions,
    unifiedAccent,
    unifiedAccentOptions,
    lightSkinId,
    setLightSkinId,
    darkSkinId,
    setDarkSkinId,
    lightSkinOptions,
    darkSkinOptions,
    lightAccent,
    setLightAccent,
    darkAccent,
    setDarkAccent,
    lightAccentOptions,
    darkAccentOptions,
    translucentSidebar,
    setTranslucentSidebar,
    iconStyle,
    setIconStyle,
    iconStyleOptions,
  } = useAppearanceState();

  return (
    <div className={SECTION_GAP_CLASSES}>
      {activeTab === APPEARANCE_TAB_KEYS.APP && (
        <>
          <SectionContainer>
            <SectionRow
              settingsSearchKeys="general.theme"
              label={t("general.appearanceMode")}
            >
              <Select
                value={appearanceMode}
                onChange={handleAppearanceModeChange}
                options={appearanceModeOptions}
                showSearch
                size="default"
                style={SECTION_CONTROL_STYLE}
              />
            </SectionRow>
          </SectionContainer>

          <SectionContainer title={t("general.skins")}>
            <SectionRow
              settingsSearchKeys="general.linkSkinVariants"
              label={t("general.linkSkinVariants")}
              description={t("general.linkSkinVariantsDesc")}
            >
              <Switch
                checked={linkSkinVariants}
                onCheckedChange={setLinkSkinVariants}
                ariaLabel={t("general.linkSkinVariants")}
                dataTestId="link-skin-variants-switch"
              />
            </SectionRow>
            {linkSkinVariants ? (
              <>
                <SectionRow
                  settingsSearchKeys={["general.lightSkin", "general.darkSkin"]}
                  label={t("general.skin")}
                >
                  <Select
                    value={unifiedSkinId}
                    onChange={(value) => setLightSkinId(String(value))}
                    options={unifiedSkinOptions}
                    showSearch
                    showTriggerIcon
                    size="default"
                    style={SECTION_CONTROL_STYLE}
                    dataTestId="unified-skin-select"
                  />
                </SectionRow>
                <SectionRow
                  settingsSearchKeys={[
                    "general.primaryColorLight",
                    "general.primaryColorDark",
                  ]}
                  label={t("general.accent")}
                >
                  <Select
                    value={unifiedAccent}
                    onChange={(value) =>
                      setLightAccent(String(value) as AccentPreset)
                    }
                    options={unifiedAccentOptions}
                    showSearch
                    showTriggerIcon
                    size="default"
                    style={SECTION_CONTROL_STYLE}
                    dataTestId="unified-accent-select"
                  />
                </SectionRow>
              </>
            ) : (
              <>
                <SectionRow
                  settingsSearchKeys="general.lightSkin"
                  label={t("general.lightSkin")}
                  description={t("general.skinsDesc")}
                >
                  <Select
                    value={lightSkinId}
                    onChange={(value) => setLightSkinId(String(value))}
                    options={lightSkinOptions}
                    showSearch
                    showTriggerIcon
                    size="default"
                    style={SECTION_CONTROL_STYLE}
                    dataTestId="light-skin-select"
                  />
                </SectionRow>
                <SectionRow
                  settingsSearchKeys="general.darkSkin"
                  label={t("general.darkSkin")}
                >
                  <Select
                    value={darkSkinId}
                    onChange={(value) => setDarkSkinId(String(value))}
                    options={darkSkinOptions}
                    showSearch
                    showTriggerIcon
                    size="default"
                    style={SECTION_CONTROL_STYLE}
                    dataTestId="dark-skin-select"
                  />
                </SectionRow>
                <SectionRow
                  settingsSearchKeys="general.primaryColorLight"
                  label={t("general.lightAccent")}
                >
                  <Select
                    value={lightAccent}
                    onChange={(value) =>
                      setLightAccent(String(value) as AccentPreset)
                    }
                    options={lightAccentOptions}
                    showSearch
                    showTriggerIcon
                    size="default"
                    style={SECTION_CONTROL_STYLE}
                    dataTestId="light-accent-select"
                  />
                </SectionRow>
                <SectionRow
                  settingsSearchKeys="general.primaryColorDark"
                  label={t("general.darkAccent")}
                >
                  <Select
                    value={darkAccent}
                    onChange={(value) =>
                      setDarkAccent(String(value) as AccentPreset)
                    }
                    options={darkAccentOptions}
                    showSearch
                    showTriggerIcon
                    size="default"
                    style={SECTION_CONTROL_STYLE}
                    dataTestId="dark-accent-select"
                  />
                </SectionRow>
              </>
            )}
          </SectionContainer>

          <SectionContainer>
            <SectionRow
              settingsSearchKeys="general.applicationUiFont"
              label={t("general.applicationFont")}
            >
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
            <SectionRow
              settingsSearchKeys="general.uiScale"
              label={t("general.uiScale")}
            >
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
              settingsSearchKeys="general.usePointerCursors"
              label={t("general.usePointerCursors")}
              description={t("general.usePointerCursorsDesc")}
            >
              <Switch
                checked={usePointerCursors}
                onCheckedChange={setUsePointerCursors}
                ariaLabel={t("general.usePointerCursors")}
                dataTestId="use-pointer-cursors-switch"
              />
            </SectionRow>
            <SectionRow
              settingsSearchKeys="general.iconStyle"
              label={t("general.iconStyle")}
              description={t("general.iconStyleDesc")}
            >
              <Select
                value={iconStyle}
                onChange={(value) =>
                  setIconStyle(String(value) as "colorful" | "monochrome")
                }
                options={iconStyleOptions}
                size="default"
                style={SECTION_CONTROL_STYLE}
                dataTestId="icon-style-select"
              />
            </SectionRow>
          </SectionContainer>

          <SectionContainer title={t("general.sidebar")}>
            <SectionRow
              settingsSearchKeys="general.translucentSidebar"
              label={t("general.translucentSidebar")}
            >
              <Switch
                checked={translucentSidebar}
                onCheckedChange={setTranslucentSidebar}
                ariaLabel={t("general.translucentSidebar")}
                dataTestId="translucent-sidebar-switch"
              />
            </SectionRow>
            {translucentSidebar && <SidebarOpacityRow />}
            <SectionRow
              settingsSearchKeys="layout.sidebarSelectedRowOpacity"
              label={t("general.selectedItemTransparency")}
            >
              <div className="min-w-0" style={SECTION_CONTROL_STYLE}>
                <Slider
                  min={0}
                  max={20}
                  value={sidebarSelectedRowOpacity}
                  onValueChange={(value) =>
                    setSidebarSelectedRowOpacity(
                      Array.isArray(value) ? value[0] : value
                    )
                  }
                  noPadding
                />
              </div>
            </SectionRow>
            {IS_MACOS_HOST && (
              <SectionRow
                settingsSearchKeys="layout.sidebarEdgeDepthEnabled"
                label={t("general.sidebarEdgeDepth")}
              >
                <Switch
                  checked={sidebarEdgeDepthEnabled}
                  onCheckedChange={setSidebarEdgeDepthEnabled}
                />
              </SectionRow>
            )}
          </SectionContainer>

          <SectionContainer title={t("general.spotlight")}>
            <SectionRow
              settingsSearchKeys="general.spotlightPlacement"
              label={t("general.spotlightPlacement")}
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
