/**
 * "Drop a session into this channel" — the channel-surface half of the drag
 * protocol the Team Inbox and the chat composer already speak.
 *
 * The whole panel (transcript + composer footer) is one drop target, and a
 * dropped session becomes a REAL pill in the composer via
 * `ComposerInputRef.insertFilePill` — the same call `useAtMention` makes for
 * an `@`-picked session — so the post carries `[session:<id>]` and renders as
 * a clickable pill instead of pasted text.
 *
 * One overlap has to be resolved: `InputArea` already owns a drop target of
 * its own (`useTabDragEndToPill`) covering the composer's `[data-chat-drop-
 * target]` rect, and it handles the reference-pill protocol — but NOT the
 * native session-tab protocol. So a `reference` drop that landed inside the
 * composer was already turned into a pill and must be declined here, or the
 * user gets the pill twice.
 *
 * WORK ITEMS are deliberately NOT handled here. `InputArea`'s own drop path
 * already covers them end to end — `insertPillFromTabPayload` has a
 * `workitem` branch that mints the `workitem://<slug>/<shortId>/<ts>` pill
 * `channelMessageBody` reads back as a card — so a work item dropped on the
 * composer composes and renders today with no code in this file. Extending
 * the panel-wide target to work items would mean widening
 * `getSessionReferenceFromDragDetail` and `useSessionDropTarget` from
 * `SessionReferenceOpen` to a reference union, and that hook is shared with
 * `TeamInboxSessionDropSurface`; the cost lands on a surface that asked for
 * none of it. The remaining gap is narrow and cosmetic: a work item released
 * over the TRANSCRIPT rather than the composer is ignored, where a session
 * would have been caught. Widen the shared hook when a second surface needs
 * the same thing, not for this one.
 */
import { type RefObject, useCallback } from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import { resolveDropTarget } from "@src/shared/dnd/dropTargetUtils";
import type { SessionReferenceOpen } from "@src/shared/dnd/sessionTabDrag";
import {
  type SessionDropContext,
  useSessionDropTarget,
} from "@src/shared/dnd/useSessionDropTarget";

/**
 * True when `InputArea`'s own drop target already inserted this pill, which
 * is exactly the reference-protocol drop released inside the composer rect.
 */
function isComposerHandledDrop(
  context: SessionDropContext,
  composerRect: DOMRect | null
): boolean {
  if (context.source !== "reference" || !composerRect) return false;
  return (
    context.clientX >= composerRect.left &&
    context.clientX <= composerRect.right &&
    context.clientY >= composerRect.top &&
    context.clientY <= composerRect.bottom
  );
}

/** Pill path shape shared with `useAtMention`'s session branch. */
export function sessionPillPath(sessionId: string, now: number): string {
  return `session://${sessionId}/${now}`;
}

interface UseChannelSessionDropOptions {
  /** The panel region that accepts the drop (transcript + composer). */
  surfaceRef: RefObject<HTMLElement | null>;
  /** The composer footer, searched for `InputArea`'s own drop rect. */
  composerFooterRef: RefObject<HTMLElement | null>;
  composerInputRef: RefObject<ComposerInputRef | null>;
  /** True with no writable message plane: nothing to post, nothing to accept. */
  disabled?: boolean;
}

export interface ChannelSessionDropState {
  active: boolean;
  over: boolean;
}

export function useChannelSessionDrop({
  surfaceRef,
  composerFooterRef,
  composerInputRef,
  disabled = false,
}: UseChannelSessionDropOptions): ChannelSessionDropState {
  const handleDrop = useCallback(
    (reference: SessionReferenceOpen, context: SessionDropContext) => {
      const composerDropTarget = resolveDropTarget(composerFooterRef);
      if (
        isComposerHandledDrop(
          context,
          composerDropTarget?.getBoundingClientRect() ?? null
        )
      ) {
        return;
      }
      composerInputRef.current?.insertFilePill(
        sessionPillPath(reference.sessionId, Date.now()),
        false,
        "session",
        reference.title
      );
    },
    [composerFooterRef, composerInputRef]
  );

  return useSessionDropTarget({
    containerRef: surfaceRef,
    disabled,
    onDrop: handleDrop,
  });
}
