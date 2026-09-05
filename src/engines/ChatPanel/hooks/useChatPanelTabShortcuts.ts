import { useAtomValue, useSetAtom } from "jotai";
import { type RefObject, useCallback, useEffect, useRef } from "react";

import {
  closeAndDestroyChatPanelTabAtom,
  nextChatPanelTabAtom,
  prevChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabLifecycleAtoms";
import {
  goBackChatPanelTabAtom,
  goForwardChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabNavigationAtoms";
import { chatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabsState";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { isMacOS } from "@src/util/platform/tauri";

import { resolveChatPanelShortcutOwnership } from "./chatPanelShortcutOwnership";

export interface UseChatPanelTabShortcutsOptions {
  onNewSession: () => void;
  onNewTerminal: () => void;
  /** Ref to the outermost chat panel container for focus-scoped keyboard handling */
  containerRef?: RefObject<HTMLElement | null>;
}

type ModifierState = Pick<KeyboardEvent, "ctrlKey" | "metaKey">;

export function isChatPanelPrimaryModifierPressed(
  event: ModifierState,
  macOS = isMacOS()
): boolean {
  return macOS ? event.metaKey : event.ctrlKey;
}

/**
 * The bracket a shortcut targets, independent of the shifted glyph the
 * keyboard layout reports (`{` / `}` on US layouts) — `code` names the physical
 * key, `key` is the fallback for synthetic events.
 */
export function resolveChatPanelBracketKey(
  event: Pick<KeyboardEvent, "code" | "key">
): "[" | "]" | null {
  if (event.code === "BracketLeft") return "[";
  if (event.code === "BracketRight") return "]";
  if (event.key === "[" || event.key === "{") return "[";
  if (event.key === "]" || event.key === "}") return "]";
  return null;
}

/**
 * Chat-panel-scoped tab shortcuts plus the global "create-chat-tab" event.
 * Mounted by ChatPanel unconditionally so the shortcuts work even when the
 * visual tab strip is not rendered. Bracket bindings follow the browser
 * convention the editor already uses: ⌘[ / ⌘] walk the active tab's session
 * history, ⇧⌘[ / ⇧⌘] switch tabs.
 */
export function useChatPanelTabShortcuts({
  onNewSession,
  onNewTerminal,
  containerRef,
}: UseChatPanelTabShortcutsOptions): void {
  const state = useAtomValue(chatPanelTabsAtom);
  const isChatPanelMaximized = useAtomValue(chatPanelMaximizedAtom);
  const closeTab = useSetAtom(closeAndDestroyChatPanelTabAtom);
  const nextTab = useSetAtom(nextChatPanelTabAtom);
  const prevTab = useSetAtom(prevChatPanelTabAtom);
  const goBack = useSetAtom(goBackChatPanelTabAtom);
  const goForward = useSetAtom(goForwardChatPanelTabAtom);

  const tabsRef = useRef(state);
  const paneOwnsShortcutsRef = useRef(containerRef === undefined);
  useEffect(() => {
    tabsRef.current = state;
  }, [state]);

  useEffect(() => {
    if (containerRef === undefined) {
      paneOwnsShortcutsRef.current = true;
      return undefined;
    }

    const updatePaneOwnership = (target: EventTarget | null) => {
      paneOwnsShortcutsRef.current = resolveChatPanelShortcutOwnership(
        containerRef.current,
        target,
        paneOwnsShortcutsRef.current
      );
    };
    const handlePointerDown = (event: PointerEvent) => {
      updatePaneOwnership(event.target);
    };
    const handleFocusIn = (event: FocusEvent) => {
      updatePaneOwnership(event.target);
    };

    updatePaneOwnership(document.activeElement);
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("focusin", handleFocusIn, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("focusin", handleFocusIn, true);
    };
  }, [containerRef]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!isChatPanelMaximized && !paneOwnsShortcutsRef.current) return;
      if (!isChatPanelPrimaryModifierPressed(event)) return;

      if (event.key.toLowerCase() === "w" && !event.shiftKey) {
        const active = tabsRef.current.tabs.find(
          (tab) => tab.id === tabsRef.current.activeTabId
        );
        if (active) {
          event.preventDefault();
          event.stopPropagation();
          void closeTab(active.id);
        }
        return;
      }
      const bracket = resolveChatPanelBracketKey(event);
      if (bracket !== null) {
        event.preventDefault();
        event.stopPropagation();
        if (bracket === "]") {
          if (event.shiftKey) nextTab();
          else goForward();
        } else if (event.shiftKey) {
          prevTab();
        } else {
          goBack();
        }
        return;
      }
      if (event.key.toLowerCase() === "n" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        onNewSession();
      }
    },
    [
      closeTab,
      goBack,
      goForward,
      isChatPanelMaximized,
      nextTab,
      onNewSession,
      prevTab,
    ]
  );

  useEffect(() => {
    // Capture before the app-wide WorkStation listener on `document`, so a
    // focused/maximized chat pane owns its tab shortcuts without also closing
    // the underlying WorkStation tab.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  useEffect(() => {
    const handler = () => onNewTerminal();
    window.addEventListener("create-chat-tab", handler);
    return () => window.removeEventListener("create-chat-tab", handler);
  }, [onNewTerminal]);
}
