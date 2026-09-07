/**
 * Manage Colors
 *
 * Shared color constants for work items, projects, and related features.
 * Uses CSS variables for theme consistency.
 */

// ============================================
// Status Colors
// ============================================

export const STATUS_COLORS = {
  backlog: "var(--color-neutral-6)",
  planned: "var(--color-neutral-6)",
  in_progress: "var(--color-primary-6)",
  in_review: "var(--color-warning-6)",
  blocked: "var(--color-danger-6)",
  completed: "var(--color-success-6)",
  cancelled: "var(--color-danger-6)",
  duplicate: "var(--color-text-3)",
  canceled: "var(--color-danger-6)",
} as const;

export const STATUS_BG_COLORS = {
  backlog: "color-mix(in srgb, var(--color-neutral-6) 10%, transparent)",
  planned: "color-mix(in srgb, var(--color-primary-6) 10%, transparent)",
  in_progress: "color-mix(in srgb, var(--color-warning-6) 10%, transparent)",
  in_review: "color-mix(in srgb, var(--color-warning-6) 10%, transparent)",
  blocked: "color-mix(in srgb, var(--color-danger-6) 10%, transparent)",
  completed: "color-mix(in srgb, var(--color-success-6) 10%, transparent)",
  cancelled: "color-mix(in srgb, var(--color-danger-6) 10%, transparent)",
  duplicate: "color-mix(in srgb, var(--color-neutral-6) 10%, transparent)",
  canceled: "color-mix(in srgb, var(--color-danger-6) 10%, transparent)",
} as const;

// ============================================
// Priority Colors
// ============================================

export const PRIORITY_COLORS = {
  none: "var(--color-neutral-6)",
  urgent: "var(--color-danger-6)",
  high: "var(--color-warning-6)",
  medium: "var(--color-primary-6)",
  low: "var(--color-neutral-6)",
} as const;

// ============================================
// Health Colors
// ============================================

export const HEALTH_COLORS = {
  on_track: "var(--color-success-6)",
  at_risk: "var(--color-warning-6)",
  off_track: "var(--color-danger-6)",
  no_updates: "var(--color-neutral-6)",
} as const;

// ============================================
// Entity Colors (Projects, Milestones, etc.)
// ============================================

export const ENTITY_COLORS = {
  blue: "var(--color-primary-6)",
  green: "var(--color-success-6)",
  purple: "#722ed1",
  orange: "var(--color-warning-6)",
  red: "var(--color-danger-6)",
  yellow: "#fadc19",
  gray: "var(--color-neutral-6)",
} as const;

// ============================================
// Label Colors
// ============================================

export const LABEL_COLORS = [
  { name: "red", value: "var(--color-danger-6)" },
  { name: "orange", value: "var(--color-warning-6)" },
  { name: "yellow", value: "#fadc19" },
  { name: "green", value: "var(--color-success-6)" },
  { name: "blue", value: "var(--color-primary-6)" },
  { name: "purple", value: "#722ed1" },
  { name: "gray", value: "var(--color-neutral-6)" },
] as const;

export const DEFAULT_LABELS = [
  { id: "bug", name: "Bug", color: "var(--color-danger-6)" },
  { id: "feature", name: "Feature", color: "var(--color-primary-6)" },
  { id: "improvement", name: "Improvement", color: "var(--color-success-6)" },
  { id: "documentation", name: "Documentation", color: "#722ed1" },
] as const;

// ============================================
// Milestone Colors
// ============================================

export const MILESTONE_COLORS = {
  active: "var(--color-primary-6)",
  upcoming: "var(--color-warning-6)",
  completed: "var(--color-success-6)",
  overdue: "var(--color-danger-6)",
} as const;
