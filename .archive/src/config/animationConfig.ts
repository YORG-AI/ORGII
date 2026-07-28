/**
 * Animation Configuration
 *
 * Centralized configuration for simulation animations
 * including typewriter effects and auto-scroll effects.
 */

// ============================================
// Types
// ============================================

export interface TypewriterConfig {
  /** Characters revealed per frame (higher = faster) */
  charsPerFrame: number;
  /** Milliseconds between frames */
  frameInterval: number;
  /** Initial delay before animation starts (ms) */
  initialDelay: number;
  /** Whether to animate line by line instead of character by character */
  lineByLine: boolean;
  /** Lines revealed per frame when lineByLine is true */
  linesPerFrame: number;
}

export interface AutoScrollConfig {
  /** Pixels scrolled per frame */
  pixelsPerFrame: number;
  /** Milliseconds between frames */
  frameInterval: number;
  /** Initial delay before scrolling starts (ms) */
  initialDelay: number;
  /** Whether to pause at the end before looping */
  pauseAtEnd: boolean;
  /** Pause duration at end (ms) */
  pauseDuration: number;
  /** Smooth scroll easing - linear or easeOut */
  easing: "linear" | "easeOut";
}

export interface AnimationPreset {
  name: string;
  typewriter: TypewriterConfig;
  autoScroll: AutoScrollConfig;
}

// ============================================
// Default Configurations
// ============================================

/** Default typewriter configuration - moderate speed */
export const DEFAULT_TYPEWRITER_CONFIG: TypewriterConfig = {
  charsPerFrame: 3,
  frameInterval: 16, // ~60fps
  initialDelay: 200,
  lineByLine: true,
  linesPerFrame: 1,
};

/** Default auto-scroll configuration - smooth reading pace */
export const DEFAULT_AUTO_SCROLL_CONFIG: AutoScrollConfig = {
  pixelsPerFrame: 1,
  frameInterval: 16, // ~60fps
  initialDelay: 500,
  pauseAtEnd: true,
  pauseDuration: 2000,
  easing: "linear",
};

// ============================================
// Speed Presets
// ============================================

/** Speed multiplier presets */
export const SPEED_PRESETS = {
  slow: 0.5,
  normal: 1,
  fast: 2,
  veryFast: 4,
} as const;

export type SpeedPreset = keyof typeof SPEED_PRESETS;

// ============================================
// Animation Presets
// ============================================

export const ANIMATION_PRESETS: Record<string, AnimationPreset> = {
  /** Demo mode - slow and deliberate for presentations */
  demo: {
    name: "Demo",
    typewriter: {
      charsPerFrame: 2,
      frameInterval: 32,
      initialDelay: 500,
      lineByLine: true,
      linesPerFrame: 1,
    },
    autoScroll: {
      pixelsPerFrame: 0.5,
      frameInterval: 16,
      initialDelay: 800,
      pauseAtEnd: true,
      pauseDuration: 3000,
      easing: "easeOut",
    },
  },
  /** Normal mode - balanced for regular use */
  normal: {
    name: "Normal",
    typewriter: DEFAULT_TYPEWRITER_CONFIG,
    autoScroll: DEFAULT_AUTO_SCROLL_CONFIG,
  },
  /** Fast mode - quick playback */
  fast: {
    name: "Fast",
    typewriter: {
      charsPerFrame: 6,
      frameInterval: 16,
      initialDelay: 100,
      lineByLine: true,
      linesPerFrame: 2,
    },
    autoScroll: {
      pixelsPerFrame: 2,
      frameInterval: 16,
      initialDelay: 200,
      pauseAtEnd: true,
      pauseDuration: 1000,
      easing: "linear",
    },
  },
  /** Instant mode - no animation, immediate display */
  instant: {
    name: "Instant",
    typewriter: {
      charsPerFrame: Infinity,
      frameInterval: 0,
      initialDelay: 0,
      lineByLine: true,
      linesPerFrame: Infinity,
    },
    autoScroll: {
      pixelsPerFrame: Infinity,
      frameInterval: 0,
      initialDelay: 0,
      pauseAtEnd: false,
      pauseDuration: 0,
      easing: "linear",
    },
  },
};

// ============================================
// Utility Functions
// ============================================

/**
 * Apply speed multiplier to typewriter config
 */
export const applyTypewriterSpeed = (
  config: TypewriterConfig,
  speed: number
): TypewriterConfig => ({
  ...config,
  charsPerFrame: Math.max(1, Math.round(config.charsPerFrame * speed)),
  linesPerFrame: Math.max(1, Math.round(config.linesPerFrame * speed)),
  initialDelay: Math.round(config.initialDelay / speed),
});

/**
 * Apply speed multiplier to auto-scroll config
 */
export const applyAutoScrollSpeed = (
  config: AutoScrollConfig,
  speed: number
): AutoScrollConfig => ({
  ...config,
  pixelsPerFrame: config.pixelsPerFrame * speed,
  initialDelay: Math.round(config.initialDelay / speed),
  pauseDuration: Math.round(config.pauseDuration / speed),
});

/**
 * Get animation config by preset name
 */
export const getAnimationPreset = (
  presetName: string
): AnimationPreset | undefined => {
  return ANIMATION_PRESETS[presetName];
};

/**
 * Create custom typewriter config from base with overrides
 */
export const createTypewriterConfig = (
  overrides?: Partial<TypewriterConfig>
): TypewriterConfig => ({
  ...DEFAULT_TYPEWRITER_CONFIG,
  ...overrides,
});

/**
 * Create custom auto-scroll config from base with overrides
 */
export const createAutoScrollConfig = (
  overrides?: Partial<AutoScrollConfig>
): AutoScrollConfig => ({
  ...DEFAULT_AUTO_SCROLL_CONFIG,
  ...overrides,
});
