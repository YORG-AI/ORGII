import { LogicalPosition } from "@tauri-apps/api/dpi";
import {
  MenuItem,
  PredefinedMenuItem,
  Menu as TauriMenu,
} from "@tauri-apps/api/menu";
import { open } from "@tauri-apps/plugin-shell";
import { Minus, Square, X } from "lucide-react";
import React, { memo, useCallback } from "react";

import { NoDragRegion } from "@src/modules/WorkStation/shared";
import {
  closeWindow,
  maxWindow,
  minWindow,
} from "@src/util/platform/ipcRenderer";

const TOP_BAR_HEIGHT = 36;
const ICON_SIZE = 14;

const MENU_BAR_CLASS = "flex h-full shrink-0 items-center gap-0.5 px-1";

const MENU_BUTTON_CLASS =
  "flex h-7 items-center rounded-md border-0 bg-transparent px-2 text-[13px] text-text-2 transition-colors hover:bg-fill-2 hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/30";

const WINDOW_CONTROL_BUTTON_CLASS =
  "flex h-full w-11 items-center justify-center border-0 bg-transparent p-0 text-text-2 transition-colors hover:bg-fill-2 hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/30";

const CLOSE_BUTTON_CLASS =
  "flex h-full w-11 items-center justify-center border-0 bg-transparent p-0 text-text-2 transition-colors hover:bg-danger-6 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-6/30";

type NativeMenuKey = "orgii" | "file" | "edit" | "view" | "window" | "help";

type NativeMenuItem =
  | {
      type: "item";
      text: string;
      action: () => void | Promise<void>;
      enabled?: boolean;
      accelerator?: string;
    }
  | { type: "separator" };

const MENU_LABELS: Array<{ key: NativeMenuKey; label: string }> = [
  { key: "orgii", label: "ORGII" },
  { key: "file", label: "File" },
  { key: "edit", label: "Edit" },
  { key: "view", label: "View" },
  { key: "window", label: "Window" },
  { key: "help", label: "Help" },
];

function emitMenuEvent(eventName: string) {
  window.dispatchEvent(new CustomEvent(eventName));
}

function handleWindowAction(action: () => Promise<void>) {
  void action();
}

