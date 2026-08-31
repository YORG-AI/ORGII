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

import { AppType } from "./appTypes";

/**
 * Unique identifier for a window instance
 */
export type WindowId = string;

/**
 * Window state within the simulator
 */
export interface SimulatorWindow {
  /** Unique window identifier */
  id: WindowId;
  /** The app type being displayed */
  appType: AppType;
  /** Optional content data for the app */
  content?: unknown;
  /** Whether this window is currently focused */
  isFocused: boolean;
  /** Window title override (optional) */
  title?: string;
}

/**
 * Layout mode for the simulator
 */
export type LayoutMode = "single";

/**
 * Simulator window manager state
 */
export interface WindowManagerState {
  /** Current layout mode */
  layoutMode: LayoutMode;
  /** All active windows */
  windows: SimulatorWindow[];
  /** ID of the currently focused window */
  focusedWindowId: WindowId | null;
}

export type WindowAction =
  | { type: "SWITCH_APP"; appType: AppType; content?: unknown }
  | { type: "CLOSE_WINDOW"; windowId: WindowId }
  | { type: "FOCUS_WINDOW"; windowId: WindowId }
  | { type: "SET_LAYOUT"; layoutMode: LayoutMode };

export interface DockContextMenuOption {
  id: string;
  label: string;
  icon: string;
  action: "switch";
  disabled?: boolean;
}

export const WINDOW_ICONS: Record<string, IconSvgElement> = {
  switchTo: ArrowLeftRightIcon,
  close: Cancel01Icon,
  maximize: ArrowExpand01Icon,
  minimize: MinusSignIcon,
} as const;
