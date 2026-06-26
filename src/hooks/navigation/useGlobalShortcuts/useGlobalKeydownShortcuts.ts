import { type MutableRefObject, useEffect } from "react";

import { shortcutRegistry } from "@src/hooks/keyboard";
import { routeDebugModalOpenAtom } from "@src/store";
import { devModeEnabledAtom } from "@src/store/platform/devModeAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { isEditableElement, isEditableElementExtended } from "./types";

function selectActiveTextControl(): boolean {
  const activeElement = document.activeElement;
  if (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement
  ) {
    activeElement.select();
    return true;
  }
  return false;
}

function isTerminalShortcutTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.closest(".terminal-core") !== null ||
      target.closest(".xterm") !== null ||
      target.closest(".xterm-terminal-container") !== null)
  );
}

function handleSelectAllShortcut() {
  const terminalEl = document.querySelector(".terminal-core");
  if (
    terminalEl?.contains(document.activeElement) ||
    terminalEl === document.activeElement
  ) {
    window.dispatchEvent(new CustomEvent("terminal-select-all"));
    return;
  }

  if (!selectActiveTextControl()) {
    document.execCommand("selectAll");
  }
}

interface UseGlobalKeydownShortcutsOptions {
  inspectModeRef: MutableRefObject<boolean>;
  handleInspectMoveUpLevel: () => Promise<boolean | undefined>;
  handleInspectMoveDownLevel: () => Promise<boolean | undefined>;
  handleInspectToggleLabels: () => Promise<boolean>;
  handleInspectHideLabels: () => Promise<boolean>;
  handleZoomReset: () => boolean;
  spotlightOpenRef: MutableRefObject<boolean>;
  handleOpenWorkStationFilePalette: () => void;
  handleOpenWorkStationSymbolPalette: () => void;
  handleOpenAgentSessionSearch: () => void;
  handleOpenSettings: () => void;
  handleToggleSidebar: () => void;
  handleToggleWorkstationSidebar: () => void;
  handleOpenCodeEditorFileFolder: () => void;
  handleOpenCodeEditorSourceControl: () => void;
  handleOpenCodeEditorSearchSidebar: () => void;
  handleOpenCodeEditorTerminal: () => void;
  handleCloseCurrentTab: () => boolean;
  handleToggleWorkStationChatFocus: () => void;
  openQuitConfirmation: () => void;
  closeQuitConfirmation: () => void;
}

