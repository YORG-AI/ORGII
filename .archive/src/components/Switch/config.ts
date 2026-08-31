// ==========================================
// Switch Component Configuration
// ==========================================

/**
 * Switch size variants - style
 */
export const SWITCH_SIZES = {
  small: {
    width: 28,
    height: 16,
    knobSize: 12,
  },
  default: {
    width: 36,
    height: 20,
    knobSize: 16,
  },
  large: {
    width: 44,
    height: 24,
    knobSize: 20,
  },
} as const;

/**
 * Switch type color mappings
 */
export const SWITCH_COLORS = {
  primary: "var(--color-primary-6)",
  success: "var(--color-success-6)",
  warning: "var(--color-warning-6)",
  danger: "var(--color-danger-6)",
} as const;

/**
 * Switch animation timings - style
 */
export const SWITCH_ANIMATION = {
  duration: "0.2s",
  easing: "cubic-bezier(0.34, 0.69, 0.1, 1)",
} as const;