function getMenuItems(menu: NativeMenuKey): NativeMenuItem[] {
  switch (menu) {
    case "orgii":
      return [
        {
          type: "item",
          text: "Quit ORGII",
          accelerator: "Ctrl+Q",
          action: () => emitMenuEvent("native-quit-confirmation-open"),
        },
      ];
    case "file":
      return [
        {
          type: "item",
          text: "New Session",
          accelerator: "Ctrl+N",
          action: () => emitMenuEvent("menu-new-session"),
        },
        { type: "separator" },
        {
          type: "item",
          text: "Open Folder...",
          accelerator: "Ctrl+O",
          action: () => emitMenuEvent("menu-file-open-folder"),
        },
        {
          type: "item",
          text: "Add Folder to Workspace...",
          action: () => emitMenuEvent("menu-add-folder-to-workspace"),
        },
        { type: "separator" },
        {
          type: "item",
          text: "Save Workspace As...",
          action: () => emitMenuEvent("menu-save-workspace-as"),
        },
        { type: "separator" },
        {
          type: "item",
          text: "Close Window",
          accelerator: "Ctrl+Shift+W",
          action: closeWindow,
        },
      ];
    case "edit":
      return [
        {
          type: "item",
          text: "Undo",
          action: () => document.execCommand("undo"),
        },
        {
          type: "item",
          text: "Redo",
          action: () => document.execCommand("redo"),
        },
        { type: "separator" },
        {
          type: "item",
          text: "Cut",
          action: () => document.execCommand("cut"),
        },
        {
          type: "item",
          text: "Copy",
          action: () => document.execCommand("copy"),
        },
        {
          type: "item",
          text: "Paste",
          action: () => document.execCommand("paste"),
        },
        {
          type: "item",
          text: "Select All",
          action: () => emitMenuEvent("menu-select-all"),
        },
      ];
    case "view":
      return [
        {
          type: "item",
          text: "Command Palette",
          action: () => emitMenuEvent("menu-toggle-spotlight"),
        },
        {
          type: "item",
          text: "Go to File...",
          action: () => emitMenuEvent("menu-open-file-palette"),
        },
        {
          type: "item",
          text: "Select Model...",
          accelerator: "Ctrl+/",
          action: () => emitMenuEvent("menu-open-model-selector"),
        },
        {
          type: "item",
          text: "Switch Workspace...",
          accelerator: "Ctrl+.",
          action: () => emitMenuEvent("menu-open-workspace-selector"),
        },
        {
          type: "item",
          text: "Switch Branch...",
          accelerator: "Ctrl+Alt+.",
          action: () => emitMenuEvent("menu-open-branch-selector"),
        },
        {
          type: "item",
          text: "Switch Running Location...",
          accelerator: "Ctrl+Shift+.",
          action: () => emitMenuEvent("menu-open-location-selector"),
        },
        { type: "separator" },
        {
          type: "item",
          text: "Settings...",
          accelerator: "Ctrl+,",
          action: () => emitMenuEvent("menu-open-settings"),
        },
        { type: "separator" },
        {
          type: "item",
          text: "Zoom In",
          action: () => emitMenuEvent("menu-zoom-in"),
        },
        {
          type: "item",
          text: "Zoom Out",
          action: () => emitMenuEvent("menu-zoom-out"),
        },
        {
          type: "item",
          text: "Actual Size",
          action: () => emitMenuEvent("menu-zoom-reset"),
        },
      ];
    case "window":
      return [
        { type: "item", text: "Minimize", action: minWindow },
        { type: "item", text: "Maximize / Restore", action: maxWindow },
        {
          type: "item",
          text: "Maximize Workstation",
          accelerator: "Ctrl+Shift+M",
          action: () => emitMenuEvent("menu-maximize-work-station"),
        },
        { type: "separator" },
        { type: "item", text: "Close Window", action: closeWindow },
      ];
    case "help":
      return [
        {
          type: "item",
          text: "Documentation",
          action: () => open("https://github.com/YORG-AI/ORGII/wiki"),
        },
        {
          type: "item",
          text: "Report Issue",
          action: () => open("https://github.com/YORG-AI/ORGII/issues"),
        },
      ];
  }
}

async function showNativeStyleMenu(
  menuKey: NativeMenuKey,
  anchor: HTMLElement
) {
  const menuItems = await Promise.all(
    getMenuItems(menuKey).map(async (item) => {
      if (item.type === "separator") {
        return PredefinedMenuItem.new({ item: "Separator" });
      }

      return MenuItem.new({
        text: item.text,
        enabled: item.enabled ?? true,
        accelerator: item.accelerator,
        action: item.action,
      });
    })
  );

  const menu = await TauriMenu.new({ items: menuItems });
  const rect = anchor.getBoundingClientRect();

  try {
    await menu.popup(
      new LogicalPosition(Math.round(rect.left), Math.round(rect.bottom))
    );
  } catch {
    await menu.popup();
  }
}

const WindowsTopBarComponent: React.FC = () => {
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
      void showNativeStyleMenu(menuKey, event.currentTarget);
    },
    []
  );

  return (
    <div
      className="relative z-50 flex shrink-0 items-center border-b border-border-2 bg-bg-2 text-text-1"
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
        {MENU_LABELS.map((menu) => (
          <button
            key={menu.key}
            type="button"
            className={MENU_BUTTON_CLASS}
            onClick={(event) => handleOpenMenu(menu.key, event)}
            aria-label={`${menu.label} menu`}
          >
            {menu.label}
          </button>
        ))}
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
          aria-label="Minimize window"
          title="Minimize"
        >
          <Minus size={ICON_SIZE} strokeWidth={2} />
        </button>
        <button
          type="button"
          className={WINDOW_CONTROL_BUTTON_CLASS}
          onClick={handleMaximize}
          aria-label="Maximize or restore window"
          title="Maximize / Restore"
        >
          <Square size={12} strokeWidth={2} />
        </button>
        <button
          type="button"
          className={CLOSE_BUTTON_CLASS}
          onClick={handleClose}
          aria-label="Close window"
          title="Close"
        >
          <X size={ICON_SIZE} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
};

export const WindowsTopBar = memo(WindowsTopBarComponent);
WindowsTopBar.displayName = "WindowsTopBar";
