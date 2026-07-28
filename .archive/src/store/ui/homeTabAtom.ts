/**
 * Home Tab State Atom
 *
 * Manages the active tab state for the Home sidebar
 * Synchronizes between HomeSidebar and SuggestionsPage components
 */
import { atom } from "jotai";

export type HomeTabType = "build" | "workstation";

/**
 * Atom for tracking the active home tab
 * Default: "build" (displayed as Home; "workstation" is displayed as Workstation)
 */
export const homeTabAtom = atom<HomeTabType>("build");
homeTabAtom.debugLabel = "homeTabAtom";
