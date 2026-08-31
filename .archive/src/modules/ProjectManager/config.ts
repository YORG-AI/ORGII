/**
 * Configuration for Project Manager Human Tool
 *
 * Re-exports from centralized config for convenience.
 */
export {
  STORY_STATUS_OPTIONS as STATUS_OPTIONS,
  STORY_PRIORITY_OPTIONS as PRIORITY_OPTIONS,
  HEALTH_OPTIONS,
  getProjectStatusConfig as getStatusConfig,
  getProjectPriorityConfig as getPriorityConfig,
  getHealthConfig,
} from "@src/modules/ProjectManager/config/manage";

export type {
  ProjectStatusOption as StatusOption,
  ProjectPriorityOption as PriorityOption,
  HealthOption,
} from "@src/modules/ProjectManager/config/manage";
