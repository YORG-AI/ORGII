export const SESSION_TAB_DRAG_START_EVENT = "session-tab-drag-start";
export const SESSION_TAB_DRAG_END_EVENT = "session-tab-drag-end";
export const SESSION_TAB_DRAG_CANCEL_EVENT = "session-tab-drag-cancel";

export const SESSION_TAB_DROP_TARGET_HIGHLIGHT_CLASS =
  "pointer-events-none absolute z-50 rounded-md border border-primary-6 bg-primary-6/10";

export type SessionTabPlacement = "chat-panel" | "workstation";

export interface SessionTabTransfer {
  source: SessionTabPlacement;
  sourceTabId: string;
  sessionId: string;
  title: string;
}

export interface SessionReferenceOpen {
  sessionId: string;
  title: string;
}

interface ReferenceDragDetail {
  name?: string;
  pill?: {
    path: string;
    name?: string;
    iconType: string;
  };
}

export interface SessionTabDragStartDetail {
  transfer: SessionTabTransfer;
}

export interface SessionTabDragEndDetail extends SessionTabDragStartDetail {
  clientX: number;
  clientY: number;
}

export function isPointInsideElement(
  element: HTMLElement | null,
  clientX: number,
  clientY: number
): boolean {
  if (!element) return false;
  const bounds = element.getBoundingClientRect();
  return (
    clientX >= bounds.left &&
    clientX <= bounds.right &&
    clientY >= bounds.top &&
    clientY <= bounds.bottom
  );
}

export function getSessionReferenceFromDragDetail(
  detail: ReferenceDragDetail
): SessionReferenceOpen | null {
  const pill = detail.pill;
  if (pill?.iconType !== "session" || !pill.path.startsWith("session://")) {
    return null;
  }
  const sessionId = pill.path.slice("session://".length).trim();
  if (!sessionId) return null;
  return {
    sessionId,
    title: pill.name?.trim() || detail.name?.trim() || "Chat",
  };
}

export function dispatchSessionTabDragStart(
  transfer: SessionTabTransfer
): void {
  document.dispatchEvent(
    new CustomEvent<SessionTabDragStartDetail>(SESSION_TAB_DRAG_START_EVENT, {
      detail: { transfer },
    })
  );
}

/**
 * Returns true when another tab strip accepted the transfer. Drop targets
 * signal acceptance by cancelling the event, which lets the source skip its
 * normal in-strip reorder after the tab has moved to the other owner.
 */
export function dispatchSessionTabDragEnd(
  transfer: SessionTabTransfer,
  clientX: number,
  clientY: number
): boolean {
  const accepted = !document.dispatchEvent(
    new CustomEvent<SessionTabDragEndDetail>(SESSION_TAB_DRAG_END_EVENT, {
      cancelable: true,
      detail: { transfer, clientX, clientY },
    })
  );
  return accepted;
}

export function dispatchSessionTabDragCancel(): void {
  document.dispatchEvent(new Event(SESSION_TAB_DRAG_CANCEL_EVENT));
}
