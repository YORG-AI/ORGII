/**
 * Simulator Frame Configuration
 *
 * Shared configuration and constants for all simulator frame variants
 */

// ============================================
// Radius Options
// ============================================

/**
 * Frame radius options
 * - 12: Default simulator radius (rounded-xl)
 * - 20: WorkStation page radius (`rounded-page`)
 */
export type FrameRadius = 0 | 12 | 20;

/**
 * Radius class mapping
 */
const RADIUS_CLASSES: Record<FrameRadius, string> = {
  0: "rounded-none",
  12: "rounded-xl",
  20: "rounded-page",
};

// ============================================
// Frame Container Classes
// ============================================

/**
 * Get standard container classes for simulator frames
 * @param radius - Border radius option (12 or 20)
 * @returns className string
 */
export const getSimulatorFrameContainerClasses = (radius: FrameRadius = 12) =>
  `group relative flex h-full w-full min-w-0 flex-col overflow-hidden ${RADIUS_CLASSES[radius]} bg-bg-2`;

// ============================================
// Content Classes
// ============================================

/**
 * Get standard content area classes for simulator frames
 * @returns className string
 */
export const getSimulatorFrameContentClasses = () =>
  "min-h-0 min-w-0 flex-1 overflow-hidden";

// ============================================
// Padding Constants
// ============================================

/**
 * Standard padding for frame wrappers in tabs
 */
export const SIMULATOR_FRAME_TAB_PADDING = "p-2";
