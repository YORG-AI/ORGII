/**
 * Shared types for the Dropdown options-based API.
 * Used by both Dropdown (options mode) and Select (which wraps Dropdown).
 */
import type { ReactNode } from "react";

export interface DropdownOption {
  label: ReactNode;
  value: string | number;
  /** Optional leading visual, rendered in the option and single-value Select trigger. */
  icon?: ReactNode;
  disabled?: boolean;
  extra?: unknown;
  /** Label shown in the Select trigger when selected (falls back to label) */
  triggerLabel?: ReactNode;
  /** Stable selector for rendered UI tests. */
  dataTestId?: string;
}

export interface DropdownOptionGroup {
  label: string;
  options: DropdownOption[];
}

export type DropdownSelectValue = string | number | (string | number)[];

export type DropdownPosition =
  | "top"
  | "top-start"
  | "top-end"
  | "bottom"
  | "bottom-start"
  | "bottom-end"
  | "left"
  | "left-start"
  | "left-end"
  | "right"
  | "right-start"
  | "right-end"
  | "tl"
  | "tr"
  | "bl"
  | "br";
