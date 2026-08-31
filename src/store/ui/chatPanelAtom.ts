/**
 * Chat panel UI atoms — re-exported from `chatPanel/` so every existing
 * `@src/store/ui/chatPanelAtom` import keeps resolving.
 *
 * Source files (evaluated in this order; `widthAtoms` must stay first because
 * it seeds the chat-width CSS variable at import time):
 *   chatPanel/widthAtoms.ts        — width, dragging, visibility-derived
 *   chatPanel/visibilityAtoms.ts   — per-Station chat visibility
 *   chatPanel/displayPrefsAtoms.ts — history display + model picker prefs
 *   chatPanel/selectionAtoms.ts    — create target and selected entities
 *   chatPanel/surfaceAtoms.ts      — surface projection, navigate, maximized
 *   chatPanel/miscAtoms.ts         — replay slider, dropdown, read-only
 */
export {
  CHAT_PANEL_SURFACE_KIND,
  type ChatPanelSurfaceKind,
} from "@src/types/ui/chatPanel";

export * from "./chatPanel/widthAtoms";
export * from "./chatPanel/visibilityAtoms";
export * from "./chatPanel/displayPrefsAtoms";
export * from "./chatPanel/selectionAtoms";
export * from "./chatPanel/surfaceAtoms";
export * from "./chatPanel/miscAtoms";
