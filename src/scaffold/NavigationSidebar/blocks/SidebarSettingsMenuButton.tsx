import { useAtomValue } from "jotai";
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
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import type { AppearanceMode } from "@src/config/appearance/globalThemes";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import {
  type DropdownEnginePosition,
  useDropdownEngine,
} from "@src/hooks/dropdown";
import { useAppNavigation } from "@src/hooks/navigation";
import {
  ArrowRight01Icon,
  BubbleChatIcon,
  CircleIcon,
  Cursor02Icon,
  GaugeIcon,
  HelpCircleIcon,
  HugeiconsIcon,
  LaptopIcon,
  Login01Icon,
  Settings01Icon,
  Sun01Icon,
} from "@src/icons";
import { useAppearanceState } from "@src/modules/MainApp/Settings/sections/useAppearanceState";
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
type SettingsUtilityPanel = "ram";

interface SidebarSettingsMenuTriggerProps {
  isOpen: boolean;
  onClick: () => void;
}

interface SidebarSettingsMenuButtonProps {
  /** Replaces the compact gear trigger while preserving this menu's behavior. */
  renderTrigger?: (props: SidebarSettingsMenuTriggerProps) => React.ReactNode;
  /** Adds a login action when the account trigger represents a signed-out user. */
  onSignIn?: () => void;
}

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

