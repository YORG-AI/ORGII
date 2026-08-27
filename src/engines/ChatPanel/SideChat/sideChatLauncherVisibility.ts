/**
 * Which pane surfaces get the floating side-chat launcher.
 *
 * The launcher only earns its corner on surfaces that carry no chat of their
 * own — work items, work management, projects, runtime, GitHub views,
 * terminals. The launchpad already *is* a composer for starting a session,
 * and a session tab already shows that session's transcript and composer, so
 * a floating "chat here" button on either is pure duplication over a surface
 * that already owns the same affordance.
 *
 * This gates the button only. An already-open side chat keeps floating across
 * tab switches — it is a picture-in-picture window the user placed, not a
 * property of the surface underneath it.
 */
import type { ChatPanelTabType } from "@src/store/chatPanel/chatPanelTabsAtom";

const LAUNCHER_HIDDEN_TAB_TYPES: ReadonlySet<ChatPanelTabType> = new Set([
  "start-page",
  "session",
]);

/**
 * `null` (no active tab) reads as hidden: the pane re-seeds a launchpad tab
 * whenever the last one closes, so an empty pane is a launchpad in waiting.
 */
export function shouldShowSideChatLauncher(
  tabType: ChatPanelTabType | null | undefined
): boolean {
  return tabType != null && !LAUNCHER_HIDDEN_TAB_TYPES.has(tabType);
}
