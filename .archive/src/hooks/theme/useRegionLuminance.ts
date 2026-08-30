/**
 * useRegionLuminance Hook
 *
 * Pre-calculates luminance values for different UI regions by sampling
 * the background image or solid color. Used for adaptive text contrast.
 *
 * Regions:
 * - sidebar: Left sidebar area
 * - toolbar: Top toolbar area
 * - tabbar: Tab bar area
 * - content: Main content area (center)
 *
 * Features:
 * - Samples background image once when it changes
 * - Handles solid background colors (calculates luminance directly)
 * - Caches luminance values per region
 * - Provides isLight helper for contrast decisions
 * - **Rust-accelerated in Tauri (5-10x faster)**
 *
 * Sampling utilities live in luminanceSampling.ts.
 */
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";

import {
  HOST_DESKTOP,
  resolveHostDesktop,
} from "@src/config/windowChromeRadius";
import { createLogger } from "@src/hooks/logger";
import { resolvedBackgroundConfigAtom } from "@src/store";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import {
  DEFAULT_LUMINANCE,
  createUniformLuminanceMap,
  getOrStartSampling,
  luminanceCache,
  resolveRegionsSync,
} from "./luminanceSampling";
import type {
  LuminanceRegion,
  RegionLuminanceData,
  RegionLuminanceMap,
} from "./luminanceTypes";
import { useBackgroundImage } from "./useBackgroundImage";

const log = createLogger("RegionLuminance");
const IS_MACOS_HOST = resolveHostDesktop() === HOST_DESKTOP.MACOS;

// ============================================
// Hook
// ============================================

export interface UseRegionLuminanceReturn {
  regions: RegionLuminanceMap;
  getRegion: (region: LuminanceRegion) => RegionLuminanceData;
  isRegionLight: (region: LuminanceRegion) => boolean;
  /**
   * Reserved for future UI; always false. Tracking in-flight sampling would
   * require synchronous effect state (lint) or an external store — no current
   * callers read this.
   */
  isLoading: boolean;
}

export function useRegionLuminance(): UseRegionLuminanceReturn {
  const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
  const currentImageUrl = useBackgroundImage();
  const shouldUseAdaptiveColors = Boolean(
    !IS_MACOS_HOST &&
    backgroundConfig.adaptiveColors &&
    backgroundConfig.selectedImageId
  );
  const adaptiveImageUrl = shouldUseAdaptiveColors ? currentImageUrl : "";
  const { isDark } = useCurrentTheme();

  const [sampleTick, setSampleTick] = useState(0);

  const regions = useMemo(() => {
    if (backgroundConfig.glass != null) {
      return createUniformLuminanceMap(isDark ? 0.3 : 0.7);
    }
    if (!shouldUseAdaptiveColors) {
      return createUniformLuminanceMap(isDark ? 0.3 : 0.7);
    }
    void sampleTick;
    return resolveRegionsSync(undefined, adaptiveImageUrl);
  }, [
    backgroundConfig.glass,
    isDark,
    shouldUseAdaptiveColors,
    adaptiveImageUrl,
    sampleTick,
  ]);

  useEffect(() => {
    if (!shouldUseAdaptiveColors || !adaptiveImageUrl) return;
    if (luminanceCache.has(adaptiveImageUrl)) return;

    let cancelled = false;
    getOrStartSampling(adaptiveImageUrl)
      .then(() => {
        if (!cancelled) setSampleTick((tick) => tick + 1);
      })
      .catch((error) => {
        if (!cancelled) {
          log.error("[RegionLuminance] Failed to sample:", error);
          setSampleTick((tick) => tick + 1);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [adaptiveImageUrl, shouldUseAdaptiveColors]);

  const getRegion = (region: LuminanceRegion): RegionLuminanceData =>
    regions[region] || DEFAULT_LUMINANCE;

  const isRegionLight = (region: LuminanceRegion): boolean =>
    getRegion(region).isLight;

  return { regions, getRegion, isRegionLight, isLoading: false };
}

export default useRegionLuminance;
