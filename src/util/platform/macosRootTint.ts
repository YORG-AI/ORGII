/**
 * Mirror the app's translucent root surface into a native layer on macOS.
 *
 * On macOS the window is transparent and Rust mounts vibrancy material behind
 * the webview; `html[data-host-desktop="macos"]` in `src/index.scss` then
 * paints `html`, `body` and `#root` as translucent tints of `--color-bg-2`
 * over that material. Those three tints stack, and every "transparent"
 * surface in the app (the navigation sidebar, empty panes) actually sits on
 * their composite.
 *
 * When the window grows, AppKit resizes the window and the webview's view in
 * the same frame, but the page's pixels are produced by WebKit's WebContent
 * process and land one or more frames later. The strip the page has not yet
 * painted shows whatever is behind the webview: with the tint in CSS, raw
 * material — a visibly lighter band at the trailing edge of the drag.
 *
 * `syncMacosRootTint` composites the three CSS tints, hands the result to
 * `set_window_root_tint` (a native layer between the material and the
 * webview), and then flips `<html data-native-root-tint>` so the CSS tints
 * go transparent. The page composites onto exactly the surface it painted
 * before, the sidebar included, and the resize strip now shows that same
 * surface instead of bare material.
 *
 * Only the sRGB colour math lives here; nothing about it is Tauri-specific.
 */
import { isMacOS } from "@src/util/platform/tauri";

export const NATIVE_ROOT_TINT_ATTRIBUTE = "nativeRootTint";

/** Straight-alpha sRGB colour with components in `0..=1`. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function parseChannel(token: string, scale: number): number | null {
  const trimmed = token.trim();
  if (trimmed === "none") return 0;
  if (trimmed.endsWith("%")) {
    const percent = Number.parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(percent) ? clamp01(percent / 100) : null;
  }
  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) ? clamp01(value / scale) : null;
}

function parseAlpha(token: string | undefined): number | null {
  if (token === undefined) return 1;
  return parseChannel(token, 1);
}

/**
 * Parse the serialisations WebKit uses for a computed `background-color`:
 * `rgb()` / `rgba()` with commas or spaces, `color(srgb r g b / a)`, and the
 * `transparent` keyword. Anything else (an image, `currentcolor`, a colour
 * space we cannot composite in) returns `null`.
 */
export function parseCssColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();
  if (text === "transparent") return TRANSPARENT;

  const match = /^(rgba?|color)\((.*)\)$/.exec(text);
  if (!match) return null;
  const [, fn, body] = match;

  let channels: string[];
  let alphaToken: string | undefined;
  if (fn === "color") {
    const [space, ...rest] = body.trim().split(/\s+/);
    if (space !== "srgb") return null;
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      channels = rest.slice(0, slash);
      alphaToken = rest[slash + 1];
    } else {
      channels = rest;
    }
    if (channels.length !== 3) return null;
    const [r, g, b] = channels.map((token) => parseChannel(token, 1));
    const a = parseAlpha(alphaToken);
    if (r === null || g === null || b === null || a === null) return null;
    return { r, g, b, a };
  }

  if (body.includes(",")) {
    const parts = body.split(",").map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 4) return null;
    channels = parts.slice(0, 3);
    alphaToken = parts[3];
  } else {
    const [lhs, rhs] = body.split("/");
    channels = lhs.trim().split(/\s+/);
    alphaToken = rhs?.trim();
    if (channels.length !== 3) return null;
  }
  const [r, g, b] = channels.map((token) => parseChannel(token, 255));
  const a = parseAlpha(alphaToken);
  if (r === null || g === null || b === null || a === null) return null;
  return { r, g, b, a };
}

/**
 * Source-over composite of `layers`, bottom first. The result is the single
 * straight-alpha colour that paints the same as the stack.
 */
export function compositeSrcOver(layers: readonly Rgba[]): Rgba {
  return layers.reduce<Rgba>((below, above) => {
    const a = above.a + below.a * (1 - above.a);
    if (a === 0) return TRANSPARENT;
    const blend = (top: number, bottom: number): number =>
      (top * above.a + bottom * below.a * (1 - above.a)) / a;
    return {
      r: blend(above.r, below.r),
      g: blend(above.g, below.g),
      b: blend(above.b, below.b),
      a,
    };
  }, TRANSPARENT);
}

/**
 * The root surfaces the page paints on macOS, bottom first. `#root` is
 * optional so the pre-mount splash can still be measured.
 */
function rootSurfaces(): HTMLElement[] {
  const surfaces: HTMLElement[] = [document.documentElement];
  if (document.body) surfaces.push(document.body);
  const root = document.getElementById("root");
  if (root) surfaces.push(root);
  return surfaces;
}

/**
 * Read the composite of the CSS root tints as they would paint *without* the
 * native layer. The attribute that zeroes the CSS tints is lifted for the
 * duration of the read so a second sync (theme swap, skin change) measures
 * the stylesheet, not the transparent override.
 */
export function measureCssRootTint(): Rgba | null {
  const html = document.documentElement;
  const previous = html.dataset[NATIVE_ROOT_TINT_ATTRIBUTE];
  if (previous !== undefined) delete html.dataset[NATIVE_ROOT_TINT_ATTRIBUTE];
  try {
    const layers: Rgba[] = [];
    for (const surface of rootSurfaces()) {
      const style = getComputedStyle(surface);
      if (style.backgroundImage && style.backgroundImage !== "none") {
        return null;
      }
      const color = parseCssColor(style.backgroundColor);
      if (!color) return null;
      layers.push(color);
    }
    return compositeSrcOver(layers);
  } finally {
    if (previous !== undefined)
      html.dataset[NATIVE_ROOT_TINT_ATTRIBUTE] = previous;
  }
}

let pending: Promise<void> | null = null;
let rerunRequested = false;

async function pushRootTint(): Promise<void> {
  const html = document.documentElement;
  const tint = measureCssRootTint();
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_window_root_tint", {
    color: tint ? [tint.r, tint.g, tint.b, tint.a] : null,
  });
  if (tint) {
    html.dataset[NATIVE_ROOT_TINT_ATTRIBUTE] = "1";
  } else {
    delete html.dataset[NATIVE_ROOT_TINT_ATTRIBUTE];
  }
}

/**
 * Push the current CSS root tint to the native layer for this window.
 *
 * Idempotent and coalescing: a call that arrives while a push is in flight
 * schedules exactly one follow-up so the native layer always ends on the
 * latest stylesheet. Never throws — a browser preview or a window mid-close
 * simply keeps its CSS tint.
 */
export function syncMacosRootTint(): Promise<void> {
  if (typeof document === "undefined" || !isMacOS()) {
    return Promise.resolve();
  }
  if (pending) {
    rerunRequested = true;
    return pending;
  }
  pending = (async () => {
    try {
      do {
        rerunRequested = false;
        await pushRootTint();
      } while (rerunRequested);
    } catch {
      // Non-Tauri environment or the window is gone; the CSS tint stays.
    } finally {
      pending = null;
    }
  })();
  return pending;
}
