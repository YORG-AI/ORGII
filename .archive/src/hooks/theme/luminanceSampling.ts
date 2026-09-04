/**
 * Luminance Sampling Utilities
 *
 * Pure helper functions for background-image luminance calculation, extracted
 * from useRegionLuminance to keep that module under the hook line limit.
 *
 * Sampling utilities:
 *  - Region area definitions (REGION_SAMPLE_AREAS)
 *  - Text color tables (TEXT_FOR_LIGHT_BG / TEXT_FOR_DARK_BG)
 *  - Default fallback values (DEFAULT_LUMINANCE / DEFAULT_MAP)
 *  - Color math helpers (parseColor, calculateColorLuminance)
 *  - Canvas + Rust-accelerated image sampling
 *  - Module-level LRU cache + dedup promise map
 *  - resolveRegionsSync (cache-read fast-path used by useMemo)
 */
import {
  type LuminanceAnalysis,
  type SampleRegion,
  calculateImageLuminance,
} from "@src/api/tauri/perf";
import { createLogger } from "@src/hooks/logger";

import type {
  LuminanceRegion,
  RegionLuminanceData,
  RegionLuminanceMap,
} from "./luminanceTypes";

const log = createLogger("RegionLuminance");

export const REGION_SAMPLE_AREAS: Record<
  LuminanceRegion,
  { x: number; y: number; width: number; height: number }
> = {
  toolbar: { x: 0.5, y: 0.05, width: 0.8, height: 0.08 },
  tabbar: { x: 0.5, y: 0.12, width: 0.7, height: 0.06 },
  sidebar: { x: 0.08, y: 0.5, width: 0.12, height: 0.6 },
  content: { x: 0.55, y: 0.5, width: 0.5, height: 0.5 },
  global: { x: 0.5, y: 0.4, width: 0.8, height: 0.6 },
};

export const TEXT_FOR_LIGHT_BG = {
  text1: "rgba(0, 0, 0, 0.87)",
  text2: "rgba(0, 0, 0, 0.6)",
  text3: "rgba(0, 0, 0, 0.38)",
  text4: "rgba(0, 0, 0, 0.24)",
};

export const TEXT_FOR_DARK_BG = {
  text1: "rgba(255, 255, 255, 0.92)",
  text2: "rgba(255, 255, 255, 0.7)",
  text3: "rgba(255, 255, 255, 0.5)",
  text4: "rgba(255, 255, 255, 0.3)",
};

export const DEFAULT_LUMINANCE: RegionLuminanceData = {
  luminance: 0.3,
  isLight: false,
  textColor: TEXT_FOR_DARK_BG.text1,
  text: { ...TEXT_FOR_DARK_BG },
};

export const DEFAULT_MAP: RegionLuminanceMap = {
  sidebar: { ...DEFAULT_LUMINANCE },
  toolbar: { ...DEFAULT_LUMINANCE },
  tabbar: { ...DEFAULT_LUMINANCE },
  content: { ...DEFAULT_LUMINANCE },
  global: { ...DEFAULT_LUMINANCE },
};

export function parseColor(
  color: string
): { r: number; g: number; b: number } | null {
  if (!color) return null;
  const trimmed = color.trim();
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
    return null;
  }
  const m = trimmed.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
  return null;
}

