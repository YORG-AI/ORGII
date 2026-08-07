/**
 * useGlassMaterial Hook
 *
 * React hook for consuming the Glass Material Resolver.
 *
 * Key features:
 * - Region-based material resolution (toolbar, menubar, tabbar, etc.)
 * - Automatic re-resolution on wallpaper/theme changes
 * - Caching for stable colors (no flicker)
 * - Preloading support for instant materials
 *
 * @example
 * ```tsx
 * // In a tabbar component:
 * const { material, isReady } = useGlassMaterial("tabbar");
 *
 * return (
 *   <Glass
 *     material="thin"
 *     enableRim={isReady}
 *     rimColor={material?.tintRGB}
 *     rimBrightnessOffsets={material?.rimOffsets}
 *   >
 *     {tabs}
 *   </Glass>
 * );
 * ```
 */
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  HOST_DESKTOP,
  resolveHostDesktop,
} from "@src/config/windowChromeRadius";
import { useMountedCleanup } from "@src/hooks/lifecycle/useMounted";
import { createLogger } from "@src/hooks/logger";
// Direct leaf import to avoid pulling @src/store's barrel — which transitively
// reaches Glass → useGlassMaterial and creates a circular dependency.
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";
import {
  GlassMaterial,
  GlassRegion,
  clearMaterialCacheForImage,
  resolveGlassMaterial,
  resolveGlassMaterialSync,
} from "@src/util/ui/theme/glassMaterial";
import { resolveMaterial as buildMaterialFromColorField } from "@src/util/ui/theme/glassMaterial/materialResolver";
import type { WallpaperColorField } from "@src/util/ui/theme/glassMaterial/types";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import { useBackgroundImage } from "./useBackgroundImage";

const log = createLogger("useGlassMaterial");
const IS_MACOS_HOST = resolveHostDesktop() === HOST_DESKTOP.MACOS;

// Neutral color field used when no background image or color is available
// (e.g. Glass mode — native OS provides the background, not a URL).
// luminance=0.5 → mid-point, no legibility guard activation, neutral tint.
const NEUTRAL_COLOR_FIELD: WallpaperColorField = {
  dominantHue: 0,
  saturation: 0.05,
  luminance: 0.5,
  temperature: "neutral",
  dominantRGB: { r: 128, g: 128, b: 128 },
};

// ============================================
// Types
// ============================================

export interface UseGlassMaterialOptions {
  /** Material thickness */
  thickness?: "ultrathin" | "thin" | "medium" | "thick";
  /** Skip resolution (for conditional usage) */
  skip?: boolean;
  /** Callback when material is resolved */
  onResolved?: (material: GlassMaterial) => void;
}

export interface UseGlassMaterialReturn {
  /** Resolved glass material (null while loading) */
  material: GlassMaterial | null;
  /** Whether material is ready */
  isReady: boolean;
  /** Whether resolution is in progress */
  isLoading: boolean;
  /** Force re-resolution */
  refresh: () => void;
}

// ============================================
// Hook Implementation
// ============================================

/**
 * Hook to get resolved glass material for a specific UI region
 *
 * @param region - The UI region (menubar, tabbar, toolbar, sidebar, content, modal, global)
 * @param options - Configuration options
 *
 * @example
 * ```tsx
 * function TabBar() {
 *   const { material, isReady } = useGlassMaterial("tabbar");
 *
 *   return (
 *     <Glass
 *       enableRim={isReady}
 *       rimColor={material?.tintRGB}
 *       rimBrightnessOffsets={material?.rimOffsets}
 *     >
 *       <TabList />
 *     </Glass>
 *   );
 * }
 * ```
 */
