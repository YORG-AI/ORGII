import { clearCache, clearCacheForImage, getCached, setCached } from "./cache";
import { colorFieldFromCssColor, resolveCssColorValue } from "./colorAnalysis";
import { resolveMaterial } from "./materialResolver";
import { sampleRegion } from "./regionSampling";
import type { GlassMaterial, GlassRegion, ResolverConfig } from "./types";

/**
 * Glass Material Resolver
 *
 * Implements Apple's NSVisualEffectMaterial approach for glass.
 *
 * Key concepts:
 * 1. Each UI REGION samples from its own area (not per-component)
 * 2. Extracts SEMANTIC color properties (dominant hue, luminance, contrast)
 * 3. Creates STABLE materials that don't flicker on small movements
 * 4. All components in a region share the same material
 * 5. Gets base material properties from config.ts (single source of truth)
 *
 * This is NOT pixel sampling - it's low-frequency semantic color extraction.
 */

export type {
  GlassRegion,
  AppearanceMode,
  WallpaperColorField,
  LegibilityGuard,
  GlassMaterial,
} from "./types";
export { resolveMaterial } from "./materialResolver";

// ============================================
// Public API
// ============================================

/**
 * Resolve glass material for a specific region
 *
 * @example
 * ```ts
 * const material = await resolveGlassMaterial({
 *   appearance: "dark",
 *   backgroundImageUrl: wallpaperUrl,
 *   thickness: "thin",
 * }, "tabbar");
 *
 * // Use in Glass:
 * <Glass
 *   enableRim={true}
 *   rimColor={material.tintRGB}
 *   rimBrightnessOffsets={material.rimOffsets}
 * />
 * ```
 */
export async function resolveGlassMaterial(
  config: ResolverConfig,
  region: GlassRegion = "global"
): Promise<GlassMaterial> {
  // If backgroundColor is provided, use it directly without sampling
  if (config.backgroundColor) {
    const resolvedBackgroundColor = resolveCssColorValue(
      config.backgroundColor
    );
    const cacheKey = `color:${resolvedBackgroundColor}-${region}`;
    const materialKey = `${config.appearance}-${config.thickness}`;

    const cached = getCached(cacheKey);
    if (cached) {
      const cachedMaterial = cached.materials.get(materialKey);
      if (cachedMaterial) return cachedMaterial;

      const material = resolveMaterial(
        cached.colorField,
        config.appearance,
        config.thickness
      );
      cached.materials.set(materialKey, material);
      return material;
    }

    const colorField = colorFieldFromCssColor(resolvedBackgroundColor);
    const material = resolveMaterial(
      colorField,
      config.appearance,
      config.thickness
    );

    setCached(cacheKey, {
      colorField,
      materials: new Map([[materialKey, material]]),
      timestamp: Date.now(),
    });

    return material;
  }

  const cacheKey = `${config.backgroundImageUrl}-${region}`;
  const materialKey = `${config.appearance}-${config.thickness}`;

  const cached = getCached(cacheKey);
  if (cached) {
    const cachedMaterial = cached.materials.get(materialKey);
    if (cachedMaterial) return cachedMaterial;

    const material = resolveMaterial(
      cached.colorField,
      config.appearance,
      config.thickness
    );
    cached.materials.set(materialKey, material);
    return material;
  }

  const colorField = await sampleRegion(config.backgroundImageUrl, region);
  const material = resolveMaterial(
    colorField,
    config.appearance,
    config.thickness
  );

  setCached(cacheKey, {
    colorField,
    materials: new Map([[materialKey, material]]),
    timestamp: Date.now(),
  });

  return material;
}

/**
 * Resolve glass material synchronously (uses cache or returns default)
 */
