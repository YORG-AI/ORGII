import { PRIMARY_SIDEBAR_SURFACE_BG_CLASS } from "@src/config/workstation/tokens";

export interface PrimarySidebarSurfaceTokens {
  /** Root panel background (PrimarySidebarLayout shell). */
  surfaceBgClass: string;
  /** VirtualizedStickyTree sticky header rows + container. */
  stickyBgClass: string;
}

export function usePrimarySidebarSurface(): PrimarySidebarSurfaceTokens {
  return {
    surfaceBgClass: PRIMARY_SIDEBAR_SURFACE_BG_CLASS,
    stickyBgClass: PRIMARY_SIDEBAR_SURFACE_BG_CLASS,
  };
}
