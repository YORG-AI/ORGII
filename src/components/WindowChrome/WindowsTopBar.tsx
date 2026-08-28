import { LogicalPosition } from "@tauri-apps/api/dpi";
import { open } from "@tauri-apps/plugin-shell";
import type { TFunction } from "i18next";
import React, { memo, useCallback, useMemo, useSyncExternalStore } from "react";

import i18n from "@src/i18n";
import {
  Cancel01Icon,
  HugeiconsIcon,
  MinusSignIcon,
  SquareIcon,
} from "@src/icons";
import {
  closeWindow,
  maxWindow,
  minWindow,
} from "@src/util/platform/ipcRenderer";
import {
  type NativeMenuItemOptions,
  popupNativeMenu,
} from "@src/util/platform/tauri/nativeMenuPopup";

import { NoDragRegion } from "./NoDragRegion";

const TOP_BAR_HEIGHT = 36;
const ICON_SIZE = 14;

const MENU_BAR_CLASS = "flex h-full shrink-0 items-center gap-0.5 px-1";

const MENU_BUTTON_CLASS =
  "flex h-7 items-center rounded-md border-0 bg-transparent px-2 text-[13px] text-text-2 transition-colors hover:bg-fill-2 hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/30";

const WINDOW_CONTROL_BUTTON_CLASS =
  "flex h-full w-11 items-center justify-center border-0 bg-transparent p-0 text-text-2 transition-colors hover:bg-fill-2 hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/30";

const CLOSE_BUTTON_CLASS =
  "flex h-full w-11 items-center justify-center border-0 bg-transparent p-0 text-text-2 transition-colors hover:bg-danger-6 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-6/30";

type NativeMenuKey = "file" | "edit" | "view" | "window" | "help";

const subscribeToLanguageChange = (onStoreChange: () => void) => {
  i18n.on("languageChanged", onStoreChange);
  return () => i18n.off("languageChanged", onStoreChange);
};

const getActiveLanguage = () => i18n.resolvedLanguage ?? i18n.language ?? "en";

type NativeMenuItem =
  | {
      type: "item";
      text: string;
      action: () => void | Promise<void>;
      enabled?: boolean;
      accelerator?: string;
    }
  | { type: "separator" };

const MENU_KEYS: NativeMenuKey[] = ["file", "edit", "view", "window", "help"];

function emitMenuEvent(eventName: string) {
  window.dispatchEvent(new CustomEvent(eventName));
}

function handleWindowAction(action: () => Promise<void>) {
  void action();
}

function getMenuItems(menu: NativeMenuKey, t: TFunction): NativeMenuItem[] {
  switch (menu) {
    case "file":
      return [
        {
          type: "item",
          text: t("windowChrome.items.newSession"),
          accelerator: "Ctrl+N",
          action: () => emitMenuEvent("menu-new-session"),
        },
        { type: "separator" },
        {
          type: "item",
          text: t("windowChrome.items.openFolder"),
          accelerator: "Ctrl+O",
          action: () => emitMenuEvent("menu-file-open-folder"),
        },
        {
          type: "item",
          text: t("windowChrome.items.addFolderToWorkspace"),
          action: () => emitMenuEvent("menu-add-folder-to-workspace"),
        },
        { type: "separator" },
        {
          type: "item",
          text: t("windowChrome.items.saveWorkspaceAs"),
          action: () => emitMenuEvent("menu-save-workspace-as"),
        },
        { type: "separator" },
        {
          type: "item",
          text: t("windowChrome.items.closeWindow"),
          accelerator: "Ctrl+Shift+W",
          action: closeWindow,
        },
        { type: "separator" },
        {
          type: "item",
          text: t("windowChrome.items.quitOrg2"),
          accelerator: "Ctrl+Q",
          action: () => emitMenuEvent("native-quit-confirmation-open"),
        },
      ];
    case "edit":
      return [
        {
          type: "item",
          text: t("windowChrome.items.undo"),
          action: () => document.execCommand("undo"),
        },
        {
          type: "item",
          text: t("windowChrome.items.redo"),
          action: () => document.execCommand("redo"),
        },
        { type: "separator" },
        {
          type: "item",
          text: t("windowChrome.items.cut"),
          action: () => document.execCommand("cut"),
        },
        {
          type: "item",
          text: t("windowChrome.items.copy"),
          action: () => document.execCommand("copy"),
        },
        {
          type: "item",
          text: t("windowChrome.items.paste"),
          action: () => document.execCommand("paste"),
        },
        {
          type: "item",
          text: t("windowChrome.items.selectAll"),
          action: () => emitMenuEvent("menu-select-all"),
        },
      ];
    case "view":
      return [
        {
          type: "item",
          text: t("windowChrome.items.commandPalette"),
          action: () => emitMenuEvent("menu-toggle-spotlight"),
        },
        {
          type: "item",
          text: t("windowChrome.items.goToFile"),
          action: () => emitMenuEvent("menu-open-file-palette"),
        },
        {
          type: "item",
          text: t("windowChrome.items.selectModel"),
          accelerator: "Ctrl+/",
          action: () => emitMenuEvent("menu-open-model-selector"),
        },
        {
          type: "item",
          text: t("windowChrome.items.switchWorkspace"),
          accelerator: "Ctrl+.",
          action: () => emitMenuEvent("menu-open-workspace-selector"),
        },
        {
          type: "item",
          text: t("windowChrome.items.switchBranch"),
          accelerator: "Ctrl+Alt+.",
          action: () => emitMenuEvent("menu-open-branch-selector"),
        },
        {
          type: "item",
          text: t("windowChrome.items.switchRunningLocation"),
          accelerator: "Ctrl+Shift+.",
          action: () => emitMenuEvent("menu-open-location-selector"),
        },
        { type: "separator" },
        {
          type: "item",
          text: t("windowChrome.items.settings"),
          accelerator: "Ctrl+,",
          action: () => emitMenuEvent("menu-open-settings"),
        },
        { type: "separator" },
        {
          type: "item",
          text: t("windowChrome.items.zoomIn"),
          action: () => emitMenuEvent("menu-zoom-in"),
        },
        {
          type: "item",
          text: t("windowChrome.items.zoomOut"),
          action: () => emitMenuEvent("menu-zoom-out"),
        },
        {
          type: "item",
          text: t("windowChrome.items.actualSize"),
          action: () => emitMenuEvent("menu-zoom-reset"),
        },
      ];
    case "window":
      return [
        {
          type: "item",
          text: t("windowChrome.items.minimize"),
          action: minWindow,
        },
        {
          type: "item",
          text: t("windowChrome.items.maximizeRestore"),
          action: maxWindow,
        },
        {
          type: "item",
          text: t("windowChrome.items.maximizeWorkstation"),
          accelerator: "Ctrl+Shift+M",
          action: () => emitMenuEvent("menu-maximize-work-station"),
        },
        { type: "separator" },
        {
          type: "item",
          text: t("windowChrome.items.closeWindow"),
          action: closeWindow,
        },
      ];
    case "help":
      return [
        {
          type: "item",
          text: t("windowChrome.items.documentation"),
          action: () => open("https://github.com/YORG-AI/ORGII/wiki"),
        },
        {
          type: "item",
          text: t("windowChrome.items.reportIssue"),
          action: () => open("https://github.com/YORG-AI/ORGII/issues"),
        },
      ];
  }
}