export function calculateColorLuminance(color: string): number {
  const rgb = parseColor(color);
  if (!rgb) return 0.3;
  const lin = (c: number) => {
    const n = c / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

export function luminanceToData(luminance: number): RegionLuminanceData {
  const isLight = luminance > 0.45;
  const contrastText = isLight ? TEXT_FOR_LIGHT_BG : TEXT_FOR_DARK_BG;
  return {
    luminance,
    isLight,
    textColor: contrastText.text1,
    text: { ...contrastText },
  };
}

export function createUniformLuminanceMap(
  luminance: number
): RegionLuminanceMap {
  const data = luminanceToData(luminance);
  return {
    sidebar: { ...data },
    toolbar: { ...data },
    tabbar: { ...data },
    content: { ...data },
    global: { ...data },
  };
}

export function extractImagePath(imageUrl: string): string | null {
  if (imageUrl.startsWith("file://"))
    return decodeURIComponent(imageUrl.substring(7));
  if (imageUrl.startsWith("asset://"))
    return decodeURIComponent(new URL(imageUrl).pathname);
  return null;
}

async function sampleAllRegionsRust(
  imagePath: string
): Promise<RegionLuminanceMap | null> {
  try {
    const regions: SampleRegion[] = (
      Object.keys(REGION_SAMPLE_AREAS) as LuminanceRegion[]
    ).map((name) => ({ name, ...REGION_SAMPLE_AREAS[name] }));
    const result: LuminanceAnalysis = await calculateImageLuminance(
      imagePath,
      regions
    );
    log.debug(
      `[RegionLuminance] Rust processed ${result.regions.length} regions in ${result.processing_time_ms.toFixed(2)}ms`
    );
    const map: Partial<RegionLuminanceMap> = {};
    for (const region of result.regions)
      map[region.name as LuminanceRegion] = luminanceToData(region.luminance);
    return map as RegionLuminanceMap;
  } catch (error) {
    log.warn(
      "[RegionLuminance] Rust acceleration failed, falling back:",
      error
    );
    return null;
  }
}

function sampleRegionLuminance(
  imageUrl: string,
  region: LuminanceRegion
): Promise<number> {
  return new Promise((resolve) => {
    if (!imageUrl) {
      resolve(0.3);
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          resolve(0.3);
          return;
        }
        const sampleSize = 40;
        canvas.width = sampleSize;
        canvas.height = sampleSize;
        const area = REGION_SAMPLE_AREAS[region];
        const srcX = Math.max(0, (area.x - area.width / 2) * img.width);
        const srcY = Math.max(0, (area.y - area.height / 2) * img.height);
        const srcW = Math.min(area.width * img.width, img.width - srcX);
        const srcH = Math.min(area.height * img.height, img.height - srcY);
        ctx.drawImage(
          img,
          srcX,
          srcY,
          srcW,
          srcH,
          0,
          0,
          sampleSize,
          sampleSize
        );
        const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;
        let totalLuminance = 0;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 128) {
            const lin = (c: number) => {
              const n = c / 255;
              return n <= 0.03928
                ? n / 12.92
                : Math.pow((n + 0.055) / 1.055, 2.4);
            };
            totalLuminance +=
              0.2126 * lin(data[i]) +
              0.7152 * lin(data[i + 1]) +
              0.0722 * lin(data[i + 2]);
            count++;
          }
        }
        resolve(count > 0 ? totalLuminance / count : 0.3);
      } catch {
        resolve(0.3);
      }
    };
    img.onerror = () => resolve(0.3);
    img.src = imageUrl;
  });
}

async function sampleAllRegionsForImageUrl(
  imageUrl: string
): Promise<RegionLuminanceMap> {
  let result: RegionLuminanceMap | null = null;
  const imagePath = extractImagePath(imageUrl);
  if (imagePath) result = await sampleAllRegionsRust(imagePath);
  if (!result) {
    const [sidebar, toolbar, tabbar, content, global] = await Promise.all([
      sampleRegionLuminance(imageUrl, "sidebar"),
      sampleRegionLuminance(imageUrl, "toolbar"),
      sampleRegionLuminance(imageUrl, "tabbar"),
      sampleRegionLuminance(imageUrl, "content"),
      sampleRegionLuminance(imageUrl, "global"),
    ]);
    result = {
      sidebar: luminanceToData(sidebar),
      toolbar: luminanceToData(toolbar),
      tabbar: luminanceToData(tabbar),
      content: luminanceToData(content),
      global: luminanceToData(global),
    };
  }
  luminanceCache.set(imageUrl, result);
  evictLuminanceCache();
  return result;
}

const MAX_LUMINANCE_CACHE_SIZE = 20;
export const luminanceCache = new Map<string, RegionLuminanceMap>();
const samplingPromises = new Map<string, Promise<RegionLuminanceMap>>();

function evictLuminanceCache() {
  if (luminanceCache.size <= MAX_LUMINANCE_CACHE_SIZE) return;
  const keysToDelete = [...luminanceCache.keys()].slice(
    0,
    luminanceCache.size - MAX_LUMINANCE_CACHE_SIZE
  );
  for (const key of keysToDelete) luminanceCache.delete(key);
}

export function resolveRegionsSync(
  solidBackgroundColor: string | undefined,
  imageUrl: string
): RegionLuminanceMap {
  if (solidBackgroundColor) {
    const cacheKey = `color:${solidBackgroundColor}`;
    const cached = luminanceCache.get(cacheKey);
    if (cached) return cached;
    const solidMap = createUniformLuminanceMap(
      calculateColorLuminance(solidBackgroundColor)
    );
    luminanceCache.set(cacheKey, solidMap);
    return solidMap;
  }
  if (!imageUrl) return DEFAULT_MAP;
  return luminanceCache.get(imageUrl) ?? DEFAULT_MAP;
}

export function getOrStartSampling(
  imageUrl: string
): Promise<RegionLuminanceMap> {
  const cached = luminanceCache.get(imageUrl);
  if (cached) return Promise.resolve(cached);
  const existing = samplingPromises.get(imageUrl);
  if (existing) return existing;
  const promise = sampleAllRegionsForImageUrl(imageUrl).finally(() => {
    samplingPromises.delete(imageUrl);
  });
  samplingPromises.set(imageUrl, promise);
  return promise;
}
