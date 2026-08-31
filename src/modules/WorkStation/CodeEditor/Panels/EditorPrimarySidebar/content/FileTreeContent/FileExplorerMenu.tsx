/**
 * WorkStation FileExplorerContextMenu Component
 *
 * Native OS context menu for file explorer using Tauri v2 Menu API.
 * Provides file operations like new file, new folder, rename, delete, copy, paste.
 *
 * Uses dispatch() for actions per GUI Action System guidelines.
 */
import i18next from "i18next";
import { useEffect, useRef } from "react";

import type { TreePanelNode } from "@src/components/TreePanelSidebar/types";
import { createLogger } from "@src/hooks/logger";
import { fileClipboardAtom } from "@src/store/workstation/codeEditor/file";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { copyText } from "@src/util/data/clipboard";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";
import { getFileManagerRevealLabelKey } from "@src/util/platform/fileManagerLabels";
import {
  type NativeMenuItemOptions,
  popupNativeMenu,
} from "@src/util/platform/tauri/nativeMenuPopup";

import type { DispatchFn } from "./types";

const logger = createLogger("FileExplorerMenu");

export interface FileExplorerContextMenuProps {
  /** The node that was right-clicked (null for background click) */
  node: TreePanelNode | null;
  /** Repository path for relative path calculation */
  repoPath: string;
  /** Callback when menu is closed */
  onClose: () => void;
  /** Callback to enter rename mode for a node */
  onStartRename?: (path: string) => void;
  /** Callback to start creating a new file/folder (VS Code inline pattern) */
  onStartCreateNew?: (parentDir: string, isFolder: boolean) => void;
  /** Dispatch function for GUI actions */
  dispatch: DispatchFn;
}

function getTargetDirectory(
  node: TreePanelNode | null,
  repoPath: string
): string {
  if (!node) return repoPath;
  if (node.type === "directory") return node.path;
  return node.path.substring(0, node.path.lastIndexOf("/")) || repoPath;
}

function copyToClipboard(text: string): void {
  copyText(text).catch((error: unknown) => {
    logger.error("Failed to copy to clipboard:", error);
  });
}

function getRelativePath(absolutePath: string, repoPath: string): string {
  if (!absolutePath || !repoPath) return absolutePath;
  const normalizedRepo = repoPath.replace(/\/$/, "");
  const normalizedPath = absolutePath.replace(/\/$/, "");
  if (normalizedPath.startsWith(normalizedRepo)) {
    const relative = normalizedPath.slice(normalizedRepo.length);
    return relative.startsWith("/") ? relative.slice(1) : relative;
  }
  return absolutePath;
}

const contextMenuRef: { current: FileExplorerContextMenuProps | null } = {
  current: null,
};

