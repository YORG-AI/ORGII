/**
 * Background Configuration Atoms
 *
 * Manages the app's solid background and translucent surface state:
 *   - Solid color (preset IDs + custom hex)
 *   - Page and sidebar opacity
 *
 * Persisted to localStorage under `orgii_background_config`.
 */
import { atom } from "jotai";

import {
  getBackgroundColorPresetById,
  resolveBackgroundColorPreset,
} from "@src/config/appearance/backgroundColors";
import {
  normalizeHexColor,
  sanitizeCustomColorsArray,
} from "@src/config/appearance/backgroundConfig";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("BackgroundConfig");

// ============================================
// Types
// ============================================

export interface BackgroundConfig {
  /** DIY solid hex colors (#rrggbb), shown after presets */
  customColors?: string[];
  /** Applied CSS color. Presets use app background tokens; custom colors use literal values. */
  backgroundColor?: string;
  /**
   * Stable ID of the active preset desktop background color (e.g. "classic",
   * "ocean"). Absent for custom colors.
   */
  backgroundColorId?: string;
  /**
   * Opacity of the page panel surface (`bg-bg-2`) as an integer percent
   * 0–100. Lower values reveal more of the solid app background or native
   * desktop material. Undefined or 100 = fully opaque.
   */
  pageOpacity?: number;
  /**
   * Opacity of the navigation sidebar surface (`var(--sidebar-bg)`) as
   * an integer percent. Same semantics as `pageOpacity`.
   */
  sidebarOpacity?: number;
}

// ============================================
// Defaults + localStorage helpers
// ============================================

const BACKGROUND_CONFIG_KEY = "orgii_background_config";

const DEFAULT_BACKGROUND_COLOR_ID = "graphite";

export const DEFAULT_PAGE_OPACITY = 100;
export const MIN_PAGE_OPACITY = 40;
export const MAX_PAGE_OPACITY = 100;

export const DEFAULT_SIDEBAR_OPACITY = 85;
export const MIN_SIDEBAR_OPACITY = 0;
export const MAX_SIDEBAR_OPACITY = 100;

function clampOpacity(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

export function sanitizePageOpacity(value: unknown): number {
  return clampOpacity(
    value,
    MIN_PAGE_OPACITY,
    MAX_PAGE_OPACITY,
    DEFAULT_PAGE_OPACITY
  );
}

export function sanitizeSidebarOpacity(value: unknown): number {
  return clampOpacity(
    value,
    MIN_SIDEBAR_OPACITY,
    MAX_SIDEBAR_OPACITY,
    DEFAULT_SIDEBAR_OPACITY
  );
}

const DEFAULT_BACKGROUND_CONFIG: BackgroundConfig = {
  customColors: [],
  backgroundColorId: DEFAULT_BACKGROUND_COLOR_ID,
  pageOpacity: DEFAULT_PAGE_OPACITY,
  sidebarOpacity: DEFAULT_SIDEBAR_OPACITY,
};

export function normalizeBackgroundConfig(raw: unknown): BackgroundConfig {
  const parsed =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const requestedPresetId =
    typeof parsed.backgroundColorId === "string"
      ? parsed.backgroundColorId
      : undefined;
  const presetId = getBackgroundColorPresetById(requestedPresetId)?.id;
  const customColor =
    typeof parsed.backgroundColor === "string"
      ? normalizeHexColor(parsed.backgroundColor)
      : null;

  return {
    customColors: sanitizeCustomColorsArray(parsed.customColors),
    ...(presetId
      ? { backgroundColorId: presetId }
      : customColor
        ? { backgroundColor: customColor }
        : { backgroundColorId: DEFAULT_BACKGROUND_COLOR_ID }),
    pageOpacity: sanitizePageOpacity(parsed.pageOpacity),
    sidebarOpacity: sanitizeSidebarOpacity(parsed.sidebarOpacity),
  };
}

function getStoredBackgroundConfig(): BackgroundConfig {
  try {
    const stored = localStorage.getItem(BACKGROUND_CONFIG_KEY);
    if (stored) {
      const normalized = normalizeBackgroundConfig(JSON.parse(stored));
      localStorage.setItem(BACKGROUND_CONFIG_KEY, JSON.stringify(normalized));
      return normalized;
    }
  } catch (err) {
    log.warn("[BackgroundConfig] Failed to parse stored config:", err);
  }
  return DEFAULT_BACKGROUND_CONFIG;
}

// ============================================
// Atoms
// ============================================

export const backgroundConfigAtom = atom<BackgroundConfig>(
  getStoredBackgroundConfig()
);
backgroundConfigAtom.debugLabel = "backgroundConfigAtom";

export const backgroundConfigPersistAtom = atom(
  (get) => get(backgroundConfigAtom),
  (get, set, value: BackgroundConfig) => {
    const normalized = normalizeBackgroundConfig(value);
    set(backgroundConfigAtom, normalized);
    localStorage.setItem(BACKGROUND_CONFIG_KEY, JSON.stringify(normalized));
  }
);

/**
 * Resolved background config: when a preset ID is active, ensures
 * `backgroundColor` points at the preset's app background CSS slot. Theme CSS
 * owns the slot values, so the selected ID follows Light / Dark / High Contrast.
 */
export const resolvedBackgroundConfigAtom = atom<BackgroundConfig>((get) => {
  const config = get(backgroundConfigAtom);
  const presetId = config.backgroundColorId;
  if (!presetId) return config;
  const preset = getBackgroundColorPresetById(presetId);
  if (!preset) return config;
  return {
    ...config,
    backgroundColor: resolveBackgroundColorPreset(preset),
  };
});
resolvedBackgroundConfigAtom.debugLabel = "resolvedBackgroundConfigAtom";