export function useGlobalKeydownShortcuts(
  options: UseGlobalKeydownShortcutsOptions
) {
  const {
    inspectModeRef,
    handleInspectMoveUpLevel,
    handleInspectMoveDownLevel,
    handleInspectToggleLabels,
    handleInspectHideLabels,
    handleZoomReset,
    spotlightOpenRef,
    handleOpenWorkStationFilePalette,
    handleOpenWorkStationSymbolPalette,
    handleOpenAgentSessionSearch,
    handleOpenSettings,
    handleToggleSidebar,
    handleToggleWorkstationSidebar,
    handleOpenCodeEditorFileFolder,
    handleOpenCodeEditorSourceControl,
    handleOpenCodeEditorSearchSidebar,
    handleOpenCodeEditorTerminal,
    handleCloseCurrentTab,
    handleToggleWorkStationChatFocus,
    openQuitConfirmation,
    closeQuitConfirmation,
  } = options;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;

      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const modifierKey = isMac ? event.metaKey : event.ctrlKey;

      if (
        !isMac &&
        modifierKey &&
        event.code === "KeyQ" &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        openQuitConfirmation();
        return;
      }

      if (event.key === "Backspace") {
        const target = event.target;
        if (!isEditableElementExtended(target)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (
        event.key === "Tab" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        inspectModeRef.current
      ) {
        const target = event.target;
        if (!isEditableElement(target)) {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) {
            handleInspectMoveDownLevel();
          } else {
            handleInspectMoveUpLevel();
          }
          return;
        }
      }

      if (
        (event.key.toLowerCase() === "h" || event.key.toLowerCase() === "x") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        inspectModeRef.current
      ) {
        const target = event.target;
        if (!isEditableElement(target)) {
          event.preventDefault();
          event.stopPropagation();
          if (event.key.toLowerCase() === "x") {
            handleInspectHideLabels();
          } else {
            handleInspectToggleLabels();
          }
          return;
        }
      }

      if (event.key === "Tab" && event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          shortcutRegistry.dispatch("previous_tab");
        } else {
          shortcutRegistry.dispatch("next_tab");
        }
        return;
      }

      if (isMac && event.metaKey && event.altKey) {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("next_tab_mac");
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("previous_tab_mac");
          return;
        }
      }

      {
        const macCombo =
          isMac &&
          event.metaKey &&
          event.altKey &&
          !event.shiftKey &&
          !event.ctrlKey;
        const winCombo =
          !isMac &&
          event.ctrlKey &&
          event.altKey &&
          !event.shiftKey &&
          !event.metaKey;
        if (macCombo || winCombo) {
          const path = window.location.pathname;
          const workStationShortcutSurface = path.includes("/workstation");
          if (workStationShortcutSurface && event.code === "KeyB") {
            event.preventDefault();
            event.stopPropagation();
            handleToggleWorkStationChatFocus();
            return;
          }
          if (event.code === "KeyG") {
            event.preventDefault();
            event.stopPropagation();
            shortcutRegistry.dispatch("toggle_ade_manager");
            return;
          }
          if (event.code === "KeyU") {
            event.preventDefault();
            event.stopPropagation();
            handleToggleWorkstationSidebar();
            return;
          }
        }
      }

      if (!modifierKey) return;

      // NOTE: The selector shortcuts ⌘. (workspace), ⌥⌘. (branch),
      // ⇧⌘. (running location) are owned by the native application menu
      // (View → Switch Workspace.../Switch Branch.../Switch Running
      // Location... in `app_menu.rs`). Routing them through the menu is
      // required for plain ⌘. (AppKit captures it as cancelOperation:
      // before WKWebView delivers a keydown). ⌘/ (model) is handled here
      // as well as via the menu for dev-browser and cross-platform parity.

      if (event.code === "KeyB" && !event.shiftKey && !event.altKey) {
        const target = event.target;
        if (isEditableElementExtended(target)) return;
        event.preventDefault();
        event.stopPropagation();
        handleToggleSidebar();
        return;
      }

      if (
        window.location.pathname.startsWith("/orgii/workstation") &&
        !event.shiftKey &&
        !event.altKey
      ) {
        const target = event.target;
        if (
          isEditableElementExtended(target) &&
          !isTerminalShortcutTarget(target)
        ) {
          return;
        }

        if (event.code === "KeyG") {
          event.preventDefault();
          event.stopPropagation();
          handleOpenCodeEditorFileFolder();
          return;
        }

        if (event.code === "KeyE") {
          event.preventDefault();
          event.stopPropagation();
          handleOpenCodeEditorSourceControl();
          return;
        }

        if (event.code === "KeyJ") {
          event.preventDefault();
          event.stopPropagation();
          handleOpenCodeEditorTerminal();
          return;
        }
      }

      if (!event.shiftKey && !event.altKey) {
        if (event.code === "Digit1") {
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("open_my_station");
          return;
        }

        if (event.code === "Digit2") {
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("open_agent_station");
          return;
        }

        if (event.code === "Digit3") {
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("open_ops_control");
          return;
        }
      }

      if (event.code === "Digit0") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.shiftKey) {
          handleZoomReset();
          return;
        }

        const store = getInstrumentedStore();
        if (store.get(devModeEnabledAtom)) {
          store.set(routeDebugModalOpenAtom, (prev) => !prev);
        }
        return;
      }

      switch (event.key.toLowerCase()) {
        case "a": {
          if (event.shiftKey || event.altKey) return;
          const target = event.target;
          const terminalEl = document.querySelector(".terminal-core");
          const isTerminalTarget =
            target instanceof Node &&
            (terminalEl?.contains(target) || terminalEl === target);
          if (isEditableElementExtended(target) && !isTerminalTarget) return;
          event.preventDefault();
          event.stopPropagation();
          handleSelectAllShortcut();
          break;
        }

        case "w": {
          event.preventDefault();
          event.stopPropagation();
          handleCloseCurrentTab();
          break;
        }

        case "m": {
          if (event.altKey) return;
          const target = event.target;
          if (
            event.ctrlKey &&
            !event.metaKey &&
            isEditableElementExtended(target)
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) {
            shortcutRegistry.dispatch("maximize_work_station");
          } else {
            shortcutRegistry.dispatch("hide_window");
          }
          break;
        }

        case "n":
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("new_session");
          break;

        case "t":
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("new_tab");
          break;

        case "l":
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("new_tab_alt");
          break;

        case ",":
          if (event.shiftKey || event.altKey) return;
          event.preventDefault();
          event.stopPropagation();
          handleOpenSettings();
          break;

        case "k": {
          if (event.shiftKey || event.altKey) return;
          const target = event.target;
          if (!spotlightOpenRef.current && target instanceof HTMLElement) {
            if (
              target.tagName === "INPUT" ||
              target.tagName === "TEXTAREA" ||
              target.isContentEditable
            ) {
              return;
            }
          }
          event.preventDefault();
          event.stopPropagation();
          handleOpenAgentSessionSearch();
          break;
        }

        case "8":
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("toggle_inspect_mode");
          break;

        case "9":
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("capture_component");
          break;

        case "5":
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("toggle_api_panel");
          break;

        case "=":
        case "+":
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("zoom_in");
          break;

        case "-":
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("zoom_out");
          break;

        case "/":
          if (event.shiftKey || event.altKey) return;
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("open_model_selector");
          break;

        case "o": {
          if (!event.shiftKey) return;
          if (!window.location.pathname.startsWith("/orgii/workstation")) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          handleOpenWorkStationSymbolPalette();
          break;
        }

        case "p": {
          if (!event.altKey && !event.shiftKey) {
            if (!window.location.pathname.startsWith("/orgii/workstation")) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            handleOpenWorkStationFilePalette();
            break;
          }

          if (!event.shiftKey) return;
          const target = event.target;
          if (!spotlightOpenRef.current && target instanceof HTMLElement) {
            if (
              target.tagName === "INPUT" ||
              target.tagName === "TEXTAREA" ||
              target.isContentEditable
            ) {
              return;
            }
          }
          event.preventDefault();
          event.stopPropagation();
          shortcutRegistry.dispatch("toggle_spotlight");
          break;
        }

        case "f": {
          if (event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            handleOpenCodeEditorSearchSidebar();
            break;
          }

          const target = event.target;
          if (!(target instanceof Element) || !target.closest(".cm-editor")) {
            event.preventDefault();
          }
          break;
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      closeQuitConfirmation();
    };
  }, [
    handleZoomReset,
    handleInspectMoveUpLevel,
    handleInspectMoveDownLevel,
    handleInspectToggleLabels,
    handleInspectHideLabels,
    inspectModeRef,
    spotlightOpenRef,
    handleOpenWorkStationFilePalette,
    handleOpenWorkStationSymbolPalette,
    handleOpenAgentSessionSearch,
    handleOpenSettings,
    handleToggleSidebar,
    handleToggleWorkstationSidebar,
    handleOpenCodeEditorFileFolder,
    handleOpenCodeEditorSourceControl,
    handleOpenCodeEditorSearchSidebar,
    handleOpenCodeEditorTerminal,
    handleCloseCurrentTab,
    handleToggleWorkStationChatFocus,
    openQuitConfirmation,
    closeQuitConfirmation,
  ]);
}
