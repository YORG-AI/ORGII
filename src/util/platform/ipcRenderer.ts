/**
 * Tauri Window & Shell APIs
 *
 * Provides window controls and external link/file opening via Tauri.
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openPath } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-shell";

import { isTauriDesktop } from "@src/util/platform/tauri";

let currentWindow: WebviewWindow | null = null;
if (isTauriDesktop()) {
  currentWindow = WebviewWindow.getCurrent();
}

export const showInFinder = async (filePath: string): Promise<void> => {
  await openPath(filePath);
};

export const viewOnGitHub = async (repoUrl: string): Promise<void> => {
  await open(repoUrl);
};

export const openInExternalEditor = async (filePath: string): Promise<void> => {
  await open(filePath);
};

export const closeWindow = async (): Promise<void> => {
  if (currentWindow) {
    await currentWindow.close();
  }
};

/** Hand the current pointer-drag to the OS window manager. */
export const startWindowDrag = async (): Promise<void> => {
  if (currentWindow) {
    await currentWindow.startDragging();
  }
};

export const minWindow = async (): Promise<void> => {
  if (currentWindow) {
    await currentWindow.minimize();
  }
};

export const maxWindow = async (): Promise<void> => {
  if (currentWindow) {
    if (await currentWindow.isMaximized()) {
      await currentWindow.unmaximize();
    } else {
      await currentWindow.maximize();
    }
  }
};

export const openExternalLink = async (url: string): Promise<void> => {
  await open(url);
};
