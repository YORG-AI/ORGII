/**
 * Applies the active skin, accent, and icon treatment to the document.
 *
 * Everything is written as inline custom properties on `<body>` rather than as
 * a stylesheet swap. That keeps the base stylesheets authoritative for anything
 * a skin does not name, and makes a skin change a single synchronous style
 * write instead of a network round-trip.
 *
 * Precedence, lowest to highest:
 *   1. the base stylesheet for the variant (`orgii_main.css` / `orgii_dark.css`)
 *   2. the active skin's derived tokens — skipped entirely for baseline skins
 *   3. the accent palette, when the user picked a named preset over `matchSkin`
 *
 * Call once, at the app root.
 */
import { useAtomValue } from "jotai";
import { useEffect } from "react";

import { resolveAppliedSkinTokens } from "@src/config/appearance/skins/appliedTokens";
import { deriveSkinTokens } from "@src/config/appearance/skins/deriveSkinTokens";
import {
  getSkinSeed,
  isBaselineSkin,
} from "@src/config/appearance/skins/registry";
import type { SkinVariant } from "@src/config/appearance/skins/types";
import {
  activeSkinIdAtom,
  darkAccentPresetAtom,
  darkSkinIdAtom,
  iconStyleAtom,
  lightAccentPresetAtom,
  lightSkinIdAtom,
  primaryColorPresetAtom,
  skinVariantAtom,
  translucentSidebarAtom,
} from "@src/store/ui/uiAtom";
import {
  clearSkinTokens,
  writeSkinSelection,
  writeSkinTokens,
} from "@src/util/ui/theme/applySkinTokens";

/**
 * Read by the splash bootstrap in `public/index.html` before any bundle loads,
 * so a cold start opens on the active skin's surface instead of ORGII's.
 */
const SKIN_SURFACE_STORAGE_KEY = "orgii_skin_surface";

interface SplashSurface {
  bg: string;
  fg: string;
  panelBg: string;
  panelBorder: string;
}

function splashSurfaceFor(
  skinId: string,
  variant: SkinVariant
): SplashSurface | null {
  // Baseline skins are exactly what the splash already hard-codes.
  if (isBaselineSkin(skinId)) return null;
  const seed = getSkinSeed(skinId, variant);
  const tokens = deriveSkinTokens(seed, variant);
  return {
    bg: seed.surface,
    fg: seed.ink,
    panelBg: tokens["--color-fill-1"] ?? seed.surface,
    panelBorder: tokens["--color-border-1"] ?? seed.surface,
  };
}

export function useAppSkin(): void {
  const variant = useAtomValue(skinVariantAtom);
  const skinId = useAtomValue(activeSkinIdAtom);
  const lightSkinId = useAtomValue(lightSkinIdAtom);
  const darkSkinId = useAtomValue(darkSkinIdAtom);
  const lightAccent = useAtomValue(lightAccentPresetAtom);
  const darkAccent = useAtomValue(darkAccentPresetAtom);
  const accentPreset = useAtomValue(primaryColorPresetAtom);
  const iconStyle = useAtomValue(iconStyleAtom);
  const translucentSidebar = useAtomValue(translucentSidebarAtom);

  useEffect(() => {
    const root = document.documentElement;
    writeSkinTokens(resolveAppliedSkinTokens(skinId, variant, accentPreset));
    root.dataset.skin = skinId;

    return () => {
      clearSkinTokens();
      delete root.dataset.skin;
    };
  }, [skinId, variant, accentPreset]);

  // Mirror the selection so the stylesheet-swap paths and the pre-bundle splash
  // script can paint the right skin without waiting for React.
  useEffect(() => {
    writeSkinSelection({
      light: { skinId: lightSkinId, accent: lightAccent },
      dark: { skinId: darkSkinId, accent: darkAccent },
    });
    const surfaces = {
      light: splashSurfaceFor(lightSkinId, "light"),
      dark: splashSurfaceFor(darkSkinId, "dark"),
    };
    try {
      localStorage.setItem(SKIN_SURFACE_STORAGE_KEY, JSON.stringify(surfaces));
    } catch {
      // Restricted webview contexts have no storage; the splash falls back to
      // ORGII's own palette, which is a cosmetic difference on first paint.
    }
  }, [lightSkinId, darkSkinId, lightAccent, darkAccent]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.iconStyle = iconStyle;
    return () => {
      delete root.dataset.iconStyle;
    };
  }, [iconStyle]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.sidebarSurface = translucentSidebar ? "translucent" : "opaque";
    return () => {
      delete root.dataset.sidebarSurface;
    };
  }, [translucentSidebar]);
}

export default useAppSkin;