export function FileExplorerContextMenu(props: FileExplorerContextMenuProps) {
  const { node, repoPath, onClose, dispatch } = props;
  const hasShownMenu = useRef(false);

  useEffect(() => {
    contextMenuRef.current = props;
    return () => {
      contextMenuRef.current = null;
    };
  }, [props]);

  useEffect(() => {
    if (hasShownMenu.current) return;
    hasShownMenu.current = true;

    async function showNativeMenu(): Promise<void> {
      try {
        const result = await popupNativeMenu({
          source: "file-explorer",
          onBusy: onClose,
          buildItems: () => {
            const items: NativeMenuItemOptions[] = [];
            const translate = i18next.t.bind(i18next);
            items.push(
              {
                text: translate("actions.newFile", {
                  defaultValue: "New File",
                }),
                accelerator: "CmdOrCtrl+N",
                action: () => {
                  if (contextMenuRef.current) {
                    const targetDirectory = getTargetDirectory(
                      contextMenuRef.current.node,
                      contextMenuRef.current.repoPath
                    );
                    const closeMenu = contextMenuRef.current.onClose;
                    const startCreateNew =
                      contextMenuRef.current.onStartCreateNew;
                    closeMenu();
                    if (startCreateNew) {
                      requestAnimationFrame(() =>
                        startCreateNew(targetDirectory, false)
                      );
                    }
                  }
                },
              },
              {
                text: translate("actions.newFolder", {
                  defaultValue: "New Folder",
                }),
                accelerator: "CmdOrCtrl+Shift+N",
                action: () => {
                  if (contextMenuRef.current) {
                    const targetDirectory = getTargetDirectory(
                      contextMenuRef.current.node,
                      contextMenuRef.current.repoPath
                    );
                    const closeMenu = contextMenuRef.current.onClose;
                    const startCreateNew =
                      contextMenuRef.current.onStartCreateNew;
                    closeMenu();
                    if (startCreateNew) {
                      requestAnimationFrame(() =>
                        startCreateNew(targetDirectory, true)
                      );
                    }
                  }
                },
              }
            );

            const store = getInstrumentedStore();
            const clipboard = store.get(fileClipboardAtom);
            const hasPasteItems = Boolean(
              clipboard && clipboard.paths.length > 0
            );

            if (node) {
              items.push(
                { item: "Separator" },
                {
                  text: translate("actions.rename", { defaultValue: "Rename" }),
                  accelerator: "Enter",
                  action: () => {
                    if (contextMenuRef.current?.node) {
                      contextMenuRef.current.onStartRename?.(
                        contextMenuRef.current.node.path
                      );
                      contextMenuRef.current.onClose();
                    }
                  },
                },
                {
                  text: translate("actions.delete", { defaultValue: "Delete" }),
                  accelerator: "CmdOrCtrl+Backspace",
                  action: async () => {
                    if (contextMenuRef.current?.node) {
                      const nodePath = contextMenuRef.current.node.path;
                      const nodeName = contextMenuRef.current.node.name;
                      const closeMenu = contextMenuRef.current.onClose;
                      const dispatchAction = contextMenuRef.current.dispatch;
                      closeMenu();
                      const confirmed = await confirmDestructiveAction({
                        title: translate("actions.confirmDelete", {
                          defaultValue: "Confirm Delete",
                        }),
                        message: `${translate("actions.delete", {
                          defaultValue: "Delete",
                        })} "${nodeName}"?`,
                        okLabel: translate("actions.delete", {
                          defaultValue: "Delete",
                        }),
                      });
                      if (confirmed) {
                        await dispatchAction(
                          "file.delete",
                          { path: nodePath },
                          "user"
                        );
                      }
                    }
                  },
                },
                {
                  text: translate("actions.duplicate", {
                    defaultValue: "Duplicate",
                  }),
                  accelerator: "CmdOrCtrl+D",
                  action: () => {
                    if (contextMenuRef.current?.node) {
                      contextMenuRef.current.dispatch(
                        "file.duplicate",
                        { path: contextMenuRef.current.node.path },
                        "user"
                      );
                      contextMenuRef.current.onClose();
                    }
                  },
                },
                { item: "Separator" },
                {
                  text: translate("actions.copy", { defaultValue: "Copy" }),
                  accelerator: "CmdOrCtrl+C",
                  action: () => {
                    if (contextMenuRef.current?.node) {
                      contextMenuRef.current.dispatch(
                        "file.copy",
                        { paths: [contextMenuRef.current.node.path] },
                        "user"
                      );
                      contextMenuRef.current.onClose();
                    }
                  },
                },
                {
                  text: translate("actions.paste", { defaultValue: "Paste" }),
                  accelerator: "CmdOrCtrl+V",
                  enabled: hasPasteItems ?? false,
                  action: () => {
                    if (contextMenuRef.current?.node) {
                      const targetDirectory = getTargetDirectory(
                        contextMenuRef.current.node,
                        contextMenuRef.current.repoPath
                      );
                      contextMenuRef.current.dispatch(
                        "file.paste",
                        { targetDir: targetDirectory },
                        "user"
                      );
                      contextMenuRef.current.onClose();
                    }
                  },
                },
                { item: "Separator" },
                {
                  text: translate("actions.copyPath", {
                    defaultValue: "Copy Path",
                  }),
                  action: () => {
                    if (contextMenuRef.current?.node) {
                      copyToClipboard(contextMenuRef.current.node.path);
                      contextMenuRef.current.onClose();
                    }
                  },
                },
                {
                  text: translate("actions.copyRelativePath", {
                    defaultValue: "Copy Relative Path",
                  }),
                  action: () => {
                    if (contextMenuRef.current?.node) {
                      const relativePath = getRelativePath(
                        contextMenuRef.current.node.path,
                        contextMenuRef.current.repoPath
                      );
                      copyToClipboard(relativePath);
                      contextMenuRef.current.onClose();
                    }
                  },
                },
                { item: "Separator" },
                {
                  text: translate(getFileManagerRevealLabelKey()),
                  action: () => {
                    if (contextMenuRef.current?.node) {
                      contextMenuRef.current.dispatch(
                        "file.revealInFinder",
                        { path: contextMenuRef.current.node.path },
                        "user"
                      );
                      contextMenuRef.current.onClose();
                    }
                  },
                }
              );
            } else {
              if (hasPasteItems) {
                items.push(
                  { item: "Separator" },
                  {
                    text: translate("actions.paste", { defaultValue: "Paste" }),
                    accelerator: "CmdOrCtrl+V",
                    action: () => {
                      if (contextMenuRef.current) {
                        contextMenuRef.current.dispatch(
                          "file.paste",
                          { targetDir: contextMenuRef.current.repoPath },
                          "user"
                        );
                        contextMenuRef.current.onClose();
                      }
                    },
                  }
                );
              }
              items.push(
                { item: "Separator" },
                {
                  text: translate("actions.refresh", {
                    defaultValue: "Refresh",
                  }),
                  action: () => {
                    if (contextMenuRef.current) {
                      contextMenuRef.current.dispatch(
                        "file.refresh",
                        {},
                        "user"
                      );
                      contextMenuRef.current.onClose();
                    }
                  },
                }
              );
            }

            return items;
          },
        });
        if (result.status !== "busy") {
          setTimeout(() => {
            onClose();
          }, 50);
        }
      } catch (error: unknown) {
        logger.error(
          "[FileExplorerContextMenu] Failed to show native context menu:",
          error
        );
        onClose();
      }
    }

    void showNativeMenu();
  }, [node, repoPath, dispatch, onClose]);

  return null;
}

export default FileExplorerContextMenu;
