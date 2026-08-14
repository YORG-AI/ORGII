export const CHAT_PANEL_TAB_HEADER_HEIGHT_PX = 44;
export const CHAT_PANEL_PUBLISHED_HEADER_HEIGHT_PX = 40;
export const CHAT_PANEL_HEADER_STACK_HEIGHT_PX =
  CHAT_PANEL_TAB_HEADER_HEIGHT_PX + CHAT_PANEL_PUBLISHED_HEADER_HEIGHT_PX;
export const CHAT_PANEL_TRANSCRIPT_TOP_GAP_PX = 24;
export const CHAT_PANEL_TRANSCRIPT_TOP_PADDING_PX =
  CHAT_PANEL_HEADER_STACK_HEIGHT_PX + CHAT_PANEL_TRANSCRIPT_TOP_GAP_PX;

/** Dense glass shared by the chat header stack and its pinned subheaders. */
export const CHAT_PANEL_GLASS_SURFACE_CLASS =
  "bg-chat-pane/70 backdrop-blur-xl backdrop-saturate-150";

interface ChatPanelHeaderOverlayState {
  showSessionContent: boolean;
  standaloneToolTabActive: boolean;
  humanSessionActive: boolean;
}

/** Transcript top padding: the chrome share moves to the pinned-header host when it renders in flow. */
export function resolveTranscriptTopPaddingPx(
  chromeTopInset: number,
  pinnedHeaderLayerInFlow: boolean
): number {
  return chromeTopInset > 0 && pinnedHeaderLayerInFlow
    ? CHAT_PANEL_TRANSCRIPT_TOP_GAP_PX
    : CHAT_PANEL_TRANSCRIPT_TOP_PADDING_PX;
}

/** Session views share one floating glass-header contract in the chat pane. */
export function shouldOverlayChatSessionHeaders({
  showSessionContent,
  standaloneToolTabActive,
  humanSessionActive,
}: ChatPanelHeaderOverlayState): boolean {
  return showSessionContent && !standaloneToolTabActive && !humanSessionActive;
}
