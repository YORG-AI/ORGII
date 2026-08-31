/**
 * Container height configuration
 * Unified management of height offset values for all components
 */

export interface HeightConfig {
  expanded: number; // Offset when expanded
  collapsed: number; // Offset when collapsed
  minHeight: number; // Minimum height
}

/**
 * Preset height configurations
 */
export const HEIGHT_PRESETS = {
  // Standard config - suitable for most components
  standard: {
    expanded: 438,
    collapsed: 288,
    minHeight: 200,
  },
  syncBottomNoShow: {
    expanded: 438,
    collapsed: 242,
    minHeight: 200,
  },

  // Compact config - suitable for components with less content
  compact: {
    expanded: 445,
    collapsed: 300,
    minHeight: 200,
  },

  // Spacious config - suitable for components with more content
  spacious: {
    expanded: 600,
    collapsed: 350,
    minHeight: 250,
  },

  // Small config - suitable for small components
  small: {
    expanded: 400,
    collapsed: 250,
    minHeight: 150,
  },
} as const;

/**
 * Component-specific configurations
 * Custom height configurations for specific components
 */
export const COMPONENT_HEIGHT_CONFIG = {
  // Terminal command component
  runCommand: HEIGHT_PRESETS.standard,

  // FileSearch component
  searchAct: HEIGHT_PRESETS.standard,

  // File read component
  readFile: HEIGHT_PRESETS.standard,

  // Code diff component
  codeDiff: HEIGHT_PRESETS.standard,

  // Default config for other components
  default: HEIGHT_PRESETS.standard,
} as const;

/**
 * Get height configuration for a component
 * @param componentName Component name
 * @returns Height configuration object
 */
export const getHeightConfig = (
  componentName: keyof typeof COMPONENT_HEIGHT_CONFIG = "default"
): HeightConfig => {
  return (
    COMPONENT_HEIGHT_CONFIG[componentName] || COMPONENT_HEIGHT_CONFIG.default
  );
};
