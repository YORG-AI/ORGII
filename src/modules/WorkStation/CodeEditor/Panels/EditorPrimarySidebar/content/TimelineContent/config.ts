/**
 * TimelineSection Configuration
 */
import {
  FileDiffIcon,
  GitCommitIcon,
  PinIcon,
  Refresh04Icon,
} from "@src/icons";

// Icon configuration
export const TIMELINE_ICONS = {
  commit: GitCommitIcon,
  pin: PinIcon,
  refresh: Refresh04Icon,
  openDiff: FileDiffIcon,
} as const;

// Constants
export const TIMELINE_CONSTANTS = {
  MAX_COMMITS: 50,
  ICON_SIZE: 12,
  ACTION_ICON_SIZE: 14,
  ENTRY_HEIGHT: 56,
} as const;
