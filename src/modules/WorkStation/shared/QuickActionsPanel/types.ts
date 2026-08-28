/**
 * QuickActionsPanel Types
 *
 * Shared types for the quick actions panel used across work station.
 */
import type { IconSvgElement } from "@src/icons";

/**
 * A single quick action item
 */
export interface QuickAction {
  /** Unique identifier for the action */
  id: string;
  /** Display label for the action */
  label: string;
  /** Keyboard shortcut (e.g., "⇧⌘L", "Cmd+J") */
  shortcut?: string;
  /** Optional icon to display */
  icon?: IconSvgElement;
  /** Handler when action is triggered */
  onAction?: () => void;
  /** Whether the action is disabled */
  disabled?: boolean;
}

/**
 * Props for the QuickActionsPanel component
 */
export interface QuickActionsPanelProps {
  /** Whether the panel is visible */
  visible: boolean;
  /** List of quick actions to display */
  actions: QuickAction[];
  /** Callback to close the panel */
  onClose: () => void;
  /** Optional title for the panel */
  title?: string;
  /** Optional subtitle/description */
  subtitle?: string;
  /** Whether to show the app logo */
  showLogo?: boolean;
}
