/**
 * Resolve glass tint and legibility from the configured solid background.
 */
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo } from "react";

import {
  HOST_DESKTOP,
  resolveHostDesktop,
} from "@src/config/windowChromeRadius";
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";
import {
  type GlassMaterial,
  type GlassRegion,
  resolveGlassMaterial,
} from "@src/util/ui/theme/glassMaterial";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

const IS_MACOS_HOST = resolveHostDesktop() === HOST_DESKTOP.MACOS;

export interface UseGlassMaterialOptions {
  /** Material thickness */
  thickness?: "ultrathin" | "thin" | "medium" | "thick";
  /** Skip resolution (for conditional usage) */
  skip?: boolean;
  /** Callback when material is resolved */
  onResolved?: (material: GlassMaterial) => void;
}

export interface UseGlassMaterialReturn {
  material: GlassMaterial | null;
  isReady: boolean;
  isLoading: boolean;
  refresh: () => void;
}

export function useGlassMaterial(
  region: GlassRegion = "global",
  options: UseGlassMaterialOptions = {}
): UseGlassMaterialReturn {
  const { thickness = "thin", skip = false, onResolved } = options;
  const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
  const { isDark } = useCurrentTheme();
  const appearance = isDark ? "dark" : "light";
  const backgroundColor = IS_MACOS_HOST
    ? undefined
    : backgroundConfig.backgroundColor;

  const material = useMemo(
    () =>
      skip
        ? null
        : resolveGlassMaterial(
            { appearance, backgroundColor, thickness },
            region
          ),
    [appearance, backgroundColor, region, skip, thickness]
  );

  useEffect(() => {
    if (material) onResolved?.(material);
  }, [material, onResolved]);

  const refresh = useCallback(() => {
    if (material) onResolved?.(material);
  }, [material, onResolved]);

  return {
    material,
    isReady: material !== null,
    isLoading: false,
    refresh,
  };
}

export default useGlassMaterial;
