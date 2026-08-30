/**
 * Host-desktop window and page corner radii.
 *
 * macOS uses the standard desktop window curve; native vibrancy is clipped by AppKit.
 * Windows uses smaller radii to align with DWM / Win11 window chrome.
 *
 * Keep magic numbers in sync with the preflight script in public/index.html.
 */
import { isLinux, isMacOS, isWindows } from "@src/util/platform/tauri";
import { isMainAppWindow } from "@src/util/platform/tauri/windowIdentity";

export const HOST_DESKTOP = {
  MACOS: "macos",
  WINDOWS: "windows",
  LINUX: "linux",
} as const;

export type HostDesktop = (typeof HOST_DESKTOP)[keyof typeof HOST_DESKTOP];

const CHROME_RADIUS_PX: Record<
  HostDesktop,
  { windowPx: number; pagePx: number }
> = {
  [HOST_DESKTOP.MACOS]: { windowPx: 10, pagePx: 20 },
  [HOST_DESKTOP.WINDOWS]: { windowPx: 8, pagePx: 12 },
  [HOST_DESKTOP.LINUX]: { windowPx: 12, pagePx: 12 },
};

export function resolveHostDesktop(): HostDesktop {
  if (isWindows()) {
    return HOST_DESKTOP.WINDOWS;
  }
  if (isLinux()) {
    return HOST_DESKTOP.LINUX;
  }
  if (isMacOS()) {
    return HOST_DESKTOP.MACOS;
  }
  return HOST_DESKTOP.MACOS;
}

/**
 * Sets --border-radius-window and --radius-page on the document root so html/body/#root,
 * splash, rounded-page, and ModalSystem track the host OS.
 */
export function applyHostDesktopWindowChromeRadius(): void {
  if (typeof document === "undefined") {
    return;
  }
  const host = resolveHostDesktop();
  const { windowPx, pagePx } = CHROME_RADIUS_PX[host];
  const html = document.documentElement;
  html.dataset.hostDesktop = host;
  const windowVal = `${windowPx}px`;
  const pageVal = `${pagePx}px`;
  html.style.setProperty("--border-radius-window", windowVal);
  html.style.setProperty("--radius-page", pageVal);
  if (document.body) {
    document.body.style.setProperty("--border-radius-window", windowVal);
    document.body.style.setProperty("--radius-page", pageVal);
  }
}

/**
 * Mirrors the Rust-side Windows chrome policy as
 * `<html data-windows-chrome="acrylic">` so index.scss can relax the opaque
 * Windows fail-safe background when a translucent native backdrop (Win11
 * acrylic) actually exists behind the webview. Until this resolves — and on
 * Windows 10, where acrylic is disabled — the attribute stays absent and the
 * opaque fallback applies. Requires initializeTauriAPIs() to have completed.
 *
 * Main window only: the Rust policy is a statement about the MAIN frameless
 * window. Secondary windows (detached sessions) are decorated with no acrylic
 * backdrop behind the webview — relaxing their opaque fail-safe would render
 * them see-through on Win11.
 */
export async function applyWindowsNativeChromeAttribute(): Promise<void> {
  if (typeof document === "undefined") {
    return;
  }
  if (resolveHostDesktop() !== HOST_DESKTOP.WINDOWS) {
    return;
  }
  if (!isMainAppWindow()) {
    return;
  }
  try {
    const { invokeTauri } = await import("@src/util/platform/tauri/init");
    const acrylic = await invokeTauri<boolean>("main_window_chrome_is_acrylic");
    if (acrylic) {
      document.documentElement.dataset.windowsChrome = "acrylic";
    }
  } catch {
    // Keep the opaque fail-safe background if the policy can't be read.
  }
}
