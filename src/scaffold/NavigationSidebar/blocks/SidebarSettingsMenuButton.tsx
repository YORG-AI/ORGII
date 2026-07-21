import { useAtomValue } from "jotai";
import {
  ChevronRight,
  Circle,
  Contrast,
  Gauge,
  HelpCircle,
  House,
  Laptop,
  MessageCircle,
  MousePointer2,
  Settings,
} from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import {
  KEYBOARD_SHORTCUT_VARIANT,
  KeyboardShortcut,
} from "@src/components/KeyboardShortcut";
import type { AppearanceMode } from "@src/config/appearance/globalThemes";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { useAppNavigation } from "@src/hooks/navigation";
import { useAppearanceState } from "@src/modules/MainApp/Settings/sections/useAppearanceState";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared";
import { openAgentControlSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { ADE_MANAGER_TOGGLE_SHORTCUT_ID } from "@src/scaffold/GlobalSpotlight/palettes/AgentControlPalette/constants";
import { TUTORIALS_OPEN_EVENT } from "@src/scaffold/Tutorials/tutorialRegistry";
import { devModeEnabledAtom } from "@src/store/platform/devModeAtom";
import { getViewportSize } from "@src/util/ui/window/viewport";

import HoverAnimatedIcon, {
  triggerIconAnimation,
} from "../components/HoverAnimatedIcon";
import { SidebarRamMonitorPanel } from "../connectors/SidebarRamMonitorButton";
import {
  type SettingsSubmenu,
  SidebarSettingsMenuSubmenus,
  type SubmenuPosition,
} from "./SidebarSettingsMenuSubmenus";

const SUBMENU_WIDTH_PX = 220;
const SUBMENU_GAP_PX = DROPDOWN_PANEL.submenuGap;
const MENU_ICON_CLASS_NAME = "shrink-0 text-text-2";
const MENU_ARROW_CLASS_NAME = "text-text-3";

function getSubmenuPosition(
  trigger: HTMLElement,
  parentPanel: HTMLElement | null
): SubmenuPosition {
  const rect = trigger.getBoundingClientRect();
  const parentRect = parentPanel?.getBoundingClientRect();
  const { width: vpWidth, height: vpHeight } = getViewportSize();
  const rightSideLeft = rect.right + SUBMENU_GAP_PX;
  const left =
    rightSideLeft + SUBMENU_WIDTH_PX > vpWidth
      ? rect.left - SUBMENU_WIDTH_PX - SUBMENU_GAP_PX
      : rightSideLeft;
  return {
    left,
    bottom: parentRect ? vpHeight - parentRect.bottom : 8,
  };
}

const SidebarSettingsMenuButton: React.FC = React.memo(() => {
  const { t } = useTranslation("navigation");
  const { t: tSettings } = useTranslation("settings");
  const { goToSettings, goToStartPage } = useAppNavigation();
  const devModeEnabled = useAtomValue(devModeEnabledAtom);
  const ramPanelRef = useRef<HTMLDivElement | null>(null);
  const submenuPanelRef = useRef<HTMLDivElement | null>(null);
  const preserveRamPanelOnMenuCloseRef = useRef(false);
  const dropdownInsideRefs = useMemo(() => [submenuPanelRef], []);
  const [activeSubmenu, setActiveSubmenu] = useState<SettingsSubmenu | null>(
    null
  );
  const [submenuPosition, setSubmenuPosition] =
    useState<SubmenuPosition | null>(null);
  const [ramPanelOpen, setRamPanelOpen] = useState(false);
  const [ramPanelPosition, setRamPanelPosition] = useState<{
    top?: number;
    bottom?: number;
    left?: number;
  } | null>(null);
  const handleSettingsMenuOpenChange = useCallback((open: boolean) => {
    if (open) return;
    setActiveSubmenu(null);
    setSubmenuPosition(null);
    if (preserveRamPanelOnMenuCloseRef.current) {
      preserveRamPanelOnMenuCloseRef.current = false;
      return;
    }
    setRamPanelOpen(false);
  }, []);
  const {
    isOpen,
    isPositioned,
    toggle,
    close,
    triggerRef,
    panelRef,
    panelPosition,
  } = useDropdownEngine<HTMLDivElement>({
    placement: "top",
    align: "right",
    gap: DROPDOWN_PANEL.triggerGap,
    onOpenChange: handleSettingsMenuOpenChange,
    additionalInsideRefs: dropdownInsideRefs,
  });
  const {
    appearanceMode,
    appearanceModeOptions,
    globalThemeId,
    themeOptions,
    handleAppearanceModeChange,
    handleThemeChange,
  } = useAppearanceState();

  const openSettingsShortcut = getShortcutKeys("open_settings");
  const guiControlShortcut = getShortcutKeys(ADE_MANAGER_TOGGLE_SHORTCUT_ID);
  const settingsButtonClassName = isOpen ? "text-text-1" : "text-text-2";

  useEffect(() => {
    if (!ramPanelOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (ramPanelRef.current?.contains(target)) return;
      setRamPanelOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRamPanelOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [ramPanelOpen]);

  const closeAll = useCallback(() => {
    setActiveSubmenu(null);
    setSubmenuPosition(null);
    setRamPanelOpen(false);
    close();
  }, [close]);

  const handleToggle = useCallback(() => {
    if (isOpen) {
      closeAll();
      return;
    }
    toggle();
  }, [closeAll, isOpen, toggle]);

  const openSubmenu = useCallback(
    (submenu: SettingsSubmenu, target: HTMLElement) => {
      setActiveSubmenu(submenu);
      setSubmenuPosition(getSubmenuPosition(target, panelRef.current));
    },
    [panelRef]
  );

  const handleOpenSettings = useCallback(() => {
    closeAll();
    goToSettings();
  }, [closeAll, goToSettings]);

  const handleOpenHome = useCallback(() => {
    closeAll();
    goToStartPage();
  }, [closeAll, goToStartPage]);

  const handleViewRam = useCallback(() => {
    setActiveSubmenu(null);
    setSubmenuPosition(null);
    preserveRamPanelOnMenuCloseRef.current = true;
    setRamPanelPosition({
      top: panelPosition.top,
      bottom: panelPosition.bottom,
      left: panelPosition.left,
    });
    setRamPanelOpen(true);
    close();
  }, [close, panelPosition.bottom, panelPosition.left, panelPosition.top]);

  const handleOpenTutorials = useCallback(() => {
    window.dispatchEvent(new CustomEvent(TUTORIALS_OPEN_EVENT));
    closeAll();
  }, [closeAll]);

  const handleOpenGuiControl = useCallback(() => {
    openAgentControlSpotlight();
    closeAll();
  }, [closeAll]);

  const handleSelectAppearanceMode = useCallback(
    async (mode: AppearanceMode) => {
      await handleAppearanceModeChange(mode);
      closeAll();
    },
    [closeAll, handleAppearanceModeChange]
  );

  const handleSelectTheme = useCallback(
    async (themeId: string) => {
      await handleThemeChange(themeId);
      closeAll();
    },
    [closeAll, handleThemeChange]
  );

  const handleSubmenuPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
    },
    []
  );

  const handleSubmenuMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
    },
    []
  );

  return (
    <>
      <WorkstationToolbarTooltip
        label={t("sidebar.bottomBar.settings")}
        shortcut={openSettingsShortcut}
        position="top"
        disabled={isOpen}
      >
        <div ref={triggerRef} className="inline-flex">
          <button
            type="button"
            aria-label={t("sidebar.bottomBar.settings")}
            className={`flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[100px] border-none p-0 transition-colors duration-150 ${
              isOpen
                ? "bg-sidebar-selected"
                : "bg-transparent hover:bg-sidebar-selected"
            }`}
            onClick={handleToggle}
            onMouseEnter={(event) => triggerIconAnimation(event.currentTarget)}
          >
            <HoverAnimatedIcon
              icon={Settings}
              iconName="settings"
              size={16}
              strokeWidth={2}
              className={settingsButtonClassName}
            />
          </button>
        </div>
      </WorkstationToolbarTooltip>

      {isOpen &&
        isPositioned &&
        createPortal(
          <div
            ref={panelRef}
            className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.sidebarMenuClass} fixed`}
            style={{
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left: panelPosition.left,
            }}
          >
            <div className={DROPDOWN_CLASSES.itemsColumn}>
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.menuActionItem} gap-2`}
                onMouseEnter={() => setActiveSubmenu(null)}
                onFocus={() => setActiveSubmenu(null)}
                onClick={handleOpenHome}
              >
                <House
                  size={DROPDOWN_ITEM.iconSize}
                  className={MENU_ICON_CLASS_NAME}
                />
                <span>{t("sidebar.tabs.build")}</span>
              </button>
              <div className={DROPDOWN_CLASSES.menuSeparator} />
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.menuActionItem} justify-between`}
                onMouseEnter={() => setActiveSubmenu(null)}
                onFocus={() => setActiveSubmenu(null)}
                onClick={handleOpenGuiControl}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <MousePointer2
                    size={DROPDOWN_ITEM.iconSize}
                    className={MENU_ICON_CLASS_NAME}
                  />
                  <span className="truncate">
                    {t("common:adeManager.menuToggle")}
                  </span>
                </span>
                <KeyboardShortcut
                  shortcut={guiControlShortcut}
                  variant={KEYBOARD_SHORTCUT_VARIANT.dropdown}
                />
              </button>
              <div className={DROPDOWN_CLASSES.menuSeparator} />
              {devModeEnabled && (
                <button
                  type="button"
                  className={`${DROPDOWN_CLASSES.menuActionItem} gap-2`}
                  onMouseEnter={() => setActiveSubmenu(null)}
                  onFocus={() => setActiveSubmenu(null)}
                  onClick={handleViewRam}
                >
                  <Gauge
                    size={DROPDOWN_ITEM.iconSize}
                    className={MENU_ICON_CLASS_NAME}
                  />
                  <span>{t("sidebar.settingsMenu.viewRam")}</span>
                </button>
              )}
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.menuActionItem} gap-2`}
                onMouseEnter={() => setActiveSubmenu(null)}
                onFocus={() => setActiveSubmenu(null)}
                onClick={handleOpenTutorials}
              >
                <HelpCircle
                  size={DROPDOWN_ITEM.iconSize}
                  className={MENU_ICON_CLASS_NAME}
                />
                <span>{t("sidebar.settingsMenu.tutorials")}</span>
              </button>
              <div className={DROPDOWN_CLASSES.menuSeparator} />
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.menuActionItem} ${activeSubmenu === "presence" ? DROPDOWN_CLASSES.itemActive : ""} justify-between`}
                onMouseEnter={(event) =>
                  openSubmenu("presence", event.currentTarget)
                }
                onFocus={(event) =>
                  openSubmenu("presence", event.currentTarget)
                }
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Circle
                    size={DROPDOWN_ITEM.iconSize}
                    className="shrink-0 text-success-6"
                  />
                  <span className="truncate">
                    {tSettings("myRoles.tabs.presence")}
                  </span>
                </span>
                <ChevronRight
                  size={DROPDOWN_ITEM.iconSize}
                  className={MENU_ARROW_CLASS_NAME}
                />
              </button>
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.menuActionItem} ${activeSubmenu === "appearance" ? DROPDOWN_CLASSES.itemActive : ""} justify-between`}
                onMouseEnter={(event) =>
                  openSubmenu("appearance", event.currentTarget)
                }
                onFocus={(event) =>
                  openSubmenu("appearance", event.currentTarget)
                }
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Contrast
                    size={DROPDOWN_ITEM.iconSize}
                    className={MENU_ICON_CLASS_NAME}
                  />
                  <span className="truncate">
                    {t("sidebar.settingsMenu.appearance")}
                  </span>
                </span>
                <ChevronRight
                  size={DROPDOWN_ITEM.iconSize}
                  className={MENU_ARROW_CLASS_NAME}
                />
              </button>
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.menuActionItem} ${activeSubmenu === "chatPanelLocation" ? DROPDOWN_CLASSES.itemActive : ""} justify-between`}
                onMouseEnter={(event) =>
                  openSubmenu("chatPanelLocation", event.currentTarget)
                }
                onFocus={(event) =>
                  openSubmenu("chatPanelLocation", event.currentTarget)
                }
              >
                <span className="flex min-w-0 items-center gap-2">
                  <MessageCircle
                    size={DROPDOWN_ITEM.iconSize}
                    className={MENU_ICON_CLASS_NAME}
                  />
                  <span className="truncate">
                    {t("common:layoutSettings.newChatPanel")}
                  </span>
                </span>
                <ChevronRight
                  size={DROPDOWN_ITEM.iconSize}
                  className={MENU_ARROW_CLASS_NAME}
                />
              </button>
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.menuActionItem} ${activeSubmenu === "workstation" ? DROPDOWN_CLASSES.itemActive : ""} justify-between`}
                onMouseEnter={(event) =>
                  openSubmenu("workstation", event.currentTarget)
                }
                onFocus={(event) =>
                  openSubmenu("workstation", event.currentTarget)
                }
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Laptop
                    size={DROPDOWN_ITEM.iconSize}
                    className={MENU_ICON_CLASS_NAME}
                  />
                  <span className="truncate">
                    {t("sidebar.settingsMenu.workstation")}
                  </span>
                </span>
                <ChevronRight
                  size={DROPDOWN_ITEM.iconSize}
                  className={MENU_ARROW_CLASS_NAME}
                />
              </button>
              <div className={DROPDOWN_CLASSES.menuSeparator} />
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.menuActionItem} justify-between`}
                onMouseEnter={() => setActiveSubmenu(null)}
                onFocus={() => setActiveSubmenu(null)}
                onClick={handleOpenSettings}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Settings
                    size={DROPDOWN_ITEM.iconSize}
                    className={MENU_ICON_CLASS_NAME}
                  />
                  <span className="truncate">
                    {t("sidebar.settingsMenu.openSettings")}
                  </span>
                </span>
                <KeyboardShortcut
                  shortcut={openSettingsShortcut}
                  variant={KEYBOARD_SHORTCUT_VARIANT.dropdown}
                />
              </button>
            </div>
          </div>,
          document.body
        )}
      <SidebarSettingsMenuSubmenus
        activeSubmenu={activeSubmenu}
        appearanceMode={appearanceMode}
        appearanceModeLabel={tSettings("general.appearanceMode")}
        appearanceModeOptions={appearanceModeOptions}
        globalThemeId={globalThemeId}
        submenuPanelRef={submenuPanelRef}
        submenuPosition={submenuPosition}
        themeOptions={themeOptions}
        themePresetLabel={tSettings("general.themePreset")}
        onPresenceSelectionComplete={closeAll}
        onSelectAppearanceMode={(mode) => void handleSelectAppearanceMode(mode)}
        onSelectTheme={(themeId) => void handleSelectTheme(themeId)}
        onSubmenuMouseDown={handleSubmenuMouseDown}
        onSubmenuPointerDown={handleSubmenuPointerDown}
      />
      {devModeEnabled && ramPanelPosition && (
        <SidebarRamMonitorPanel
          isOpen={ramPanelOpen}
          panelRef={ramPanelRef}
          panelPosition={ramPanelPosition}
        />
      )}
    </>
  );
});

SidebarSettingsMenuButton.displayName = "SidebarSettingsMenuButton";

export default SidebarSettingsMenuButton;
