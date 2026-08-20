/**
 * useEditorPaneState Hook
 *
 * Manages tab state for a single editor pane:
 * - Tab switching, closing, reordering
 * - Close other tabs, close saved tabs
 * - Unsaved changes dialogs
 *
 * Performance optimizations:
 * - Uses refs to avoid stale closures in callbacks
 * - Stable callback references to prevent child re-renders
 */
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAtomValue, useSetAtom } from "jotai";
import { selectAtom } from "jotai/utils";
import { type MutableRefObject, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { createLogger } from "@src/hooks/logger";
import { invalidateFileCache } from "@src/modules/WorkStation/CodeEditor/hooks/fileContent/useFileContent";
import { tabToHost } from "@src/store/workstation/tabHost";
import {
  type PanelState,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";
import { askNativeDialogSafely } from "@src/util/dialogs/nativeDialog";

import { DEFAULT_PANEL_STATE } from "../config";
import type { UseEditorPaneStateReturn } from "../types";

const log = createLogger("useEditorPaneState");

// ============================================
// Helpers
// ============================================

function isCsvTableFile(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  return lowerPath.endsWith(".csv") || lowerPath.endsWith(".tsv");
}

// ============================================
// Types for internal use
// ============================================

interface FileContentStateRef {
  content: string;
  hasUnsavedChanges: boolean;
  isBinary: boolean;
  markSaved: () => void;
  discardChanges: () => void;
}

// ============================================
// Hook Implementation
// ============================================

export function useEditorPaneState(
  /**
   * Optional ref to file content state for save-on-close. Null until the host
   * has rendered once — it is only dereferenced inside `closeTab`, which the
   * user cannot reach before first paint.
   */
  fileContentStateRef?: MutableRefObject<FileContentStateRef | null>,
  /** Optional ref to force refresh function */
  forceRefreshRef?: MutableRefObject<() => void>
): UseEditorPaneStateReturn {
  const { t } = useTranslation();

  const setLayout = useSetAtom(workstationLayoutAtom);

  // Single-pane workstation: this selector tracks the main pane.
  const paneStateAtom = useMemo(
    () =>
      selectAtom(workstationLayoutAtom, (layout) => {
        const state = layout?.mainPane;
        if (!state || !Array.isArray(state.tabs)) return DEFAULT_PANEL_STATE;
        return state;
      }),
    []
  );

  const currentState: PanelState = useAtomValue(paneStateAtom);

  // PERFORMANCE: Store current state in ref for use in callbacks
  // This avoids recreating callbacks when state changes
  const currentStateRef = useRef(currentState);
  currentStateRef.current = currentState;

  // Safety: ensure tabs is always an array (wrapped in useMemo for stable reference)
  const tabs = useMemo(() => currentState?.tabs ?? [], [currentState?.tabs]);
  const rawActiveTabId = currentState?.activeTabId ?? null;

  // The mainPane is a single flat pool shared across every host (Code
  // Editor / Browser / Database / Project Manager / Launchpad). When the
  // user is viewing the Code Editor surface but the globally-active tab
  // is a foreign-host tab (e.g. a browser session), the raw activeTabId
  // would point at a tab type this renderer cannot handle and the user
  // would see the "unknown tab type" placeholder. Project the active tab
  // through the host filter and fall back to the Explorer pinned tab
  // (the canonical empty-state tab for the Code Editor) when the
  // globally-active tab is owned by another host.
  const activeTab = useMemo(() => {
    const rawTab = tabs.find((tab) => tab.id === rawActiveTabId) ?? null;
    if (rawTab && tabToHost(rawTab) === "code") return rawTab;
    return tabs.find((tab) => tab.type === "explorer") ?? null;
  }, [tabs, rawActiveTabId]);

  const activeTabId = activeTab?.id ?? null;

  const updatePaneStateFn = useCallback(
    (updater: (state: PanelState) => PanelState) => {
      setLayout((prev) => ({
        ...prev,
        mainPane: updater(prev?.mainPane ?? { tabs: [], activeTabId: null }),
      }));
    },
    [setLayout]
  );

  // Tab operations
  const switchToTab = useCallback(
    (tabId: string) => {
      updatePaneStateFn((state: PanelState) => {
        const stateTabs = state?.tabs ?? [];
        const exists = stateTabs.find((tab) => tab.id === tabId);
        if (!exists) return state ?? { tabs: [], activeTabId: null };
        return { tabs: stateTabs, activeTabId: tabId };
      });
    },
    [updatePaneStateFn]
  );

  // PERFORMANCE: closeTab uses ref to access current state
  // This avoids recreating the callback when state changes
  const closeTab = useCallback(
    async (tabId: string) => {
      try {
        // Get current state from ref (always fresh, no stale closure)
        const state = currentStateRef.current;
        const stateTabs = state?.tabs ?? [];

        const tabToClose = stateTabs.find((tab) => tab.id === tabId);
        if (!tabToClose) return;

        // Check for unsaved changes and show three-button dialog
        if (tabToClose.hasUnsavedChanges && tabToClose.type === "file") {
          const isActiveTab = tabId === state?.activeTabId;
          const filePath = tabToClose.data.filePath as string;

          if (
            isActiveTab &&
            fileContentStateRef?.current &&
            !fileContentStateRef.current.isBinary &&
            !isCsvTableFile(filePath)
          ) {
            // Active text tab - we have the content loaded, can offer Save
            const { message } = await import("@tauri-apps/plugin-dialog");
            const result = await message(
              `Do you want to save the changes you made to "${tabToClose.title}"?`,
              {
                title: "Unsaved Changes",
                kind: "warning",
                buttons: {
                  yes: "Save",
                  no: "Don't Save",
                  cancel: "Cancel",
                },
              }
            );

            // Result is the button LABEL (e.g., "Save", "Don't Save", "Cancel")
            if (result === "Save") {
              // User clicked "Save" - save the file then close.
              // Re-read after the dialog await so we persist the latest buffer.
              const contentState = fileContentStateRef.current;
              if (!contentState) {
                log.error("[closeTab] File content unavailable; not closing");
                return; // Same policy as a failed save: keep the tab open
              }
              if (filePath) {
                try {
                  const contentToSave = contentState.content ?? "";
                  await writeTextFile(filePath, contentToSave);
                  contentState.markSaved();
                  invalidateFileCache(filePath);
                  forceRefreshRef?.current();

                  // Dispatch event for Filesync channel logging
                  window.dispatchEvent(
                    new CustomEvent("filesync:file-saved", {
                      detail: { path: filePath },
                    })
                  );
                } catch (err) {
                  log.error("[closeTab] Save failed:", err);
                  return; // Don't close if save failed
                }
              }
              // Continue to close the tab
            } else if (result === "Don't Save") {
              // User clicked "Don't Save" - discard changes and close
              fileContentStateRef.current?.discardChanges();
              window.dispatchEvent(
                new CustomEvent("filesync:file-discarded", {
                  detail: { path: filePath },
                })
              );
              // Continue to close the tab
            } else {
              // User clicked "Cancel" or closed dialog - don't close
              return;
            }
          } else {
            // Non-active tab - can't save, only discard or cancel
            const confirmed = await askNativeDialogSafely(
              t("confirmation.unsavedCloseMessage", {
                name: tabToClose.title,
              }),
              {
                title: t("confirmation.unsavedCloseTitle"),
                kind: "warning",
                okLabel: t("actions.discard"),
                cancelLabel: t("actions.cancel"),
              }
            );

            if (!confirmed) {
              return; // User cancelled
            }
            window.dispatchEvent(
              new CustomEvent("filesync:file-discarded", {
                detail: { path: filePath },
              })
            );
            // Continue to close the tab (discarding changes)
          }
        }

        // Close the tab
        updatePaneStateFn((state: PanelState) => {
          const innerTabs = state?.tabs ?? [];
          const closedIndex = innerTabs.findIndex((tab) => tab.id === tabId);
          if (closedIndex === -1)
            return state ?? { tabs: [], activeTabId: null };
          const newTabs = innerTabs.filter((tab) => tab.id !== tabId);
          let newActiveTabId = state?.activeTabId ?? null;
          if (state?.activeTabId === tabId) {
            if (newTabs.length === 0) {
              newActiveTabId = null;
            } else {
              const newActiveIndex = Math.min(closedIndex, newTabs.length - 1);
              newActiveTabId = newTabs[newActiveIndex]?.id ?? null;
            }
          }
          return { tabs: newTabs, activeTabId: newActiveTabId };
        });
      } catch (err) {
        log.error("[closeTab] Error:", err);
      }
    },
    [updatePaneStateFn, fileContentStateRef, forceRefreshRef, t]
  );

  const reorderTabs = useCallback(
    (startIndex: number, endIndex: number) => {
      updatePaneStateFn((state: PanelState) => {
        const stateTabs = state?.tabs ?? [];
        const newTabs = [...stateTabs];
        const [movedTab] = newTabs.splice(startIndex, 1);
        newTabs.splice(endIndex, 0, movedTab);
        return { tabs: newTabs, activeTabId: state?.activeTabId ?? null };
      });
    },
    [updatePaneStateFn]
  );

  // PERFORMANCE: closeOtherTabs uses ref to access current state
  const closeOtherTabs = useCallback(
    async (tabId: string) => {
      // Get current state from ref (always fresh, no stale closure)
      const state = currentStateRef.current;
      const stateTabs = state?.tabs ?? [];

      const targetTab = stateTabs.find((tab) => tab.id === tabId);
      if (!targetTab) return;

      // Check if any other tabs have unsaved changes
      const otherTabsWithUnsaved = stateTabs.filter(
        (tab) => tab.id !== tabId && tab.hasUnsavedChanges
      );

      if (otherTabsWithUnsaved.length > 0) {
        const confirmed = await askNativeDialogSafely(
          t("confirmation.unsavedCloseMultipleMessage", {
            count: otherTabsWithUnsaved.length,
          }),
          {
            title: t("confirmation.unsavedCloseTitle"),
            kind: "warning",
            okLabel: t("actions.confirm"),
            cancelLabel: t("actions.cancel"),
          }
        );

        if (!confirmed) {
          return; // User cancelled
        }
      }

      updatePaneStateFn((state: PanelState) => {
        const innerTabs = state?.tabs ?? [];
        const tab = innerTabs.find((stateTab) => stateTab.id === tabId);
        if (!tab) return state ?? { tabs: [], activeTabId: null };
        return { tabs: [tab], activeTabId: tabId };
      });
    },
    [updatePaneStateFn, t]
  );

  const closeSavedTabs = useCallback(() => {
    updatePaneStateFn((state: PanelState) => {
      // Keep tabs that have unsaved changes
      const stateTabs = state?.tabs ?? [];
      const tabsToKeep = stateTabs.filter((tab) => tab.hasUnsavedChanges);
      const newActiveTabId =
        tabsToKeep.find((tab) => tab.id === state?.activeTabId)?.id ||
        tabsToKeep[0]?.id ||
        null;
      return { tabs: tabsToKeep, activeTabId: newActiveTabId };
    });
  }, [updatePaneStateFn]);

  return {
    tabs,
    activeTabId,
    activeTab,
    currentState,
    switchToTab,
    closeTab,
    reorderTabs,
    closeOtherTabs,
    closeSavedTabs,
    updatePaneState: updatePaneStateFn,
  };
}

export default useEditorPaneState;
