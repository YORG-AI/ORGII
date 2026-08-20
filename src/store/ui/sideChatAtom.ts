/**
 * Chat pane floating side chat.
 *
 * A picture-in-picture chat window floating over the chat pane, so a second
 * session can be watched and driven without leaving the active tab. While
 * visible, `sessionId === null` means the window is in new-session mode and
 * shows the session creator; a successful launch flips it to the session.
 */
import { atom } from "jotai";

export const sideChatVisibleAtom = atom<boolean>(false);
sideChatVisibleAtom.debugLabel = "chatPanel/sideChat/visible";

export const sideChatSessionIdAtom = atom<string | null>(null);
sideChatSessionIdAtom.debugLabel = "chatPanel/sideChat/sessionId";

/**
 * Open the side chat on a session, or on the creator (`null`) to start a new
 * session in it.
 */
export const openSideChatAtom = atom(
  null,
  (_get, set, sessionId: string | null) => {
    set(sideChatSessionIdAtom, sessionId);
    set(sideChatVisibleAtom, true);
  }
);
openSideChatAtom.debugLabel = "chatPanel/sideChat/open";

export const closeSideChatAtom = atom(null, (_get, set) => {
  set(sideChatVisibleAtom, false);
  set(sideChatSessionIdAtom, null);
});
closeSideChatAtom.debugLabel = "chatPanel/sideChat/close";
