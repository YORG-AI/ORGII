/**
 * Window Types for Simulator Multi-Window Support
 *
 * Provides type definitions and configurations for managing multiple windows
 * within the simulator environment.
 */
import {
  ArrowExpand01Icon,
  ArrowLeftRightIcon,
  Cancel01Icon,
  type IconSvgElement,
  MinusSignIcon,
} from "@src/icons";

/**
 * Layout mode for the simulator
 */
export type LayoutMode = "single";

export const WINDOW_ICONS: Record<string, IconSvgElement> = {
  switchTo: ArrowLeftRightIcon,
  close: Cancel01Icon,
  maximize: ArrowExpand01Icon,
  minimize: MinusSignIcon,
} as const;
