/**
 * Manage Config - Barrel Export
 *
 * Centralized configuration for work items, projects, and related features.
 */

// Colors
export {
  STATUS_COLORS,
  STATUS_BG_COLORS,
  PRIORITY_COLORS,
  HEALTH_COLORS,
  ENTITY_COLORS,
  LABEL_COLORS,
  DEFAULT_LABELS,
  MILESTONE_COLORS,
} from "./colors";

// Status options
export {
  GITHUB_ISSUE_STATUS_OPTIONS,
  WORK_ITEM_STATUS_OPTIONS,
  STORY_STATUS_OPTIONS,
  getWorkItemStatusConfig,
  getProjectStatusConfig,
} from "./statusOptions";

// Priority options
export {
  WORK_ITEM_PRIORITY_OPTIONS,
  getWorkItemPriorityConfig,
  getProjectPriorityConfig,
} from "./priorityOptions";

// Health options
export { HEALTH_OPTIONS, getHealthConfig } from "./healthOptions";
