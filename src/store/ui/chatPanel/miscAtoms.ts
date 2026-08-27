/**
 * Replay slider state, and the chat dropdown / read-only flags.
 */
import { atom } from "jotai";

/**
 * Replay display value while dragging
 * High frequency updates, does not trigger Context re-render
 */
export const replayDisplayValueAtom = atom<number>(200);
replayDisplayValueAtom.debugLabel = "replayDisplayValueAtom";

/**
 * Whether Replay is currently being dragged
 */
export const replayIsDraggingAtom = atom<boolean>(false);
replayIsDraggingAtom.debugLabel = "replayIsDraggingAtom";

/** Whether the chat-related dropdown UI is open */
export const chatDropDownShowAtom = atom<boolean>(false);
chatDropDownShowAtom.debugLabel = "chatDropDownShowAtom";

/** Whether the chat panel / workspace is in read-only mode */
export const wpReadOnlyAtom = atom<boolean>(true);
wpReadOnlyAtom.debugLabel = "wpReadOnlyAtom";