export function useGlassMaterial(
  region: GlassRegion = "global",
  options: UseGlassMaterialOptions = {}
): UseGlassMaterialReturn {
  const { thickness = "thin", skip = false, onResolved } = options;

  // Get current context
  const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
  const storedBackgroundImageUrl = useBackgroundImage();
  const backgroundImageUrl = IS_MACOS_HOST ? "" : storedBackgroundImageUrl;
  const backgroundColor = IS_MACOS_HOST
    ? undefined
    : backgroundConfig.backgroundColor;
  const { isDark } = useCurrentTheme();
  const appearance = isDark ? "dark" : "light";

  // State
  const [material, setMaterial] = useState<GlassMaterial | null>(() =>
    // Try to get from cache synchronously
    resolveGlassMaterialSync(
      { appearance, backgroundImageUrl, backgroundColor, thickness },
      region
    )
  );
  const [isLoading, setIsLoading] = useState(!material);

  const isMountedRef = useRef(true);
  useMountedCleanup(isMountedRef);
  const lastConfigRef = useRef<string>("");

  // Track previous background URL for cache invalidation
  const prevBackgroundUrlRef = useRef<string>("");

  // Resolution function
  const resolveMaterial = useCallback(async () => {
    if (skip) {
      setMaterial(null);
      setIsLoading(false);
      return;
    }

    // No background source (Glass mode or unset): synthesize a neutral
    // material from the current appearance so glass components have a stable
    // tint/rim instead of silently returning null.
    if (!backgroundImageUrl && !backgroundColor) {
      const neutralMaterial = buildMaterialFromColorField(
        NEUTRAL_COLOR_FIELD,
        appearance,
        thickness
      );
      queueMicrotask(() => {
        if (isMountedRef.current) {
          setMaterial(neutralMaterial);
          setIsLoading(false);
          onResolved?.(neutralMaterial);
        }
      });
      return;
    }

    const configKey = backgroundColor
      ? `color:${backgroundColor}-${region}-${appearance}-${thickness}`
      : `${backgroundImageUrl}-${region}-${appearance}-${thickness}`;

    // Clear cache if background URL changed (wallpaper switch)
    if (
      prevBackgroundUrlRef.current &&
      prevBackgroundUrlRef.current !== backgroundImageUrl &&
      !backgroundColor
    ) {
      clearMaterialCacheForImage(prevBackgroundUrlRef.current);
      lastConfigRef.current = ""; // Force re-resolution
    }
    prevBackgroundUrlRef.current = backgroundImageUrl;

    // Skip if same config
    if (configKey === lastConfigRef.current && material) {
      return;
    }
    lastConfigRef.current = configKey;

    // Try sync first (from cache)
    const cachedMaterial = resolveGlassMaterialSync(
      { appearance, backgroundImageUrl, backgroundColor, thickness },
      region
    );

    if (cachedMaterial) {
      // Defer state updates to avoid cascading renders when called from effect
      queueMicrotask(() => {
        if (isMountedRef.current) {
          setMaterial(cachedMaterial);
          setIsLoading(false);
          onResolved?.(cachedMaterial);
        }
      });
      return;
    }

    // Async resolution
    setIsLoading(true);

    try {
      const resolvedMaterial = await resolveGlassMaterial(
        { appearance, backgroundImageUrl, backgroundColor, thickness },
        region
      );

      if (isMountedRef.current) {
        setMaterial(resolvedMaterial);
        setIsLoading(false);
        onResolved?.(resolvedMaterial);
      }
    } catch (error) {
      log.error("[useGlassMaterial] Resolution failed:", error);
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [
    backgroundImageUrl,
    backgroundColor,
    region,
    appearance,
    thickness,
    skip,
    onResolved,
    material,
    isMountedRef,
  ]);

  // Resolve on mount and when dependencies change
  useEffect(() => {
    // Schedule the material resolution to avoid calling setState synchronously in effect
    const timeoutId = setTimeout(resolveMaterial, 0);
    return () => clearTimeout(timeoutId);
  }, [resolveMaterial]);

  // Refresh function (for manual re-resolution)
  const refresh = useCallback(() => {
    if (backgroundImageUrl) {
      clearMaterialCacheForImage(backgroundImageUrl);
      lastConfigRef.current = "";
      resolveMaterial();
    }
  }, [backgroundImageUrl, resolveMaterial]);

  return {
    material,
    isReady: !!material && !isLoading,
    isLoading,
    refresh,
  };
}

/**
 * Hook for preloading all region materials (call on app startup)
 *
 * @example
 * ```tsx
 * function App() {
 *   const { isPreloaded } = usePreloadGlassMaterials();
 *
 *   if (!isPreloaded) {
 *     return <SplashScreen />;
 *   }
 *
 *   return <MainApp />;
 * }
 * ```
 */
export function usePreloadGlassMaterials(): { isPreloaded: boolean } {
  const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
  const storedBackgroundImageUrl = useBackgroundImage();
  const backgroundImageUrl = IS_MACOS_HOST ? "" : storedBackgroundImageUrl;
  const backgroundColor = IS_MACOS_HOST
    ? undefined
    : backgroundConfig.backgroundColor;
  const { isDark } = useCurrentTheme();
  const appearance = isDark ? "dark" : "light";
  const [isPreloaded, setIsPreloaded] = useState(false);

  useEffect(() => {
    // Can preload if we have either an image or a color
    if (!backgroundImageUrl && !backgroundColor) return;

    const preload = async () => {
      const regions: GlassRegion[] = [
        "menubar",
        "tabbar",
        "toolbar",
        "sidebar",
        "content",
        "global",
      ];

      await Promise.all(
        regions.map((region) =>
          resolveGlassMaterial(
            {
              appearance,
              backgroundImageUrl,
              backgroundColor,
              thickness: "thin",
            },
            region
          )
        )
      );

      setIsPreloaded(true);
    };

    preload();
  }, [backgroundImageUrl, backgroundColor, appearance]);

  return { isPreloaded };
}

export default useGlassMaterial;
