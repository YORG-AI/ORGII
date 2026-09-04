import { createContext } from "react";

/**
 * Slot subscription for one of the shell's footer hosts.
 *
 * The shell implements a tiny store with `subscribe` and `getSnapshot`
 * methods (the useSyncExternalStore shape). Palette-level
 * `ShellFooterAction` components subscribe to read the current host
 * element and react to mount/unmount with zero effect ping-pong.
 *
 * `null` context means there is no enclosing SpotlightShell (e.g.
 * pure-input palettes) — actions silently render nothing.
 */
interface FooterActionSlot {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => HTMLDivElement | null;
}

/**
 * Where a palette's footer content lands:
 * - `pill` — its own floating pill beside the keyboard hints.
 * - `inline` — inside the keyboard-hint pill, after the last hint.
 */
export interface FooterActionSlots {
  pill: FooterActionSlot;
  inline: FooterActionSlot;
}

export type FooterActionPlacement = keyof FooterActionSlots;

export const SpotlightFooterActionContext =
  createContext<FooterActionSlots | null>(null);
