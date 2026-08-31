export const CHAT_PANEL_TAB_HEADER_HEIGHT_PX = 44;
export const CHAT_PANEL_PUBLISHED_HEADER_HEIGHT_PX = 36;
/**
 * Gap above whichever header row sits at the pane's top edge — the tab row's
 * `pt-2`. It keeps the row clear of the window edge and lines the row's
 * content band up with the host window controls beside it, so the row that
 * inherits the top edge has to inherit the gap too.
 */
export const CHAT_PANEL_HEADER_TOP_PADDING_PX = 8;
/** Collapsed chrome: the published row plus the top gap it inherited. */
export const CHAT_PANEL_COLLAPSED_HEADER_HEIGHT_PX =
  CHAT_PANEL_PUBLISHED_HEADER_HEIGHT_PX + CHAT_PANEL_HEADER_TOP_PADDING_PX;
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
  if (chromeTopInset > 0 && pinnedHeaderLayerInFlow) {
    return CHAT_PANEL_TRANSCRIPT_TOP_GAP_PX;
  }
  // A collapsed header stack floats less chrome, so the transcript reserves
  // the inset it was actually given rather than the full two-row height.
  const floatingChromePx =
    chromeTopInset > 0 ? chromeTopInset : CHAT_PANEL_HEADER_STACK_HEIGHT_PX;
  return floatingChromePx + CHAT_PANEL_TRANSCRIPT_TOP_GAP_PX;
}

interface ChatPanelTabRowCollapseState {
  tabCount: number;
}

/**
 * Whether the 44px tab row folds into the 40px published header.
 *
 * A pane holding a single tab has nothing to switch between, maximized or not: the
 * lone pill only repeats the surface title published one row below it, so the
 * row costs 44px of chrome and buys nothing. Collapsing moves its controls
 * (new tab / maximize or restore) onto the published row, which is why that
 * row is force-rendered while collapsed even for surfaces that publish no
 * slots of their own.
 */
export function shouldCollapseChatPanelTabRow({
  tabCount,
}: ChatPanelTabRowCollapseState): boolean {
  return tabCount === 1;
}

/**
 * Controls the folded header must never drag the window out from under.
 */
const HEADER_INTERACTIVE_SELECTOR =
  'button,a,input,select,textarea,[role="button"],[role="menuitem"],[role="tab"],[contenteditable="true"]';

/**
 * Whether a mousedown on the folded header should start a window drag.
 *
 * Tauri matches `data-tauri-drag-region` on the event target alone and never
 * walks ancestors, so only the exact element under the cursor counts. In this
 * row that element is never the one carrying the attribute: the content slot
 * stretches over the whole row, and the session breadcrumb inside it is a
 * `container-type: inline-size` element, which cannot be shrunk to its content
 * to free the space up — containment makes it contribute zero width, so it
 * collapses and takes the title with it. The folded row therefore drives the
 * drag itself and steps aside only for things the user can actually click.
 */
export function shouldStartHeaderDragFromTarget(
  target: Element | null
): boolean {
  return Boolean(target) && !target?.closest(HEADER_INTERACTIVE_SELECTOR);
}

/** Floating-chrome height the transcript scrolls beneath. */
export function resolveChatPanelChromeTopInsetPx(
  overlayHeaders: boolean,
  tabRowCollapsed: boolean
): number {
  if (!overlayHeaders) return 0;
  return tabRowCollapsed
    ? CHAT_PANEL_COLLAPSED_HEADER_HEIGHT_PX
    : CHAT_PANEL_HEADER_STACK_HEIGHT_PX;
}

/** Session views share one floating glass-header contract in the chat pane. */
export function shouldOverlayChatSessionHeaders({
  showSessionContent,
  standaloneToolTabActive,
  humanSessionActive,
}: ChatPanelHeaderOverlayState): boolean {
  return showSessionContent && !standaloneToolTabActive && !humanSessionActive;
}
