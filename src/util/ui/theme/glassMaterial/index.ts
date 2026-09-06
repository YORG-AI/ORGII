import { getCached, setCached } from "./cache";
import {
  DEFAULT_COLOR_FIELD,
  colorFieldFromCssColor,
  resolveCssColorValue,
} from "./colorAnalysis";
import { resolveMaterial } from "./materialResolver";
import type { GlassMaterial, GlassRegion, ResolverConfig } from "./types";

/**
 * Glass Material Resolver
 *
 * Glass tint and legibility are derived from the configured solid background.
 * Region remains part of the cache key so callers keep stable region semantics,
 * even though a solid surface has the same source color everywhere.
 */

export type {
  GlassRegion,
  AppearanceMode,
  SurfaceColorField,
  LegibilityGuard,
  GlassMaterial,
} from "./types";
export { resolveMaterial } from "./materialResolver";

export function resolveGlassMaterial(
  config: ResolverConfig,
  region: GlassRegion = "global"
): GlassMaterial {
  const resolvedColor = config.backgroundColor
    ? resolveCssColorValue(config.backgroundColor)
    : "neutral";
  const cacheKey = `color:${resolvedColor}-${region}`;
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

  const colorField = config.backgroundColor
    ? colorFieldFromCssColor(resolvedColor)
    : DEFAULT_COLOR_FIELD;
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

const ALL_REGIONS: GlassRegion[] = [
  "menubar",
  "tabbar",
  "toolbar",
  "sidebar",
  "content",
  "modal",
  "global",
];

export function prewarmColor(color: string): void {
  for (const region of ALL_REGIONS) {
    resolveGlassMaterial(
      { appearance: "light", backgroundColor: color, thickness: "thin" },
      region
    );
    resolveGlassMaterial(
      { appearance: "dark", backgroundColor: color, thickness: "thin" },
      region
    );
  }
}

export default {
  resolveGlassMaterial,
  prewarmColor,
};