const SidebarSettingsMenuButton: React.FC<SidebarSettingsMenuButtonProps> = ({
  renderTrigger,
  onSignIn,
}) => {
  const { t } = useTranslation("navigation");
  const { t: tSettings } = useTranslation("settings");
  const { goToSettings } = useAppNavigation();
  const devModeEnabled = useAtomValue(devModeEnabledAtom);
  const utilityPanelRef = useRef<HTMLDivElement | null>(null);
  const submenuPanelRef = useRef<HTMLDivElement | null>(null);
  const preserveUtilityPanelOnMenuCloseRef = useRef(false);
  const dropdownInsideRefs = useMemo(() => [submenuPanelRef], []);
  const [activeSubmenu, setActiveSubmenu] = useState<SettingsSubmenu | null>(
    null
  );
  const [submenuPosition, setSubmenuPosition] =
    useState<SubmenuPosition | null>(null);
  const [utilityPanel, setUtilityPanel] = useState<SettingsUtilityPanel | null>(
    null
  );
  const [utilityPanelPosition, setUtilityPanelPosition] =
    useState<DropdownEnginePosition | null>(null);
  const handleSettingsMenuOpenChange = useCallback((open: boolean) => {
    if (open) return;
    setActiveSubmenu(null);
    setSubmenuPosition(null);
    if (preserveUtilityPanelOnMenuCloseRef.current) {
      preserveUtilityPanelOnMenuCloseRef.current = false;
      return;
    }
    setUtilityPanel(null);
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
    align: renderTrigger ? "left" : "right",
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
    if (!utilityPanel) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (utilityPanelRef.current?.contains(target)) return;
      setUtilityPanel(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUtilityPanel(null);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [utilityPanel]);

  const closeAll = useCallback(() => {
    setActiveSubmenu(null);
    setSubmenuPosition(null);
    setUtilityPanel(null);
    close();
  }, [close]);

  const handleToggle = useCallback(() => {
    if (isOpen) {
      closeAll();
      return;
    }
    setUtilityPanel(null);
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

  const handleOpenUtilityPanel = useCallback(
    (panel: SettingsUtilityPanel) => {
      setActiveSubmenu(null);
      setSubmenuPosition(null);
      preserveUtilityPanelOnMenuCloseRef.current = true;
      setUtilityPanelPosition({ ...panelPosition });
      setUtilityPanel(panel);
      close();
    },
    [close, panelPosition]
  );

  const handleViewRam = useCallback(() => {
    handleOpenUtilityPanel("ram");
  }, [handleOpenUtilityPanel]);

  const handleOpenTutorials = useCallback(() => {
    window.dispatchEvent(new CustomEvent(TUTORIALS_OPEN_EVENT));
    closeAll();
  }, [closeAll]);

  const handleSignIn = useCallback(() => {
    closeAll();
    onSignIn?.();
  }, [closeAll, onSignIn]);

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
      {renderTrigger ? (
        <div ref={triggerRef} className="flex min-w-0 flex-1">
          {renderTrigger({ isOpen, onClick: handleToggle })}
        </div>
      ) : (
        <ToolbarTooltip
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
              onMouseEnter={(event) =>
                triggerIconAnimation(event.currentTarget)
              }
            >
              <HoverAnimatedIcon
                icon={Settings01Icon}
                iconName="settings"
                size={16}
                strokeWidth={2}
                className={settingsButtonClassName}
              />
            </button>
          </div>
        </ToolbarTooltip>
      )}

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
              {onSignIn && (
                <>
                  <button
                    type="button"
                    className={`${DROPDOWN_CLASSES.menuActionItem} gap-2`}
                    onMouseEnter={() => setActiveSubmenu(null)}
                    onFocus={() => setActiveSubmenu(null)}
                    onClick={handleSignIn}
                    data-testid="sidebar-menu-sign-in"
                  >
                    <HugeiconsIcon
                      icon={Login01Icon}
                      data-icon="log-in"
                      size={DROPDOWN_ITEM.iconSize}
                      className={MENU_ICON_CLASS_NAME}
                    />
                    <span>{t("cloud.signIn")}</span>
                  </button>
                  <div className={DROPDOWN_CLASSES.menuSeparatorInset} />
                </>
              )}
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.menuActionItem} justify-between`}
                onMouseEnter={() => setActiveSubmenu(null)}
                onFocus={() => setActiveSubmenu(null)}
                onClick={handleOpenGuiControl}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <HugeiconsIcon
                    icon={Cursor02Icon}
                    data-icon="mouse-pointer-2"
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
              <div className={DROPDOWN_CLASSES.menuSeparatorInset} />
              {devModeEnabled && (
                <button
                  type="button"
                  className={`${DROPDOWN_CLASSES.menuActionItem} gap-2`}
                  onMouseEnter={() => setActiveSubmenu(null)}
                  onFocus={() => setActiveSubmenu(null)}
                  onClick={handleViewRam}
                >
                  <HugeiconsIcon
                    icon={GaugeIcon}
                    data-icon="gauge"
                    size={DROPDOWN_ITEM.iconSize}
                    className={MENU_ICON_CLASS_NAME}
                  />
                  <span>{t("sidebar.settingsMenu.viewRam")}</span>
                </button>
              )}
              {/*
                TODO(changelog-web): Restore the Changelog item here, directly
                above Tutorials, once the maintained web destination is ready.
              */}
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.menuActionItem} gap-2`}
                onMouseEnter={() => setActiveSubmenu(null)}
                onFocus={() => setActiveSubmenu(null)}
                onClick={handleOpenTutorials}
              >
                <HugeiconsIcon
                  icon={HelpCircleIcon}
                  data-icon="help-circle"
                  size={DROPDOWN_ITEM.iconSize}
                  className={MENU_ICON_CLASS_NAME}
                />
                <span>{t("sidebar.settingsMenu.tutorials")}</span>
              </button>
              <div className={DROPDOWN_CLASSES.menuSeparatorInset} />
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
                  <HugeiconsIcon
                    icon={CircleIcon}
                    data-icon="circle"
                    size={DROPDOWN_ITEM.iconSize}
                    className="shrink-0 text-success-6"
                  />
                  <span className="truncate">
                    {tSettings("myRoles.tabs.presence")}
                  </span>
                </span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  data-icon="chevron-right"
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
                  <HugeiconsIcon
                    icon={Sun01Icon}
                    data-icon="sun"
                    size={DROPDOWN_ITEM.iconSize}
                    className={MENU_ICON_CLASS_NAME}
                  />
                  <span className="truncate">
                    {t("sidebar.settingsMenu.appearance")}
                  </span>
                </span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  data-icon="chevron-right"
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
                  <HugeiconsIcon
                    icon={BubbleChatIcon}
                    data-icon="message-circle"
                    size={DROPDOWN_ITEM.iconSize}
                    className={MENU_ICON_CLASS_NAME}
                  />
                  <span className="truncate">
                    {t("common:layoutSettings.newChatPanel")}
                  </span>
                </span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  data-icon="chevron-right"
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
                  <HugeiconsIcon
                    icon={LaptopIcon}
                    data-icon="laptop"
                    size={DROPDOWN_ITEM.iconSize}
                    className={MENU_ICON_CLASS_NAME}
                  />
                  <span className="truncate">
                    {t("sidebar.settingsMenu.workstation")}
                  </span>
                </span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  data-icon="chevron-right"
                  size={DROPDOWN_ITEM.iconSize}
                  className={MENU_ARROW_CLASS_NAME}
                />
              </button>
              <div className={DROPDOWN_CLASSES.menuSeparatorInset} />
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.menuActionItem} justify-between`}
                onMouseEnter={() => setActiveSubmenu(null)}
                onFocus={() => setActiveSubmenu(null)}
                onClick={handleOpenSettings}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <HugeiconsIcon
                    icon={Settings01Icon}
                    data-icon="settings"
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
      {devModeEnabled && utilityPanel === "ram" && utilityPanelPosition && (
        <SidebarRamMonitorPanel
          isOpen
          panelRef={utilityPanelRef}
          panelPosition={utilityPanelPosition}
        />
      )}
    </>
  );
};

SidebarSettingsMenuButton.displayName = "SidebarSettingsMenuButton";

export default React.memo(SidebarSettingsMenuButton);
