/**
 * Integrations Shared Tokens
 *
 * Reusable style tokens for the status bar and quick-actions sections
 * across Channels and Code Accounts panels.
 */
import { ChevronsLeftRightEllipsisIcon } from "@src/icons";

/** Icon used for the integration status indicator */
export const STATUS_ICON = ChevronsLeftRightEllipsisIcon;

/** Size matching ActionCard icon tokens */
export const STATUS_ICON_SIZE = 16;

/** Shared classes for the status bar row inside QuickActionsSection */
export const STATUS_BAR_TOKENS = {
  /** Outer container */
  container: "flex items-center justify-between rounded-lg bg-fill-2 p-3",
  /** Inner label wrapper */
  label: "flex items-center gap-3 text-[13px] text-text-1",
  /** "Status:" text */
  labelText: "font-medium",
  /** Icon / value colour when enabled */
  enabledClass: "text-success-6",
  /** Icon / value colour when disabled */
  disabledClass: "text-text-3",
} as const;
