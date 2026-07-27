/**
 * Navigation Types
 *
 * Types for router location state shared across navigation callers.
 */

export interface NavigationState {
  source?: "sidebar" | "app-grid" | "shortcut" | "other";
}

export interface LocationState extends NavigationState {
  [key: string]: unknown;
}
