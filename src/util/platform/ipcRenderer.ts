/**
 * Tauri Window & Shell APIs
 *
 * Provides window controls and external link/file opening via Tauri.
 */
import { invoke } from "@tauri-apps/api/core";
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

function parseRgb(colorStr: string): [number, number, number] | null {
  const match = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Read the solid background color from the rendered BackgroundLayer.
 * Only returns a value when the background is a solid color (not an image).
 */
function getThemeBgColor(): [number, number, number] | null {
  const layer = document.querySelector(
    "[data-background-layer]"
  ) as HTMLElement | null;
  if (!layer) return null;

  const style = getComputedStyle(layer);
  if (style.backgroundImage !== "none") return null;

  const bgColor = style.backgroundColor;
  if (bgColor && bgColor !== "transparent" && bgColor !== "rgba(0, 0, 0, 0)") {
    return parseRgb(bgColor);
  }

  return null;
}

/**
 * Fetch the current wallpaper image from the BackgroundLayer element
 * and return it as a base64 string (without the data URL prefix).
 */
async function getBackgroundImageBase64(): Promise<string | null> {
  const layer = document.querySelector(
    "[data-background-layer]"
  ) as HTMLElement | null;
  if (!layer) return null;

  const bgImage = getComputedStyle(layer).backgroundImage;
  if (!bgImage || bgImage === "none") return null;

  const urlMatch = bgImage.match(/url\(["']?(.+?)["']?\)/);
  if (!urlMatch) return null;

  try {
    const response = await fetch(urlMatch[1]);
    const blob = await response.blob();
    return new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const commaIdx = dataUrl.indexOf(",");
        resolve(commaIdx >= 0 ? dataUrl.substring(commaIdx + 1) : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export const setWindowVibrancy = async (enabled: boolean): Promise<void> => {
  try {
    let bgColor: [number, number, number] | null = null;
    let bgImageBase64: string | null = null;

    if (!enabled) {
      bgImageBase64 = await getBackgroundImageBase64();
      if (!bgImageBase64) {
        bgColor = getThemeBgColor();
      }
    }

    await invoke("set_window_vibrancy", { enabled, bgColor, bgImageBase64 });
  } catch {
    // Not available or failed — continue silently
  }
};