async function showNativeStyleMenu(
  menuKey: NativeMenuKey,
  anchor: HTMLElement,
  t: TFunction
) {
  const rect = anchor.getBoundingClientRect();
  await popupNativeMenu({
    source: `windows-top-bar:${menuKey}`,
    buildItems: () =>
      getMenuItems(menuKey, t).map<NativeMenuItemOptions>((item) => {
        if (item.type === "separator") return { item: "Separator" };
        return {
          text: item.text,
          enabled: item.enabled ?? true,
          accelerator: item.accelerator,
          action: item.action,
        };
      }),
    at: new LogicalPosition(Math.round(rect.left), Math.round(rect.bottom)),
    fallbackToCursor: true,
  });
}

const WindowsTopBarComponent: React.FC = () => {
  const activeLanguage = useSyncExternalStore(
    subscribeToLanguageChange,
    getActiveLanguage,
    getActiveLanguage
  );
  const t = useMemo(
    () => i18n.getFixedT(activeLanguage, "common"),
    [activeLanguage]
  );

  const handleMinimize = useCallback(() => {
    handleWindowAction(minWindow);
  }, []);

  const handleMaximize = useCallback(() => {
    handleWindowAction(maxWindow);
  }, []);

  const handleClose = useCallback(() => {
    handleWindowAction(closeWindow);
  }, []);

  const handleOpenMenu = useCallback(
    (menuKey: NativeMenuKey, event: React.MouseEvent<HTMLButtonElement>) => {
      void showNativeStyleMenu(menuKey, event.currentTarget, t);
    },
    [t]
  );

  return (
    <div
      className="relative z-50 flex shrink-0 items-center text-text-1"
      data-windows-top-bar="true"
      data-tauri-drag-region
      style={
        {
          height: TOP_BAR_HEIGHT,
          minHeight: TOP_BAR_HEIGHT,
          WebkitAppRegion: "drag",
        } as React.CSSProperties
      }
    >
      <NoDragRegion className={MENU_BAR_CLASS}>
        {MENU_KEYS.map((menuKey) => {
          const label = t(`windowChrome.menus.${menuKey}`);
          return (
            <button
              key={menuKey}
              type="button"
              className={MENU_BUTTON_CLASS}
              onClick={(event) => handleOpenMenu(menuKey, event)}
              aria-label={t("windowChrome.menus.aria", { label })}
            >
              {label}
            </button>
          );
        })}
      </NoDragRegion>

      <div className="h-full min-w-0 flex-1" data-tauri-drag-region />

      <div
        className="flex h-full shrink-0 items-center"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          type="button"
          className={WINDOW_CONTROL_BUTTON_CLASS}
          onClick={handleMinimize}
          aria-label={t("windowChrome.controls.minimizeWindow")}
          title={t("windowChrome.items.minimize")}
        >
          <HugeiconsIcon
            icon={MinusSignIcon}
            data-icon="minus"
            size={ICON_SIZE}
            strokeWidth={2}
          />
        </button>
        <button
          type="button"
          className={WINDOW_CONTROL_BUTTON_CLASS}
          onClick={handleMaximize}
          aria-label={t("windowChrome.controls.maximizeRestoreWindow")}
          title={t("windowChrome.items.maximizeRestore")}
        >
          <HugeiconsIcon
            icon={SquareIcon}
            data-icon="square"
            size={12}
            strokeWidth={2}
          />
        </button>
        <button
          type="button"
          className={CLOSE_BUTTON_CLASS}
          onClick={handleClose}
          aria-label={t("windowChrome.controls.closeWindow")}
          title={t("windowChrome.items.closeWindow")}
        >
          <HugeiconsIcon
            icon={Cancel01Icon}
            data-icon="x"
            size={ICON_SIZE}
            strokeWidth={2}
          />
        </button>
      </div>
    </div>
  );
};

export const WindowsTopBar = memo(WindowsTopBarComponent);
WindowsTopBar.displayName = "WindowsTopBar";
