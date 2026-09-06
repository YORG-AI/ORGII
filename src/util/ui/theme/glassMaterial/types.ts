/**
 * Glass Material Types
 *
 * All type definitions for the Glass Material Resolver system.
 */

/** UI regions that can have distinct glass materials */
export type GlassRegion =
  | "menubar" // Top of screen
  | "tabbar" // Tab bar area
  | "toolbar" // Main toolbar
  | "sidebar" // Left sidebar
  | "content" // Main content area
  | "modal" // Modal overlays
  | "global"; // Fallback/default

/** Appearance mode */
export type AppearanceMode = "light" | "dark";

/** Semantic properties derived from the configured background color */
export interface SurfaceColorField {
  /** Dominant hue in degrees (0-360) */
  dominantHue: number;
  /** Average saturation (0-1) */
  saturation: number;
  /** Average luminance (0-1) */
  luminance: number;
  /** Whether the color is predominantly warm or cool */
  temperature: "warm" | "cool" | "neutral";
  /** Raw RGB for tint derivation */
  dominantRGB: { r: number; g: number; b: number };
}

/** Legibility Guard - scrim and foreground adjustments for bright backgrounds */
export interface LegibilityGuard {
  /** Background luminance (0-1) from sampled region */
  backgroundLuminance: number;
  /** Scrim strength (0-1) - kicks in when L > 0.65 */
  scrimStrength: number;
  /** Dark scrim alpha to apply (0-0.10) - increases on bright backgrounds */
  scrimAlpha: number;
  /** Additional tint alpha boost (0-0.06) for bright backgrounds */
  tintAlphaBoost: number;
  /** Text/icon opacity (0.85-1.0) - higher on bright backgrounds */
  foregroundOpacity: number;
  /** Whether legibility guard is active (L > 0.65) */
  isActive: boolean;
}

/** Resolved glass material - what components consume */
export interface GlassMaterial {
  /** Backdrop blur radius in pixels */
  blur: number;
  /** Tint color as rgba string (sRGB fallback) */
  tint: string;
  /** Tint color in Display-P3 color space (Safari-like wide gamut) */
  tintP3: string;
  /** Tint RGB values (for box-shadow rim) */
  tintRGB: { r: number; g: number; b: number };
  /** Backdrop saturation (Safari-style: 110% = 1.10) */
  saturation: number;
  /** Backdrop brightness (Safari uses ~1.08) */
  backdropBrightness: number;
  /** Backdrop contrast (Safari uses ~1.06) */
  backdropContrast: number;
  /** Specular highlight opacity (0-1) - Safari: 0.35 light, 0.15 dark */
  highlightOpacity: number;
  /** Shadow opacity for depth (0-1) */
  shadowOpacity: number;
  /** Rim brightness offsets for box-shadow */
  rimOffsets: { base: number; highlight: number; glow: number };
  /** Whether to enable noise layer for banding removal */
  enableNoise: boolean;
  /** Legibility Guard - scrim and foreground adjustments for bright backgrounds */
  legibilityGuard: LegibilityGuard;
}

/** Resolver configuration */
export interface ResolverConfig {
  /** Appearance mode */
  appearance: AppearanceMode;
  /** Background color (CSS color string) */
  backgroundColor?: string;
  /** Material thickness (affects blur, opacity) */
  thickness: "ultrathin" | "thin" | "medium" | "thick";
}

/** Cached region material entry */
export interface CachedMaterialEntry {
  colorField: SurfaceColorField;
  materials: Map<string, GlassMaterial>; // keyed by "appearance-thickness"
  timestamp: number;
}
