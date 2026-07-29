import { createContext } from "react";

/**
 * DOM host beneath the responsive workstation trail. Conversation navigation
 * portals here so it shares the rail column instead of occupying chat width.
 */
export const FocusedChatWorkstationMinimapPortalContext =
  createContext<HTMLDivElement | null>(null);