export function resolveGlassMaterialSync(
  config: ResolverConfig,
  region: GlassRegion = "global"
): GlassMaterial | null {
  if (config.backgroundColor) {
    const resolvedBackgroundColor = resolveCssColorValue(
      config.backgroundColor
    );
    const cacheKey = `color:${resolvedBackgroundColor}-${region}`;
    const materialKey = `${config.appearance}-${config.thickness}`;

    const cached = getCached(cacheKey);
    if (cached) {
      const cachedMaterial = cached.materials.get(materialKey);
      if (cachedMaterial) return cachedMaterial;

      const material = resolveMaterial(
        cached.colorField,
        config.appearance,
        config.thickness
      );
      cached.materials.set(materialKey, material);
      return material;
    }

    const colorField = colorFieldFromCssColor(resolvedBackgroundColor);
    const material = resolveMaterial(
      colorField,
      config.appearance,
      config.thickness
    );

    setCached(cacheKey, {
      colorField,
      materials: new Map([[materialKey, material]]),
      timestamp: Date.now(),
    });

    return material;
  }

  const cacheKey = `${config.backgroundImageUrl}-${region}`;
  const materialKey = `${config.appearance}-${config.thickness}`;

  const cached = getCached(cacheKey);
  if (cached) {
    const cachedMaterial = cached.materials.get(materialKey);
    if (cachedMaterial) return cachedMaterial;

    const material = resolveMaterial(
      cached.colorField,
      config.appearance,
      config.thickness
    );
    cached.materials.set(materialKey, material);
    return material;
  }

  return null;
}

/**
 * Preload materials for all regions (call on app startup)
 */
async function preloadAllRegions(
  backgroundImageUrl: string,
  appearance: "light" | "dark"
): Promise<Map<GlassRegion, GlassMaterial>> {
  const results = new Map<GlassRegion, GlassMaterial>();
  const regions: GlassRegion[] = [
    "menubar",
    "tabbar",
    "toolbar",
    "sidebar",
    "content",
    "modal",
    "global",
  ];

  await Promise.all(
    regions.map(async (region) => {
      const material = await resolveGlassMaterial(
        { appearance, backgroundImageUrl, thickness: "thin" },
        region
      );
      results.set(region, material);
    })
  );

  return results;
}

/**
 * Clear material cache (call when wallpaper changes)
 */
function clearMaterialCache(): void {
  clearCache();
}

/**
 * Clear cache for specific image
 */
export function clearMaterialCacheForImage(imageUrl: string): void {
  clearCacheForImage(imageUrl);
}

const ALL_REGIONS: GlassRegion[] = [
  "menubar",
  "tabbar",
  "toolbar",
  "sidebar",
  "content",
  "modal",
  "global",
];

/**
 * Prewarm a single (color, region, appearance, thickness) cache entry.
 *
 * The color path is fully synchronous (no pixel sampling), so this avoids
 * the microtask + setState round-trip that `resolveGlassMaterial` would
 * impose on every glass component the first time a new color is seen.
 */
function prewarmColorEntry(
  color: string,
  region: GlassRegion,
  appearance: "light" | "dark",
  thickness: ResolverConfig["thickness"]
): void {
  const resolvedColor = resolveCssColorValue(color);
  const cacheKey = `color:${resolvedColor}-${region}`;
  const materialKey = `${appearance}-${thickness}`;

  const cached = getCached(cacheKey);
  if (cached?.materials.has(materialKey)) return;

  if (cached) {
    const material = resolveMaterial(cached.colorField, appearance, thickness);
    cached.materials.set(materialKey, material);
    return;
  }

  const colorField = colorFieldFromCssColor(resolvedColor);
  const material = resolveMaterial(colorField, appearance, thickness);
  setCached(cacheKey, {
    colorField,
    materials: new Map([[materialKey, material]]),
    timestamp: Date.now(),
  });
}

export function prewarmColor(color: string): void {
  for (const region of ALL_REGIONS) {
    prewarmColorEntry(color, region, "light", "thin");
    prewarmColorEntry(color, region, "dark", "thin");
  }
}

export default {
  resolveGlassMaterial,
  resolveGlassMaterialSync,
  preloadAllRegions,
  clearMaterialCache,
  clearMaterialCacheForImage,
  prewarmColor,
};
