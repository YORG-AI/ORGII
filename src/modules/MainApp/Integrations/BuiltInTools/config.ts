/**
 * Tools Configuration
 *
 * Category ordering and labels for the unified tools table.
 * Tool definitions now come from the Rust backend via `list_all_tools`.
 */

export const TOOL_CATEGORY_ORDER = [
  "coding",
  "web",
  "app_navigation",
  "data",
  "agent",
  "project",
  "custom",
  "general",
] as const;

export const ALL_CATEGORY_KEY = "__all__";

/** Static English labels for tool categories — not localized. */
export const TOOL_CATEGORY_LABELS: Record<string, string> = {
  coding: "Coding",
  web: "Web & GUI",
  app_navigation: "App Navigation",
  data: "Data & Memory",
  agent: "Agent",
  project: "Project",
  custom: "Custom",
  general: "General",
};

export function toolCategoryLabel(cat: string): string {
  return (
    TOOL_CATEGORY_LABELS[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1)
  );
}
