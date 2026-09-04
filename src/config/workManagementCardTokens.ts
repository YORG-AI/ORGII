/**
 * Shared shell + frame classes for Kanban horizontal cards and overlays.
 */
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { INPUT_AREA } from "@src/config/inputAreaTokens";

export const WORK_MANAGEMENT_CARD_SHELL =
  `rounded-[10px] ${INPUT_AREA.borderClass} ` +
  "transition-[border-color,box-shadow] duration-150 ease-in-out " +
  "[&:not(:focus-visible):hover]:border-border-3 " +
  "focus-visible:border-primary-6 focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)] " +
  "focus-visible:outline-none";

export const WORK_MANAGEMENT_SESSION_CARD_CLASS = `${WORK_MANAGEMENT_CARD_SHELL} flex h-[96px] w-[240px] shrink-0 flex-col justify-between px-4 py-3 text-left`;

export const WORK_MANAGEMENT_GIT_SUGGESTION_CARD_CLASS = `${WORK_MANAGEMENT_CARD_SHELL} flex h-[96px] w-[240px] shrink-0 flex-col justify-between px-3 py-2.5 text-left`;

export const WORK_MANAGEMENT_AGENT_CARD_CLASS = `${WORK_MANAGEMENT_CARD_SHELL} flex h-[76px] w-[160px] shrink-0 flex-col justify-between px-3 py-2.5 text-left`;

export function workManagementAddCardClass(size: "session" | "agent"): string {
  const dimensions =
    size === "session" ? "h-[96px] w-[240px]" : "h-[76px] w-[160px]";
  return `${WORK_MANAGEMENT_CARD_SHELL} flex ${dimensions} shrink-0 items-center justify-center text-text-3`;
}

export const WORK_MANAGEMENT_NEW_SESSION_CARD_CLASS =
  workManagementAddCardClass("session");

export const WORK_MANAGEMENT_SESSION_CREATOR_MAX_WIDTH_CLASS =
  DETAIL_PANEL_TOKENS.contentMaxWidth;
export const WORK_MANAGEMENT_SESSION_CREATOR_MIN_HEIGHT_CLASS = "min-h-[180px]";

export const WORK_MANAGEMENT_SESSION_CREATOR_FLOW_CLASS = `mx-auto flex w-full ${WORK_MANAGEMENT_SESSION_CREATOR_MAX_WIDTH_CLASS} ${WORK_MANAGEMENT_SESSION_CREATOR_MIN_HEIGHT_CLASS} flex-col`;

export const WORK_MANAGEMENT_SESSION_CREATOR_OVERLAY_CLASS =
  "pointer-events-none absolute inset-x-0 bottom-0 top-0 z-50 flex items-end bg-linear-to-t from-bg-1/90 via-bg-1/55 to-transparent px-2 pb-2 pt-12";

export const WORK_MANAGEMENT_SESSION_CREATOR_SURFACE_CLASS = `mx-auto w-full ${WORK_MANAGEMENT_SESSION_CREATOR_MAX_WIDTH_CLASS} pointer-events-auto`;

// The padding is the floating window's hard edge margin: `FloatingWindow`
// clamps drag/resize to the overlay's content box, so the preview (incl. the
// team-session replay loader) can never touch or cross a board edge.
export const WORK_MANAGEMENT_SESSION_PREVIEW_OVERLAY_CLASS =
  "pointer-events-none absolute inset-0 z-60 flex items-end p-3";

export const WORK_MANAGEMENT_SESSION_PREVIEW_SURFACE_CLASS = `pointer-events-auto mx-auto flex h-full max-h-[600px] w-full ${WORK_MANAGEMENT_SESSION_CREATOR_MAX_WIDTH_CLASS} flex-col overflow-hidden rounded-[12px] border border-border-2 bg-bg-2 shadow-2xl`;
