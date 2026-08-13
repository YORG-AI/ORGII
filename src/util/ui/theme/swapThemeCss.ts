/**
 * Swap the theme CSS by creating a new <link>, waiting for it to load,
 * then removing the old one.
 *
 * Changing link.href in-place causes a race condition in Tauri's WebView:
 * the old stylesheet can be partially dropped before the new one finishes
 * loading, creating a mixed light/dark state. This utility avoids that
 * by keeping the old CSS active until the new one is fully loaded.
 */
import { isWindows } from "@src/util/platform/tauri";

const THEME_LINK_ATTR = "data-orgii-theme";
const PRELOAD_LINK_ATTR = "data-orgii-theme-preload";
const SWAP_TIMEOUT_MS = 4000;

let latestRequestedCssPath = "";

function isActiveThemeDark(cssPath: string): boolean {
  const background = getComputedStyle(document.body)
    .getPropertyValue("--color-bg-2")
    .trim();
  const hexMatch = /^#([\da-f]{6})$/i.exec(background);

  if (hexMatch) {
    const value = hexMatch[1];
    const red = Number.parseInt(value.slice(0, 2), 16);
    const green = Number.parseInt(value.slice(2, 4), 16);
    const blue = Number.parseInt(value.slice(4, 6), 16);
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    return luminance < 0.5;
  }

  return (
    cssPath.endsWith("/orgii_high_contrast.css") ||
    cssPath.endsWith("/orgii_dark.css")
  );
}

/** Keep CSS chrome and the Windows system backdrop on the same color scheme. */
export function syncThemeAppearance(cssPath: string): void {
  const isHighContrast = cssPath.endsWith("/orgii_high_contrast.css");
  const isDark = isActiveThemeDark(cssPath);
  const colorScheme = isDark ? "dark" : "light";
  const root = document.documentElement;

  root.dataset.theme = colorScheme;
  root.dataset.themeId = isHighContrast
    ? "orgii-high-contrast"
    : isDark
      ? "github-dark"
      : "github-light";
  root.style.colorScheme = colorScheme;

  if (!isWindows()) return;

  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(colorScheme))
    .catch(() => {
      // Browser previews and windows closing during a theme swap have no
      // native backdrop to synchronize.
    });
}

/**
 * Warm the browser's stylesheet cache for the given theme CSS files so a
 * subsequent `swapThemeCss(...)` finishes parsing on the same frame as the
 * JS atom flip — avoiding a 1–2 frame lag where Tailwind/CSS-variable
 * surfaces visibly trail JS-driven surfaces (background, glass, etc.)
 * during a theme switch.
 *
 * Implemented as `<link rel="preload" as="style">` so the browser fetches,
 * parses, and keeps the CSS in cache *without* applying it. The actual
 * activation still happens via `swapThemeCss`, which moves the bytes from
 * the preload cache to a live stylesheet effectively for free.
 *
 * Idempotent: skips paths that already have a preload tag.
 */
export function preloadThemeCss(paths: readonly string[]): void {
  const head = document.querySelector("head");
  if (!head) return;

  for (const path of paths) {
    const existing = head.querySelector<HTMLLinkElement>(
      `link[${PRELOAD_LINK_ATTR}][href$="${cssPathSelector(path)}"]`
    );
    if (existing) continue;

    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "style";
    link.href = path;
    link.setAttribute(PRELOAD_LINK_ATTR, "");
    head.appendChild(link);
  }
}

function cssPathSelector(path: string): string {
  return path.replace(/"/g, '\\"');
}

/**
 * WKWebView pauses `requestAnimationFrame` while the window is occluded or
 * the display is asleep, and can leave it dead after system sleep until the
 * next repaint. Waiting on frames must therefore never be unbounded: the
 * timer keeps the swap moving when frames don't come (nobody is looking at
 * the intermediate paint state in that case anyway).
 */
const PAINT_FALLBACK_MS = 250;

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timerId);
      resolve();
    };
    const timerId = setTimeout(finish, PAINT_FALLBACK_MS);
    requestAnimationFrame(() => {
      requestAnimationFrame(finish);
    });
  });
}

export function swapThemeCss(newCssPath: string): Promise<void> {
  latestRequestedCssPath = newCssPath;

  const head = document.querySelector("head");
  if (!head) return Promise.resolve();

  const existingLink = head.querySelector<HTMLLinkElement>(
    `link[${THEME_LINK_ATTR}]`
  );

  if (!existingLink) {
    const legacyLinks = Array.from(
      head.querySelectorAll<HTMLLinkElement>("link")
    ).filter((link) => link.href.includes("orgii"));

    if (legacyLinks.length > 0) {
      legacyLinks[0].setAttribute(THEME_LINK_ATTR, "");
      const swapPromise = swapFromExisting(head, legacyLinks[0], newCssPath);
      legacyLinks.slice(1).forEach((link) => link.remove());
      return swapPromise;
    }

    return insertFreshLink(head, newCssPath);
  }

  if (existingLink.href.endsWith(newCssPath)) {
    removeOtherThemeLinks(existingLink);
    syncThemeAppearance(newCssPath);
    return Promise.resolve();
  }

  return swapFromExisting(head, existingLink, newCssPath);
}

function removeOtherThemeLinks(activeLink: HTMLLinkElement): void {
  document
    .querySelectorAll<HTMLLinkElement>(`link[${THEME_LINK_ATTR}]`)
    .forEach((link) => {
      if (link !== activeLink) {
        link.remove();
      }
    });
}

function swapFromExisting(
  head: HTMLHeadElement,
  oldLink: HTMLLinkElement,
  newCssPath: string
): Promise<void> {
  return new Promise((resolve) => {
    const newLink = document.createElement("link");
    newLink.rel = "stylesheet";
    newLink.type = "text/css";
    newLink.href = newCssPath;
    newLink.setAttribute(THEME_LINK_ATTR, "");

    let settled = false;

    const cleanupListeners = () => {
      newLink.onload = null;
      newLink.onerror = null;
    };

    const finishWithoutPromoting = () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      clearTimeout(timeoutId);
      newLink.remove();
      resolve();
    };

    const promoteLoadedLink = async () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      clearTimeout(timeoutId);

      if (latestRequestedCssPath !== newCssPath) {
        newLink.remove();
        resolve();
        return;
      }

      await nextPaint();
      oldLink.remove();
      removeOtherThemeLinks(newLink);
      syncThemeAppearance(newCssPath);
      resolve();
    };

    const timeoutId = setTimeout(finishWithoutPromoting, SWAP_TIMEOUT_MS);
    newLink.onload = () => {
      void promoteLoadedLink();
    };
    newLink.onerror = finishWithoutPromoting;

    head.insertBefore(newLink, oldLink.nextSibling);
  });
}

function insertFreshLink(
  head: HTMLHeadElement,
  cssPath: string
): Promise<void> {
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = cssPath;
    link.setAttribute(THEME_LINK_ATTR, "");

    let settled = false;

    const cleanupListeners = () => {
      link.onload = null;
      link.onerror = null;
    };

    const settle = async () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      clearTimeout(timeoutId);

      if (latestRequestedCssPath !== cssPath) {
        link.remove();
      } else {
        await nextPaint();
        removeOtherThemeLinks(link);
        syncThemeAppearance(cssPath);
      }

      resolve();
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      clearTimeout(timeoutId);
      link.remove();
      resolve();
    };

    const timeoutId = setTimeout(cancel, SWAP_TIMEOUT_MS);
    link.onload = () => {
      void settle();
    };
    link.onerror = cancel;

    head.insertBefore(link, head.firstChild);
  });
}
