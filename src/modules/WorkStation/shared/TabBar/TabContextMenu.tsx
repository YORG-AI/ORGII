/**
 * TabContextMenu Component
 *
 * Native OS context menu for tabs using Tauri v2 Menu API.
 * Provides actions like close, copy path, reveal in finder/explorer.
 *
 * Uses dispatch() for actions per GUI Action System guidelines.
 * Matches the pattern used by TabManager.tsx which works reliably.
 */
import i18next from "i18next";
import { useEffect, useRef } from "react";

import { createLogger } from "@src/hooks/logger";
import { copyText } from "@src/util/data/clipboard";
import { getFileManagerRevealLabelKey } from "@src/util/platform/fileManagerLabels";
import {
  type NativeMenuItemOptions,
  popupNativeMenu,
} from "@src/util/platform/tauri/nativeMenuPopup";

import type { WorkStationTab } from "./types";

const logger = createLogger("TabContextMenu");

// ============================================
// Types
// ============================================

/** Dispatch function type for GUI actions */
type DispatchFn = (
  actionType: string,
  payload: Record<string, unknown>,
  source: "user" | "ai" | "system"
) => Promise<unknown>;

export interface TabContextMenuProps {
  /** Position of the menu */
  position: { x: number; y: number };
  /** Tab that was right-clicked */
  tab: WorkStationTab;
  /** Repository path for relative path calculation */
  repoPath: string;
  /** Callback when menu is closed */
  onClose: () => void;
  /** Callback to close a tab */
  onCloseTab: (tabId: string) => void;
  /** Callback to close all other tabs */
  onCloseOtherTabs: (tabId: string) => void;
  /** Callback to close all saved tabs */
  onCloseSavedTabs: () => void;
  /** Move a chat-session tab back to the Chat Panel tab strip. */
  onMoveSessionToChatPanel?: (tab: WorkStationTab) => void;
  /** Open the full raw transcript for a chat-session tab. */
  onViewRawTranscript?: (sessionId: string) => void;
  /** Review a chat-session as a Team Inbox Work Item handoff. */
  onCreateWorkItemFromSession?: (tab: WorkStationTab) => void;
  /** Dispatch function for GUI actions */
  dispatch?: DispatchFn;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get file path from tab
 */
function getFilePath(tab: WorkStationTab): string | null {
  if (tab.type === "file" || tab.type === "git-diff") {
    return tab.data.filePath as string;
  }
  return null;
}

/**
 * Get relative path from absolute path
 */
function getRelativePath(absolutePath: string, repoPath: string): string {
  if (!absolutePath || !repoPath) return absolutePath;

  // Normalize paths (remove trailing slashes)
  const normalizedRepo = repoPath.replace(/\/$/, "");
  const normalizedPath = absolutePath.replace(/\/$/, "");

  // If path starts with repo path, remove it
  if (normalizedPath.startsWith(normalizedRepo)) {
    const relative = normalizedPath.slice(normalizedRepo.length);
    // Remove leading slash
    return relative.startsWith("/") ? relative.slice(1) : relative;
  }

  return absolutePath;
}

/**
 * Copy text to clipboard
 */
function copyToClipboard(text: string): void {
  copyText(text).catch((err) => {
    logger.error("Failed to copy to clipboard:", err);
  });
}

/**
 * Reveal file in system file explorer using dispatch
 */
function revealInFileExplorer(filePath: string, dispatch?: DispatchFn): void {
  if (dispatch) {
    dispatch("file.revealInFinder", { path: filePath }, "user");
  } else {
    // Fallback: use window event for components without dispatch access
    window.dispatchEvent(
      new CustomEvent("file-reveal-in-finder", { detail: { path: filePath } })
    );
  }
}

// ============================================
// Ref to store context for menu callbacks
// This is the same pattern used by TabManager.tsx
// ============================================

// Module-level ref that persists across renders
const contextMenuRef: { current: TabContextMenuProps | null } = {
  current: null,
};

// ============================================
// Main Component
// ============================================

export function TabContextMenu(props: TabContextMenuProps) {
  const {
    tab,
    repoPath,
    onClose,
    onCloseTab: _onCloseTab,
    onCloseOtherTabs: _onCloseOtherTabs,
    onCloseSavedTabs: _onCloseSavedTabs,
  } = props;

  const filePath = getFilePath(tab);
  const _relativePath = filePath ? getRelativePath(filePath, repoPath) : null;
  const hasShownMenu = useRef(false);

  // Store props in module-level ref for menu callbacks
  useEffect(() => {
    contextMenuRef.current = props;
    return () => {
      contextMenuRef.current = null;
    };
  }, [props]);

  // Show native Tauri v2 menu once on mount
  useEffect(() => {
    if (hasShownMenu.current) return;
    hasShownMenu.current = true;

    async function showNativeMenu() {
      try {
        const result = await popupNativeMenu({
          source: "workstation-tab",
          onBusy: onClose,
          buildItems: () => {
            const t = i18next.t.bind(i18next);
            const items: NativeMenuItemOptions[] = [
              {
                text: t("actions.close"),
                action: () => {
                  if (contextMenuRef.current) {
                    contextMenuRef.current.onCloseTab(
                      contextMenuRef.current.tab.id
                    );
                    contextMenuRef.current.onClose();
                  }
                },
              },
              {
                text: t("actions.closeOthers"),
                action: () => {
                  if (contextMenuRef.current) {
                    contextMenuRef.current.onCloseOtherTabs(
                      contextMenuRef.current.tab.id
                    );
                    contextMenuRef.current.onClose();
                  }
                },
              },
              {
                text: t("actions.closeSaved"),
                action: () => {
                  if (contextMenuRef.current) {
                    contextMenuRef.current.onCloseSavedTabs();
                    contextMenuRef.current.onClose();
                  }
                },
              },
            ];

            if (tab.type === "chat-session") {
              const sessionId = tab.data.sessionId;
              if (typeof sessionId === "string" && sessionId.length > 0) {
                items.push(
                  { item: "Separator" },
                  {
                    text: t("teamInbox.handoff.createFromSession", {
                      defaultValue: "Create team Work Item…",
                    }),
                    action: () => {
                      const context = contextMenuRef.current;
                      if (context) {
                        context.onCreateWorkItemFromSession?.(context.tab);
                      }
                      context?.onClose();
                    },
                  },
                  {
                    text: t("sessions:chat.moveToChatPanel", {
                      defaultValue: "Move to Chat Panel",
                    }),
                    action: () => {
                      const context = contextMenuRef.current;
                      if (context)
                        context.onMoveSessionToChatPanel?.(context.tab);
                      context?.onClose();
                    },
                  },
                  {
                    text: t("sessions:chat.rawTranscript.menuItem", {
                      defaultValue: "View raw transcript",
                    }),
                    action: () => {
                      const context = contextMenuRef.current;
                      const activeSessionId = context?.tab.data.sessionId;
                      if (typeof activeSessionId === "string") {
                        context?.onViewRawTranscript?.(activeSessionId);
                      }
                      context?.onClose();
                    },
                  }
                );
              }
            }

            if (filePath) {
              items.push(
                { item: "Separator" },
                {
                  text: t("actions.copyPath"),
                  action: () => {
                    if (contextMenuRef.current?.tab) {
                      const path = getFilePath(contextMenuRef.current.tab);
                      if (path) copyToClipboard(path);
                    }
                    contextMenuRef.current?.onClose();
                  },
                },
                {
                  text: t("actions.copyRelativePath"),
                  action: () => {
                    if (contextMenuRef.current?.tab) {
                      const path = getFilePath(contextMenuRef.current.tab);
                      const rel = path
                        ? getRelativePath(path, contextMenuRef.current.repoPath)
                        : null;
                      if (rel) copyToClipboard(rel);
                    }
                    contextMenuRef.current?.onClose();
                  },
                },
                { item: "Separator" },
                {
                  text: t(getFileManagerRevealLabelKey()),
                  action: () => {
                    if (contextMenuRef.current?.tab) {
                      const path = getFilePath(contextMenuRef.current.tab);
                      if (path) {
                        revealInFileExplorer(
                          path,
                          contextMenuRef.current.dispatch
                        );
                      }
                    }
                    contextMenuRef.current?.onClose();
                  },
                },
                {
                  text: t("actions.revealInExplorer"),
                  action: () => {
                    if (contextMenuRef.current?.tab) {
                      const path = getFilePath(contextMenuRef.current.tab);
                      if (path && contextMenuRef.current.dispatch) {
                        contextMenuRef.current.dispatch(
                          "file.reveal",
                          { path },
                          "user"
                        );
                      }
                    }
                    contextMenuRef.current?.onClose();
                  },
                }
              );
            }

            return items;
          },
        });

        // After popup closes, ensure we clean up
        if (result.status !== "busy") {
          setTimeout(() => {
            onClose();
          }, 50);
        }
      } catch (error) {
        logger.error(
          "[TabContextMenu] Failed to show native context menu:",
          error
        );
        onClose();
      }
    }

    void showNativeMenu();
  }, [filePath, onClose, tab.data.sessionId, tab.type]);

  // Native menu doesn't render anything in React
  return null;
}

export default TabContextMenu;
